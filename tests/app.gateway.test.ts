import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetRefusal, callModel, ModelFailure, NoModelConfigured } from "../src/app/gateway.js";
import { spendSummary } from "../src/app/spend.js";
import { FakeModel, makeEnv, testConfig, type ModelReply } from "./helpers/context.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeCliClient } from "../src/adapters/claude-cli/client.js";
import { toStructuredOutputSchema } from "../src/domain/llm/structured.js";
import { costUsd, worstCaseUsd } from "../src/domain/budget/pricing.js";

const schema = z.object({ answer: z.string(), score: z.number().int().min(0).max(100) }).strict();
const req = (env: ReturnType<typeof makeEnv>, over: Record<string, unknown> = {}) => ({
  kind: "test:kind",
  purpose: "test",
  subjectId: "opp-1",
  runId: env.store.startRun("test", env.clock.now().toISOString()),
  choice: { model: "claude-sonnet-5", effort: "medium", max_output_tokens: 2000 },
  prompt: { system: "You are a test.", user: "Say hi." },
  schema,
  ...over,
});

describe("model gateway", () => {
  it("serves an identical request from the store without calling the model", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 } }));
    const env = makeEnv({ model });
    const first = await callModel(env.ctx, req(env));
    const second = await callModel(env.ctx, req(env));
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(second.value).toEqual({ answer: "hi", score: 5 });
  });

  it("sends a JSON Schema generated from the same Zod schema it validates against", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 } }));
    const env = makeEnv({ model });
    await callModel(env.ctx, req(env));
    const js = model.calls[0]!.jsonSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(js.properties).sort()).toEqual(["answer", "score"]);
    expect(js.required.sort()).toEqual(["answer", "score"]);
    expect(js.additionalProperties).toBe(false);
    expect(JSON.stringify(js)).not.toMatch(/"maximum"|"minimum"|"\$schema"/);
  });

  it("refuses BEFORE calling when the worst case could cross the run ceiling", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 } }));
    const env = makeEnv({ model, config: testConfig((c) => (c.operations.budgets.per_run_usd = 0.01)) });
    await expect(callModel(env.ctx, req(env))).rejects.toBeInstanceOf(BudgetRefusal);
    expect(model.calls).toHaveLength(0);
    expect(env.store.modelCalls()).toHaveLength(0);
  });

  it("enforces the DAY ceiling across runs, not just within one", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 }, usage: { input_tokens: 100_000, output_tokens: 10_000 } }));
    const env = makeEnv({ model, config: testConfig((c) => (c.operations.budgets.per_day_usd = 0.47)) });
    // $0.45 settled on the first call; the second reserves its worst case
    // (~$0.03 at 2,000 output tokens), which would cross $0.47.
    await callModel(env.ctx, req(env, { prompt: { system: "a", user: "1" } }));
    await expect(callModel(env.ctx, req(env, { prompt: { system: "a", user: "2" } }))).rejects.toBeInstanceOf(BudgetRefusal);
    env.clock.advanceDays(1);
    await expect(callModel(env.ctx, req(env, { prompt: { system: "a", user: "3" } }))).resolves.toBeTruthy();
  });

  it.each<[string, ModelReply, string]>([
    ["refusal", { json: {}, stop_reason: "refusal" }, "refusal"],
    ["truncation", { json: {}, stop_reason: "max_tokens" }, "truncated"],
    ["invalid JSON", { raw: { stop_reason: "end_turn", content: [{ type: "text", text: "{not json" }], usage: { input_tokens: 10, output_tokens: 10 } } }, "invalid_json"],
    ["schema violation", { json: { answer: "hi", score: 500 } }, "schema"],
    ["API error", { throws: new Error("overloaded") }, "api_error"],
  ])("leaves a receipt for a billed %s and stores nothing", async (_n, reply, outcome) => {
    const env = makeEnv({ model: new FakeModel(() => reply) });
    await expect(callModel(env.ctx, req(env))).rejects.toBeInstanceOf(ModelFailure);
    const calls = env.store.modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("settled");
    expect(calls[0]!.outcome).toBe(outcome);
    expect(env.store.getDerivation("test:kind", calls[0]!.requestKey)).toBeNull();
  });

  it("an API error does not count against the subject; a schema failure does", async () => {
    const env = makeEnv({ model: new FakeModel(() => ({ throws: new Error("503") })) });
    const e1 = (await callModel(env.ctx, req(env)).catch((e) => e)) as ModelFailure;
    expect(e1.countsAgainstSubject).toBe(false);
    env.model = new FakeModel(() => ({ json: { nope: 1 } }));
    const e2 = (await callModel(env.ctx, req(env)).catch((e) => e)) as ModelFailure;
    expect(e2.countsAgainstSubject).toBe(true);
  });

  it("a call with no usage receipt counts at its reserved worst case, never zero", async () => {
    const env = makeEnv({ model: new FakeModel(() => ({ raw: { stop_reason: "end_turn", content: [{ type: "text", text: '{"answer":"x","score":1}' }] } })) });
    await callModel(env.ctx, req(env));
    const s = spendSummary(env.ctx);
    expect(s.day.unknownUsage).toBe(1);
    expect(s.day.committed).toBeGreaterThan(0.02);
  });

  it("the reserve bounds a non-Latin prompt that tokenizes at one token per character", async () => {
    // Found by the 2026-10-14 review: a 3-characters-per-token reserve under-counts CJK by ~3x.
    const cjk = "\u4e2d".repeat(30_000);
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 }, usage: { input_tokens: 30_000, output_tokens: 2_000 } }));
    const env = makeEnv({ model });
    await callModel(env.ctx, req(env, { prompt: { system: "You are a test.", user: cjk } }));
    const c = env.store.modelCalls()[0]!;
    expect(c.actualUsd!).toBeLessThanOrEqual(c.reservedUsd);
  });

  it("refuses cleanly with no API key", async () => {
    const env = makeEnv({ model: null });
    await expect(callModel(env.ctx, req(env))).rejects.toBeInstanceOf(NoModelConfigured);
  });

  it("salt asks the same question again on purpose", async () => {
    const model = new FakeModel((_r, n) => ({ json: { answer: `v${n}`, score: 1 } }));
    const env = makeEnv({ model });
    await callModel(env.ctx, req(env));
    const again = await callModel(env.ctx, req(env, { salt: "force-1" }));
    expect(again.fromCache).toBe(false);
    expect(again.value.answer).toBe("v2");
  });
});

