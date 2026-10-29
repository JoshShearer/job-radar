import type { z } from "zod";
import type { AppContext } from "./context.js";
import type { Prompt } from "../domain/llm/prompts.js";
import { requestKey } from "../domain/llm/prompts.js";
import { toStructuredOutputSchema, validateStructured } from "../domain/llm/structured.js";
import { checkBudget, describeRefusal } from "../domain/budget/budget.js";
import { costUsd, readUsage, worstCaseUsd, type TokenUsage } from "../domain/budget/pricing.js";
import type { CallOutcome } from "../ports/records.js";
import { ModelCallError } from "../ports/io.js";

/**
 * The only path to a paid model. Every call:
 *
 *   1. is addressed by the exact bytes the model would be shown, and served
 *      from the derivation store when that address already has an answer;
 *   2. RESERVES its worst-case cost against the run, day and month budgets in
 *      the same transaction that checks them, and is refused if any would be
 *      crossed (so a ceiling is a ceiling, not a stop-after-the-fact);
 *   3. records a receipt for every outcome, including refusals, truncations,
 *      malformed output and API errors; unknown usage stays at the reserved
 *      worst case rather than becoming zero;
 *   4. validates the response against the same Zod schema its JSON Schema was
 *      generated from, before anything is stored.
 */

export interface ModelChoiceLike {
  model: string;
  effort: string;
  max_output_tokens: number;
}

export interface GatewayRequest<T> {
  /** Derivation kind, e.g. "assessment:triage". Part of the address. */
  kind: string;
  purpose: string;
  subjectId: string | null;
  runId: number | null;
  choice: ModelChoiceLike;
  prompt: Prompt;
  schema: z.ZodType<T>;
  /** Override the configured per-run ceiling for this run. */
  runCeilingUsd?: number;
  /**
   * Makes the address unique, so the same prompt is asked again on purpose
   * (`--force`). Without it, an identical request is always served from the store.
   */
  salt?: string;
}

export interface GatewayResult<T> {
  value: T;
  key: string;
  fromCache: boolean;
  callId: number | null;
  usage: TokenUsage | null;
  costUsd: number;
}

export class BudgetRefusal extends Error {
  override name = "BudgetRefusal";
}

export class ModelFailure extends Error {
  override name = "ModelFailure";
  constructor(message: string, readonly outcome: CallOutcome, readonly key: string) {
    super(message);
  }
  /** Failures that are about the posting, not the network, count against it. */
  get countsAgainstSubject(): boolean {
    return this.outcome !== "api_error";
  }
}

export class NoModelConfigured extends Error {
  override name = "NoModelConfigured";
}

export function addressOf(req: Pick<GatewayRequest<unknown>, "kind" | "choice" | "prompt" | "salt">): string {
  const base = requestKey(req.kind, req.choice.model, req.choice.effort, req.prompt);
  return req.salt ? requestKey(req.kind, base, req.salt, { system: "", user: "" }) : base;
}

/** A cached answer for this exact request, if one exists. Never calls anything. */
export function cached<T>(ctx: AppContext, req: Pick<GatewayRequest<T>, "kind" | "choice" | "prompt" | "schema" | "salt">): { key: string; value: T } | null {
  const key = addressOf(req);
  const hit = ctx.store.getDerivation(req.kind, key);
  if (!hit) return null;
  const v = validateStructured(req.schema, hit.output);
  return v.ok ? { key, value: v.value } : null;
}

