import type { EvaluationPolicy } from "../config/schema.js";
import type { PostingState } from "../catalog/lifecycle.js";
import type { Eligibility } from "./eligibility.js";
import type { DeterministicScore } from "./score.js";
import type { Assessment } from "./assessment.js";
import { assignPriority, priorityForRecommendation, type Priority } from "./priority.js";
import { project, type Calibration } from "./calibration.js";

/**
 * One row of the ranking read model. The three scores are SEPARATE fields;
 * `fit` / `roi` / `priority` are the effective values and `confidence` says
 * which source they came from. Nothing overwrites the raw keyword score.
 */
export interface RankRow {
  opportunityId: string;
  eligible: boolean;
  evergreen: boolean;
  postingState: PostingState;
  lane: string;
  raw: { fit: number; roi: number; priority: Priority };
  projected: { fit: number; roi: number; priority: Priority } | null;
  analyst: { fit: number; roi: number; recommendation: string; tier: Assessment["tier"] } | null;
  fit: number;
  roi: number;
  priority: Priority;
  confidence: "analyzed" | "projected" | "raw";
}

export function rankOne(args: {
  opportunityId: string;
  eligibility: Eligibility;
  score: DeterministicScore;
  assessment: Assessment | null;
  calibration: Calibration;
  postingState: PostingState;
  evergreen: boolean;
  policy: EvaluationPolicy;
}): RankRow {
  const { score, eligibility, assessment, policy } = args;
  const raw = { fit: score.fit, roi: score.roi, priority: score.priority };
  const base = {
    opportunityId: args.opportunityId,
    eligible: eligibility.passed,
    evergreen: args.evergreen,
    postingState: args.postingState,
    lane: score.lane,
    raw,
  };

  // A hard-filter rejection stands whatever the analyst said: the analysis
  // cannot make an onsite-elsewhere role workable.
  if (assessment && eligibility.passed) {
    const v = assessment.verdict;
    const w = policy.reconcile.analyst_roi_weight;
    const roi = Math.round(v.applicationRoi * w + score.roi * (1 - w));
    return {
      ...base,
      lane: v.lane === "other" ? score.lane : v.lane,
      projected: null,
      analyst: { fit: v.fitScore, roi: v.applicationRoi, recommendation: v.recommendation, tier: assessment.tier },
      fit: v.fitScore,
      roi,
      priority: priorityForRecommendation(v.recommendation),
      confidence: "analyzed",
    };
  }

  const p = eligibility.passed ? project(raw, args.calibration) : null;
  if (p) {
    const priority = assignPriority(
      { fit: p.fit, roi: p.roi, comboCount: score.combos.length, eligible: true, ceiling: "B" },
      policy.priority,
    );
    return { ...base, projected: { ...p, priority }, analyst: null, fit: p.fit, roi: p.roi, priority, confidence: "projected" };
  }
  return { ...base, projected: null, analyst: null, fit: raw.fit, roi: raw.roi, priority: raw.priority, confidence: "raw" };
}

/** Ordering used everywhere a ranked list is shown or consumed. */
export function compareRank(a: RankRow, b: RankRow): number {
  return b.roi - a.roi || b.fit - a.fit || a.opportunityId.localeCompare(b.opportunityId);
}
