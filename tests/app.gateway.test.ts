import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetRefusal, callModel, ModelFailure, NoModelConfigured } from "../src/app/gateway.js";
import { spendSummary } from "../src/app/spend.js";
import { FakeModel, makeEnv, testConfig, type ModelReply } from "./helpers/context.js";

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
