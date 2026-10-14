import { describe, expect, it } from "vitest";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { assess } from "../src/app/assess.js";
import { benchmarkTriage } from "../src/app/benchmark.js";
import { benchmarkRow, MIN_ROUTING_SAMPLE, orderBaselines, routingGate, summarizeBenchmark, verdictGate } from "../src/domain/evaluation/benchmark.js";
import type { Dossier, Triage } from "../src/domain/evaluation/assessment.js";
import type { ModelRequest } from "../src/ports/io.js";
import { dossierVerdict, FakeModel, GH_ACME, ghBoard, makeEnv, testConfig, triageVerdict } from "./helpers/context.js";

const policy = testConfig().policy.assessment;
const subj = (i: number) => ({ opportunityId: `o${i}`, company: "Acme", title: `Role ${i}` });
const dossier = (recommendation: string, fitScore: number) => dossierVerdict({ recommendation, fitScore }) as unknown as Dossier;
const triage = (recommendation: string, fitScore: number) => triageVerdict({ recommendation, fitScore }) as unknown as Triage;

describe("triage benchmark metrics", () => {
  it("a missed dossier fails routing; an extra one is only a cost", () => {
    const rows = [
      benchmarkRow(subj(1), dossier("apply", 85), triage("skip", 30), false, policy), // missed
      benchmarkRow(subj(2), dossier("skip", 20), triage("apply", 80), false, policy), // extra
    ];
    const s = summarizeBenchmark(rows);
    expect(s.missedDossiers.map((r) => r.opportunityId)).toEqual(["o1"]);
    expect(s.extraDossiers.map((r) => r.opportunityId)).toEqual(["o2"]);
    expect(routingGate(s).verdict).toBe("FAIL");
  });

  it("a pre-routed baseline counts for the verdict question, never for routing", () => {
    const s = summarizeBenchmark([benchmarkRow(subj(1), dossier("apply", 85), triage("skip", 30), true, policy)]);
    expect(s.compared).toBe(1);
    expect(s.missedApplies).toHaveLength(1);
    expect(s.routingCompared).toBe(0);
    expect(s.missedDossiers).toHaveLength(0);
  });

  it("zero misses on too few independent baselines is inconclusive, not a pass", () => {
    const few = Array.from({ length: 5 }, (_, i) => benchmarkRow(subj(i), dossier("apply", 85), triage("apply", 82), false, policy));
    expect(routingGate(summarizeBenchmark(few)).verdict).toBe("INCONCLUSIVE");
    const enough = Array.from({ length: MIN_ROUTING_SAMPLE }, (_, i) => benchmarkRow(subj(i), dossier("apply", 85), triage("apply", 82), false, policy));
    expect(routingGate(summarizeBenchmark(enough)).verdict).toBe("PASS");
  });

  it("the verdict bar is 92% apply-vs-not agreement", () => {
    const rows = Array.from({ length: 10 }, (_, i) => benchmarkRow(subj(i), dossier("apply", 85), triage(i === 0 ? "skip" : "apply", 80), false, policy));
    expect(verdictGate(summarizeBenchmark(rows)).verdict).toBe("FAIL"); // 90%
  });

  it("routing spends on independent, dossier-earning baselines first", () => {
    const items = [
      { id: "pre", baseline: dossier("apply", 85), preRouted: true },
      { id: "skip", baseline: dossier("skip", 10), preRouted: false },
      { id: "earn", baseline: dossier("apply", 85), preRouted: false },
    ];
    expect(orderBaselines(items, "routing", policy).map((x) => x.id)).toEqual(["earn", "skip", "pre"]);
  });
});

describe("benchmark-triage, end to end", () => {
  function setup() {
    let triageReply = triageVerdict({ recommendation: "skip", fitScore: 20 });
    const model = new FakeModel((req: ModelRequest) => {
      const props = Object.keys((req.jsonSchema as { properties?: object }).properties ?? {});
      return { json: props.includes("strengths") ? dossierVerdict() : triageReply };
    });
    const env = makeEnv({ model, routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
    const run = () => env.ctx.store.startRun("t", env.ctx.clock.now().toISOString());
    return { env, model, run, setTriage: (t: ReturnType<typeof triageVerdict>) => (triageReply = t) };
  }

  it("without --yes it spends nothing; with it, it finds the dossier triage would have withheld", async () => {
    const { env, model, run } = setup();
    await sweep(env.ctx, run());
    evaluate(env.ctx, null);
    await assess(env.ctx, run(), { limit: 5, twoStage: false }); // independent baseline: dossier "apply"
    const before = model.calls.length;

    const dry = await benchmarkTriage(env.ctx, run(), { limit: 10, mode: "routing", yes: false });
    expect(dry.outcome).toBe("ok");
    expect(dry.value.sampled).toBe(1);
    expect(model.calls.length).toBe(before);

    const r = await benchmarkTriage(env.ctx, run(), { limit: 10, mode: "routing", yes: true });
    expect(model.calls.length).toBe(before + 1);
    expect(r.value.summary!.missedDossiers).toHaveLength(1);
    expect(r.value.gate!.verdict).toBe("FAIL");
    expect(r.value.spentUsd).toBeGreaterThan(0);
    expect(env.ctx.store.modelCalls().at(-1)!.purpose).toBe("benchmark");
  });

  it("a dossier bought because triage earned it is pre-routed, and its triage answer is free", async () => {
    const { env, model, run, setTriage } = setup();
    setTriage(triageVerdict({ recommendation: "apply", fitScore: 85 }));
    await sweep(env.ctx, run());
    evaluate(env.ctx, null);
    await assess(env.ctx, run(), { limit: 5, twoStage: true });
    const before = model.calls.length;
    const r = await benchmarkTriage(env.ctx, run(), { limit: 10, mode: "routing", yes: true });
    expect(model.calls.length).toBe(before);
    expect(r.value.fromCache).toBe(1);
    expect(r.value.rows[0]!.preRouted).toBe(true);
    expect(r.value.summary!.routingCompared).toBe(0);
    expect(r.value.gate!.verdict).toBe("INCONCLUSIVE");
  });

  it("no current dossiers: refused with how to make some", async () => {
    const { env, run } = setup();
    await sweep(env.ctx, run());
    evaluate(env.ctx, null);
    const r = await benchmarkTriage(env.ctx, run(), { limit: 10, mode: "verdict", yes: true });
    expect(r.outcome).toBe("refused");
    expect(r.notes[0]).toMatch(/--single-stage/);
  });
});
