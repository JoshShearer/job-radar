import { describe, it, expect } from "vitest";
import { memoryRepo, saveAnalysisFresh, seedJob } from "./helpers/db.js";
import { routingGate, MIN_ROUTING_SAMPLE, type TriageBenchmark, type TriageBenchmarkRow } from "../src/analysis/benchmark.js";
import { triageOnlyAnalysis, type Analysis, type TriageVerdict } from "../src/model/job.js";
import { deservesDossier, type DossierPolicy } from "../src/analysis/detail.js";

/**
 * The verdict bar (81% against 92%) measures whether triage can REPLACE the
 * dossier. The code only ever uses triage as a ROUTER deciding who earns one.
 * These tests pin the router question and, more importantly, the guards that
 * stop a small or polluted sample from being read as an answer.
 */

const policy: DossierPolicy = { recommendations: ["apply", "apply_and_outreach", "network_or_watch"], minFit: 70 };

function verdict(over: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    fitScore: 50,
    applicationRoi: 50,
    lane: "frontend",
    recommendation: "skip",
    salaryClassification: "yellow",
    reasoningSummary: "A sentence.",
    ...over,
  };
}

function dossier(over: Partial<Analysis> = {}): Analysis {
  return {
    ...triageOnlyAnalysis(verdict()),
    interviewProbability: 40,
    competitionEstimate: "moderate",
    ...over,
  };
}

function row(over: Partial<TriageBenchmarkRow> = {}): TriageBenchmarkRow {
  return {
    id: "j",
    company: "Acme",
    title: "Staff Engineer",
    baselineRecommendation: "skip",
    triageRecommendation: "skip",
    baselineFit: 50,
    triageFit: 50,
    agreesOnApply: true,
    baselineEarnsDossier: false,
    triageEarnsDossier: false,
    agreesOnRouting: true,
    ...over,
  };
}

function benchmark(rows: TriageBenchmarkRow[]): TriageBenchmark {
  return {
    mode: "routing",
    policy,
    rows,
    compared: rows.length,
    failed: 0,
    agreeOnApply: 0,
    agreementRate: 0,
    meanAbsFitDelta: 0,
    estimatedCostUsd: 0,
    missedApplies: [],
    spuriousApplies: [],
    routingAgreementRate: 0,
    missedDossiers: rows.filter((r) => r.baselineEarnsDossier && !r.triageEarnsDossier),
    extraDossiers: rows.filter((r) => !r.baselineEarnsDossier && r.triageEarnsDossier),
  };
}

describe("routingGate", () => {
  it("passes on zero missed dossiers across a large enough sample", () => {
    expect(routingGate(benchmark(Array.from({ length: MIN_ROUTING_SAMPLE }, () => row()))).verdict).toBe("PASS");
  });

  it("is INCONCLUSIVE, not PASS, on zero misses in a small sample", () => {
    // The whole point of the sample-size rule. 0 misses on 5 rows bounds the
    // true miss rate at ~60%; reporting that as a pass ships an unmeasured
    // change wearing a measurement's clothes.
    const g = routingGate(benchmark(Array.from({ length: 5 }, () => row())));
    expect(g.verdict).toBe("INCONCLUSIVE");
    expect(g.reason).toContain(String(MIN_ROUTING_SAMPLE));
  });

  it("fails on a single missed dossier, however large the sample", () => {
    const rows = Array.from({ length: MIN_ROUTING_SAMPLE * 2 }, () => row());
    rows[0] = row({ baselineEarnsDossier: true, triageEarnsDossier: false, agreesOnRouting: false });
    const g = routingGate(benchmark(rows));
    expect(g.verdict).toBe("FAIL");
  });

  it("does not fail on extra dossiers - they are a cost line, not a miss", () => {
    // Deliberately asymmetric: a missed dossier hides a role from a human with
    // no later step that recovers it; an extra one costs $0.046.
    const rows = Array.from({ length: MIN_ROUTING_SAMPLE }, () => row());
    rows[0] = row({ baselineEarnsDossier: false, triageEarnsDossier: true, agreesOnRouting: false });
    expect(routingGate(benchmark(rows)).verdict).toBe("PASS");
  });
});

describe("the routing question is easier than the verdict question", () => {
  it("counts network_or_watch -> apply as no routing disagreement at all", () => {
    // All four recorded "invented applies" were exactly this move, and
    // `dossier_for` sends both verdicts to a dossier. Under the verdict bar it
    // is a disagreement; under routing it changes nothing.
    const baseline = dossier({ recommendation: "network_or_watch", fitScore: 50 });
    const triage = dossier({ recommendation: "apply", fitScore: 50 });
    expect(deservesDossier(baseline, policy)).toBe(deservesDossier(triage, policy));
  });
});

describe("analyzedSample", () => {
  function seedAnalyzed(db: ReturnType<typeof memoryRepo>["db"], repo: ReturnType<typeof memoryRepo>["repo"], a: Analysis, roi: number) {
    const id = seedJob(db, { company: "Acme", title: "Staff Engineer", applicationRoi: roi });
    db.prepare("UPDATE jobs SET filter_passed = 1 WHERE id = ?").run(id);
    saveAnalysisFresh(repo, db, id, a, "claude-opus-5");
    return id;
  }

  it("never draws a triage stub as a baseline", () => {
    // Once `two_stage` is on, stubs land in analysis_json too. A stub drawn as
    // a baseline would have the benchmark comparing triage against triage -
    // near-perfect agreement, measuring nothing.
    const { repo, db } = memoryRepo();
    seedAnalyzed(db, repo, triageOnlyAnalysis(verdict({ recommendation: "apply" })), 90);
    seedAnalyzed(db, repo, dossier({ recommendation: "apply" }), 80);

    const sample = repo.analyzedSample(10);
    expect(sample).toHaveLength(1);
    expect(sample[0]!.analysis.interviewProbability).not.toBeNull();
  });

  it("partitions the dossier split with deservesDossier, including its fit rule", () => {
    // A `skip` at fit 85 earns a dossier through `minFit`. A SQL IN list
    // against `dossier_for` would have classified it as not-earning - a gate
    // disagreeing with the function it gates.
    const { repo, db } = memoryRepo();
    seedAnalyzed(db, repo, dossier({ recommendation: "skip", fitScore: 85 }), 90);
    seedAnalyzed(db, repo, dossier({ recommendation: "skip", fitScore: 20 }), 80);

    const sample = repo.analyzedSample(10, { split: "dossier", policy });
    expect(sample).toHaveLength(2);
    const earns = sample.filter((s) => s.analysis.fitScore >= policy.minFit);
    expect(earns).toHaveLength(1);
  });

  it("refuses a dossier split with no policy rather than guessing one", () => {
    const { repo } = memoryRepo();
    expect(() => repo.analyzedSample(10, { split: "dossier" })).toThrow(/DossierPolicy/);
  });

  it("leaves the apply split's behaviour unchanged", () => {
    const { repo, db } = memoryRepo();
    seedAnalyzed(db, repo, dossier({ recommendation: "apply" }), 90);
    seedAnalyzed(db, repo, dossier({ recommendation: "skip" }), 80);

    const sample = repo.analyzedSample(2);
    expect(sample).toHaveLength(2);
    expect(sample.map((s) => s.analysis.recommendation).sort()).toEqual(["apply", "skip"]);
  });
});