export async function callModel<T>(ctx: AppContext, req: GatewayRequest<T>): Promise<GatewayResult<T>> {
  const at = () => ctx.clock.now().toISOString();
  const hit = cached(ctx, req);
  if (hit) {
    if (req.subjectId) ctx.store.useDerivation(req.kind, req.subjectId, hit.key, at());
    return { value: hit.value, key: hit.key, fromCache: true, callId: null, usage: null, costUsd: 0 };
  }
  const key = addressOf(req);

  const provider = ctx.modelProvider();
  const client = ctx.modelClient();
  if (!client) throw new NoModelConfigured(provider.reason ?? "No model provider is configured.");

  const ops = ctx.config().operations;
  // Bytes, not characters: non-Latin text runs near one token per character,
  // and the JSON schema is sent too. Bytes/3 over-counts Latin and still
  // bounds CJK. A settled cost above this is logged, never hidden.
  const jsonSchema = toStructuredOutputSchema(req.schema);
  const inputBytes = [req.prompt.system, req.prompt.user, JSON.stringify(jsonSchema)].reduce((n, x) => n + new TextEncoder().encode(x).length, 0);
  // The claude CLI may make several API calls for one request (it retries
  // internally) and adds its own context to each, so its worst case is
  // reserve_turns calls. The api provider's formula is the single-call one.
  const cli = ops.model.cli;
  const multi = provider.provider === "claude-cli" ? { turns: cli.reserve_turns, overheadInputTokens: cli.overhead_input_tokens } : {};
  const reserve = worstCaseUsd(inputBytes, req.choice.max_output_tokens, req.choice.model, multi);
  const now = ctx.clock.now();
  const windows = {
    dayStart: `${now.toISOString().slice(0, 10)}T00:00:00.000Z`,
    monthStart: `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`,
  };
  const reservation = ctx.store.reserveModelCall(
    {
      runId: req.runId,
      purpose: req.purpose,
      subjectId: req.subjectId,
      requestKey: key,
      model: req.choice.model,
      effort: req.choice.effort,
      reservedUsd: reserve,
      at: now.toISOString(),
      provider: provider.provider,
    },
    windows,
    (committed) => {
      const d = checkBudget(committed, reserve, ops.budgets, req.runCeilingUsd);
      return d.ok ? null : describeRefusal(d, reserve);
    },
  );
  if ("refused" in reservation) throw new BudgetRefusal(reservation.refused);
  const callId = reservation.id;

  // A provider that reports how many API calls one request took (the claude
  // CLI's num_turns) has it written into the receipt, so an overshoot can be
  // traced and reserve_turns re-tuned from the ledger.
  const turnsOf = (r: unknown): number | null => {
    const n = (r as { num_turns?: unknown } | null)?.num_turns;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  };
  const settle = (outcome: CallOutcome, usage: TokenUsage, known: boolean, error: string | null, turns: number | null = null) => {
    const actualUsd = known ? costUsd(usage, req.choice.model) : reserve;
    const over = actualUsd > reserve;
    if (over) {
      ctx.log(
        `WARNING: ${req.kind} cost $${actualUsd.toFixed(4)}, above its reserved worst case $${reserve.toFixed(4)}${turns !== null ? ` over ${turns} turns` : ""}. The reserve estimate needs raising.`,
      );
    }
    const note = turns !== null && (error !== null || over) ? ` [turns=${turns}${over ? ", above reserve" : ""}]` : "";
    const recorded = error !== null ? `${error}${note}` : note ? note.trim() : null;
    ctx.store.settleModelCall({ id: callId, outcome, usageKnown: known, usage, actualUsd, error: recorded, at: at() });
  };

  let response: unknown;
  try {
    response = await client.create({
      model: req.choice.model,
      effort: req.choice.effort,
      maxOutputTokens: req.choice.max_output_tokens,
      system: req.prompt.system,
      user: req.prompt.user,
      jsonSchema,
      maxBudgetUsd: reserve,
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (err instanceof ModelCallError) {
      // The provider failed but reported what it consumed: settle at that.
      const r = readUsage(err.response);
      settle("api_error", r.usage, r.known, message.slice(0, 500), turnsOf(err.response));
    } else {
      settle("api_error", { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, false, message.slice(0, 500));
    }
    throw new ModelFailure(`API error: ${message}`, "api_error", key);
  }

  const { usage, known } = readUsage(response);
  const turns = turnsOf(response);
  const fail = (outcome: CallOutcome, message: string): never => {
    settle(outcome, usage, known, message.slice(0, 500), turns);
    throw new ModelFailure(message, outcome, key);
  };

  const message = response as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (message.stop_reason === "refusal") fail("refusal", "The model declined this request.");
  if (message.stop_reason === "max_tokens") {
    fail("truncated", `Response hit max_output_tokens (${req.choice.max_output_tokens}) and was cut off. Raise it in operations.yaml.`);
  }
  const text = message.content?.find((b) => b.type === "text")?.text;
  if (!text) fail("invalid_json", "No text block in the response.");
  let raw: unknown;
  try {
    raw = JSON.parse(text as string);
  } catch {
    fail("invalid_json", `Response was not valid JSON: ${(text as string).slice(0, 200)}`);
  }
  const v = validateStructured(req.schema, raw);
  if (!v.ok) fail("schema", `Response failed schema validation: ${v.error}`);
  const value = (v as { ok: true; value: T }).value;

  settle("success", usage, known, null, turns);
  const created = at();
  ctx.store.putDerivation(req.kind, key, value, callId, created);
  if (req.subjectId) ctx.store.useDerivation(req.kind, req.subjectId, key, created);
  return { value, key, fromCache: false, callId, usage, costUsd: known ? costUsd(usage, req.choice.model) : reserve };
}