describe("model gateway on the claude-cli provider", () => {
  const FIX = resolve(import.meta.dirname, "fixtures/claude-cli");
  const cliClient = (file: string, code = 0) =>
    new ClaudeCliClient({
      binary: "/fake/claude",
      cwd: "/fake/cwd",
      promptDir: mkdtempSync(join(tmpdir(), "jr-prompts-")),
      timeoutMs: 1000,
      maxTurns: 4,
      baseEnv: {},
      runner: async () => ({ code, signal: null, stdout: readFileSync(join(FIX, file), "utf8"), stderr: "", timedOut: false, overflow: false }),
    });
  const haiku = (max: number) => ({ choice: { model: "claude-haiku-5-5", effort: "medium", max_output_tokens: max } });
  const bytesOf = (r: ReturnType<typeof req>) =>
    [r.prompt.system, r.prompt.user, JSON.stringify(toStructuredOutputSchema(schema))].reduce((n, x) => n + new TextEncoder().encode(x).length, 0);

  it("the api reserve is the single-call formula, unchanged", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 } }));
    const env = makeEnv({ model });
    const r = req(env);
    await callModel(env.ctx, r);
    const [c] = env.store.modelCalls();
    expect(c!.provider).toBe("api");
    expect(c!.reservedUsd).toBeCloseTo(costUsd({ input: Math.ceil(bytesOf(r) / 3), cacheWrite: 0, cacheRead: 0, output: 2000 }, "claude-sonnet-5"), 12);
    expect(model.calls[0]!.maxBudgetUsd).toBe(c!.reservedUsd);
  });

  it("the claude-cli reserve covers reserve_turns turns, each with the CLI's own input overhead", async () => {
    const model = new FakeModel(() => ({ json: { answer: "hi", score: 5 } }));
    const env = makeEnv({ model, provider: "claude-cli" });
    const r = req(env);
    await callModel(env.ctx, r);
    const [c] = env.store.modelCalls();
    const cli = env.config.operations.model.cli;
    const one = costUsd({ input: Math.ceil(bytesOf(r) / 3) + cli.overhead_input_tokens, cacheWrite: 0, cacheRead: 0, output: 2000 }, "claude-sonnet-5");
    expect(c!.provider).toBe("claude-cli");
    expect(c!.reservedUsd).toBeCloseTo(cli.reserve_turns * one, 12);
    expect(model.calls[0]!.maxBudgetUsd).toBe(c!.reservedUsd);
  });

  it("the recorded success (reconstructed fixture) settles a success receipt with its real usage, within the reserve", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = cliClient("success.reconstructed.json") as never;
    const out = await callModel(env.ctx, req(env, haiku(2000)));
    expect(out.value).toEqual({ answer: "hi", score: 5 });
    const [c] = env.store.modelCalls();
    expect(c!.outcome).toBe("success");
    expect(c!.usageKnown).toBe(true);
    expect(c!.usage).toEqual({ input: 2, cacheWrite: 1156, cacheRead: 0, output: 891 });
    expect(c!.actualUsd!).toBeLessThanOrEqual(c!.reservedUsd);
    expect(env.logs.join("\n")).not.toMatch(/WARNING/);
  });

  it("the recorded truncation (reconstructed fixture: 4 turns, 1200 tokens against a 300 cap) is a truncated receipt within the multi-turn reserve, with its turns recorded", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = cliClient("truncation.reconstructed.json", 1) as never;
    await expect(callModel(env.ctx, req(env, haiku(300)))).rejects.toMatchObject({ outcome: "truncated" });
    const [c] = env.store.modelCalls();
    expect(c!.outcome).toBe("truncated");
    expect(c!.usage.output).toBe(1200);
    expect(c!.actualUsd!).toBeLessThanOrEqual(c!.reservedUsd);
    expect(c!.error).toMatch(/turns=4/);
  });

  it("the same truncation on a single-call reserve would overshoot it (why reserve_turns exists)", () => {
    const usage = { input: 8, cacheWrite: 1156, cacheRead: 3468, output: 1200 };
    expect(costUsd(usage, "claude-haiku-5-5")).toBeGreaterThan(worstCaseUsd(100, 300, "claude-haiku-5-5"));
  });

  it("a CLI error with usage settles api_error at its reported usage; one without settles at the reserve", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = cliClient("error.synthetic.json", 1) as never;
    await expect(callModel(env.ctx, req(env, haiku(300)))).rejects.toMatchObject({ outcome: "api_error" });
    const [c] = env.store.modelCalls();
    expect(c!.usageKnown).toBe(true);
    expect(c!.usage.input).toBe(120);
    expect(c!.error).toMatch(/turns=1/);

    const env2 = makeEnv({ provider: "claude-cli", model: new FakeModel(() => ({ throws: new Error("spawn ENOENT") })) });
    await expect(callModel(env2.ctx, req(env2))).rejects.toMatchObject({ outcome: "api_error" });
    const [d] = env2.store.modelCalls();
    expect(d!.usageKnown).toBe(false);
    expect(d!.actualUsd).toBe(d!.reservedUsd);
  });

  it("the CLI's --max-turns early exit settles api_error at its reported usage, with its turns (synthetic fixture)", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = cliClient("max-turns.synthetic.json", 1) as never;
    await expect(callModel(env.ctx, req(env, haiku(300)))).rejects.toMatchObject({ outcome: "api_error" });
    const [c] = env.store.modelCalls();
    expect(c!.usageKnown).toBe(true);
    expect(c!.usage.output).toBe(1600);
    expect(c!.error).toMatch(/--max-turns limit/);
    expect(c!.error).toMatch(/turns=4/);
  });

  it("structured_output that the CLI's schema accepted but Zod rejects is a schema failure, never stored", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = new ClaudeCliClient({
      binary: "/fake/claude",
      cwd: "/fake/cwd",
      promptDir: mkdtempSync(join(tmpdir(), "jr-prompts-")),
      timeoutMs: 1000,
      maxTurns: 4,
      baseEnv: {},
      runner: async () => {
        const e = JSON.parse(readFileSync(join(FIX, "success.reconstructed.json"), "utf8"));
        e.structured_output = { answer: "hi", score: 500 };
        return { code: 0, signal: null, stdout: JSON.stringify(e), stderr: "", timedOut: false, overflow: false };
      },
    }) as never;
    await expect(callModel(env.ctx, req(env, haiku(2000)))).rejects.toMatchObject({ outcome: "schema" });
    expect(env.store.getDerivation("test:kind", env.store.modelCalls()[0]!.requestKey)).toBeNull();
  });

  it("a refusal envelope is a refusal receipt (synthetic fixture)", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = cliClient("refusal.synthetic.json") as never;
    await expect(callModel(env.ctx, req(env, haiku(300)))).rejects.toMatchObject({ outcome: "refusal" });
  });

  it("missing structured_output is invalid_json", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    env.model = new ClaudeCliClient({
      binary: "/fake/claude",
      cwd: "/fake/cwd",
      promptDir: mkdtempSync(join(tmpdir(), "jr-prompts-")),
      timeoutMs: 1000,
      maxTurns: 4,
      baseEnv: {},
      runner: async () => {
        const e = JSON.parse(readFileSync(join(FIX, "success.reconstructed.json"), "utf8"));
        e.structured_output = null;
        return { code: 0, signal: null, stdout: JSON.stringify(e), stderr: "", timedOut: false, overflow: false };
      },
    }) as never;
    await expect(callModel(env.ctx, req(env, haiku(2000)))).rejects.toMatchObject({ outcome: "invalid_json" });
  });

  it("with no client, the refusal names the provider's reason and nothing is reserved", async () => {
    const env = makeEnv({ provider: "claude-cli" });
    await expect(callModel(env.ctx, req(env))).rejects.toThrow(/JR_ALLOW_MODEL/);
    expect(env.store.modelCalls()).toHaveLength(0);
  });

  it("spend splits subscription (list-price equivalent) calls from api calls", async () => {
    const env = makeEnv({ model: new FakeModel(() => ({ json: { answer: "hi", score: 5 } })) });
    await callModel(env.ctx, req(env, { prompt: { system: "a", user: "1" } }));
    const cli = makeEnv({ provider: "claude-cli", model: new FakeModel(() => ({ json: { answer: "hi", score: 5 } })) });
    await callModel(cli.ctx, req(cli, { prompt: { system: "a", user: "2" } }));
    expect(spendSummary(env.ctx).day).toMatchObject({ calls: 1, subscriptionCalls: 0, subscriptionUsd: 0 });
    const s = spendSummary(cli.ctx).day;
    expect(s.calls).toBe(1);
    expect(s.subscriptionCalls).toBe(1);
    expect(s.subscriptionUsd).toBeCloseTo(s.committed, 12);
  });
});
