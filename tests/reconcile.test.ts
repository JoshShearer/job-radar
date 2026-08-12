import { describe, it, expect } from "vitest";
import { reconcileWithAnalysis } from "../src/pipeline/score.js";
import type { Analysis, ScoreResult } from "../src/model/job.js";

function score(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    fitScore: 96,
    lane: "ai_product",
    laneLabel: "AI-enabled Product Engineering",
    compensationScore: 58,
    compensationConfidence: "UNKNOWN",
    competitionScore: 40,
    applicationRoi: 85,
    positiveSignals: ["typescript", "agentic"],
    negativeSignals: [],
    combos: ["LLM product + TypeScript"],
    explanation: "Fit = 96",
    priority: "A",
    ...over,
  };
}

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    fitScore: 33,
    applicationRoi: 12,
    lane: "ai_product",
    recommendation: "skip",
    strengths: [],
    risks: [],
    missingRequirements: [],
    differentiation: "none identified",
    salaryClassification: "unknown",
    salaryReasoning: "",
    interviewProbability: 6,
    competitionEstimate: "very_high",
    outreachTargets: [],
    reasoningSummary: "Sr. Staff role requiring org-wide technical leadership; two levels above.",
    ...over,
  };
}

describe("reconcileWithAnalysis", () => {
  it("demotes a keyword-inflated job the analysis rejected", () => {
    // The real case this exists for: keyword engine said 96/Priority A,
    // the analysis read the seniority requirements and said skip.
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.priority).toBe("D");
    expect(out.fitScore).toBe(33);
    expect(out.applicationRoi).toBeLessThan(40);
  });

  it("maps each recommendation to the right priority", () => {
    const cases: [Analysis["recommendation"], string][] = [
      ["apply_and_outreach", "A"],
      ["apply", "B"],
      ["network_or_watch", "C"],
      ["skip", "D"],
    ];
    for (const [recommendation, expected] of cases) {
      expect(reconcileWithAnalysis(score(), analysis({ recommendation })).priority).toBe(expected);
    }
  });

  it("promotes a job the keyword engine underrated", () => {
    const out = reconcileWithAnalysis(
      score({ fitScore: 55, applicationRoi: 40, priority: "C" }),
      analysis({ fitScore: 88, applicationRoi: 76, recommendation: "apply_and_outreach" }),
    );
    expect(out.priority).toBe("A");
    expect(out.fitScore).toBe(88);
    expect(out.applicationRoi).toBeGreaterThan(60);
  });

  it("records the override in the explanation when the two disagree sharply", () => {
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.explanation).toMatch(/Analysis overrode the keyword engine/);
    expect(out.explanation).toMatch(/96 -> 33/);
  });

  it("notes agreement when the two are close", () => {
    const out = reconcileWithAnalysis(
      score({ fitScore: 80 }),
      analysis({ fitScore: 84, recommendation: "apply" }),
    );
    expect(out.explanation).toMatch(/Analysis agrees/);
  });

  it("blends ROI toward the analysis without discarding the deterministic signal", () => {
    // Deterministic ROI carries competition and recency data the model cannot see.
    const out = reconcileWithAnalysis(
      score({ applicationRoi: 100 }),
      analysis({ applicationRoi: 0, recommendation: "apply" }),
    );
    expect(out.applicationRoi).toBe(30); // 0*0.7 + 100*0.3
  });

  it("preserves lane and signals from the deterministic pass", () => {
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.combos).toEqual(["LLM product + TypeScript"]);
    expect(out.positiveSignals).toEqual(["typescript", "agentic"]);
  });
});
