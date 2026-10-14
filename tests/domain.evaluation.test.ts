import { describe, expect, it } from "vitest";
import { assignPriority } from "../src/domain/evaluation/priority.js";
import { calibrate, calibrateWithLegacy, project } from "../src/domain/evaluation/calibration.js";
import { rankOne } from "../src/domain/evaluation/ranking.js";
import { selectForAssessment } from "../src/domain/evaluation/selection.js";
import { coherenceProblems } from "../src/domain/config/schema.js";
import { deterministicNote } from "../src/domain/llm/prompts.js";
import { earnsDossier } from "../src/domain/evaluation/assessment.js";
import type { DeterministicScore } from "../src/domain/evaluation/score.js";
import { testConfig } from "./helpers/context.js";

const config = testConfig();
const policy = config.policy;

const score = (over: Partial<DeterministicScore> = {}): DeterministicScore => ({
  fit: 90,
  roi: 85,
  lane: "full_stack",
  laneLabel: "Full stack",
  compensationBand: "GREEN",
  compensationNote: "clears target",
  compensationScore: 90,
  competitionScore: 60,
  positiveSignals: ["typescript"],
  negativeSignals: [],
  combos: ["x"],
  explanation: "",
  priority: "A",
  ...over,
});

describe("priority policy (one definition, from config)", () => {
  it("assigns bands and enforces the ceiling", () => {
    expect(assignPriority({ fit: 90, roi: 80, comboCount: 1, eligible: true }, policy.priority)).toBe("A");
    expect(assignPriority({ fit: 90, roi: 80, comboCount: 1, eligible: true, ceiling: "B" }, policy.priority)).toBe("B");
    expect(assignPriority({ fit: 90, roi: 80, comboCount: 1, eligible: false }, policy.priority)).toBe("D");
  });
});

describe("ranking keeps three scores apart", () => {
  const cal = calibrate(Array.from({ length: 10 }, () => ({ detFit: 80, llmFit: 60, detRoi: 80, llmRoi: 56 })), policy.calibration);
  const elig = { passed: true, reasons: [], warnings: [] };

  it("a projected posting can never be A", () => {
    const r = rankOne({ opportunityId: "x", eligibility: elig, score: score({ fit: 100, roi: 100 }), assessment: null, calibration: cal, postingState: "open", evergreen: false, policy });
    expect(r.confidence).toBe("projected");
    expect(r.priority).not.toBe("A");
    expect(r.raw.fit).toBe(100);
    expect(r.projected!.fit).toBe(75);
  });

  it("the analyst decides priority, and a hard-filter rejection still stands", () => {
    const a = { tier: "triage" as const, verdict: { fitScore: 30, applicationRoi: 20, lane: "full_stack", recommendation: "skip" as const, salaryClassification: "green" as const, reasoningSummary: "level mismatch" } };
    expect(rankOne({ opportunityId: "x", eligibility: elig, score: score(), assessment: a, calibration: cal, postingState: "open", evergreen: false, policy }).priority).toBe("D");
    const rejected = rankOne({ opportunityId: "x", eligibility: { passed: false, reasons: ["onsite elsewhere"], warnings: [] }, score: score(), assessment: { ...a, verdict: { ...a.verdict, recommendation: "apply_and_outreach" } }, calibration: cal, postingState: "open", evergreen: false, policy });
    expect(rejected.eligible).toBe(false);
    expect(rejected.confidence).toBe("raw");
  });

  it("calibration refuses to act below the sample floor", () => {
    const few = calibrate([{ detFit: 80, llmFit: 40, detRoi: 80, llmRoi: 40 }], policy.calibration);
    expect(few.usable).toBe(false);
    expect(project({ fit: 80, roi: 80 }, few)).toBeNull();
  });

  it("imported assessments top up calibration only while current ones are below the floor", () => {
    const pair = (det: number, llm: number) => ({ detFit: det, llmFit: llm, detRoi: det, llmRoi: llm });
    const legacy = Array.from({ length: 20 }, () => pair(100, 58));
    const topped = calibrateWithLegacy([pair(80, 40)], legacy, policy.calibration);
    expect(topped.usable).toBe(true);
    expect(topped.fromLegacy).toBe(20);
    expect(project({ fit: 100, roi: 100 }, topped)!.fit).toBeLessThan(70);

    const enough = Array.from({ length: policy.calibration.min_sample }, () => pair(80, 76));
    const fresh = calibrateWithLegacy(enough, legacy, policy.calibration);
    expect(fresh.fromLegacy).toBe(0);
    expect(fresh.fitRatio).toBeCloseTo(0.95);
  });
});

describe("selection for assessment", () => {
  it("caps companies, including in backfill, and prefers unexplored companies", () => {
    const c = (id: string, company: string, roi: number) => ({ opportunityId: id, company, roi, fit: roi, datePosted: null });
    const cands = [c("a1", "big", 90), c("a2", "big", 89), c("a3", "big", 88), c("a4", "big", 87), c("b1", "small", 70)];
    const history = new Map([["big", { assessed: 10, hits: 0 }]]);
    const picked = selectForAssessment(cands, history, 10, policy.selection, new Date("2026-10-01T00:00:00Z"));
    expect(picked.filter((p) => p.company === "big").length).toBe(policy.selection.backfill_cap);
    expect(picked[0]!.company).toBe("small"); // cold big company penalized, unexplored small company boosted
  });
});

describe("assessment routing and inputs", () => {
  it("routes deterministically", () => {
    const v = { fitScore: 75, applicationRoi: 50, lane: "x", recommendation: "skip" as const, salaryClassification: "unknown" as const, reasoningSummary: "" };
    expect(earnsDossier(v, policy.assessment)).toBe(true); // fit above dossier_min_fit
    expect(earnsDossier({ ...v, fitScore: 40 }, policy.assessment)).toBe(false);
  });

  it("the note the analyst sees carries nothing that changes with the calendar", () => {
    const n = deterministicNote(score({ negativeSignals: ["WARNING: Posted 41 days ago; may be stale or evergreen.", "Wants rust (no direct evidence in profile)"] }));
    expect(n).not.toMatch(/days ago/);
    expect(n).toContain("Wants rust");
    expect(n).not.toMatch(/Fit|ROI|\b90\b|\b85\b/);
  });

  it("combo explanations (config prose about the candidate) never reach the model", () => {
    const n = deterministicNote(score({ positiveSignals: ["COMBO: IoT + web - Six years at Valin doing controls", "typescript"] }));
    expect(n).toContain("COMBO: IoT + web");
    expect(n).not.toMatch(/Valin|Six years/);
  });
});

describe("config coherence", () => {
  it("the shipped example is coherent", () => {
    expect(coherenceProblems(config)).toEqual([]);
  });
  it("catches weights that do not sum, unknown lanes, inverted bands", () => {
    const bad = testConfig((c) => {
      c.policy.roi.weights.fit = 0.9;
      c.strategy.signals.push({ term: "x", weight: 1, lane: "nope" });
      c.preferences.compensation.target_min = 10;
    });
    const p = coherenceProblems(bad).join("\n");
    expect(p).toMatch(/roi.weights sum/);
    expect(p).toMatch(/unknown lane "nope"/);
    expect(p).toMatch(/acceptable_min must be <= target_min/);
  });
});
