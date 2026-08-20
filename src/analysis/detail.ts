import type { TriageVerdict } from "../model/job.js";

/**
 * Which verdicts earn the full dossier.
 *
 * Mirrors `analysis_detail` in config/career-profile.yaml.
 */
export interface DossierPolicy {
  /** Recommendations that always get the dossier. */
  recommendations: readonly string[];
  /**
   * Fit at or above this earns a dossier whatever the recommendation says.
   *
   * The safety valve. A `skip` at fit 85 is more likely a model that has
   * misjudged something than a genuinely hopeless role, and the dossier is
   * what a human would need in order to see which.
   */
  minFit: number;
}

/**
 * Does this triage verdict deserve the second, expensive call?
 *
 * Deterministic on purpose. This decides where money goes, so it has to be
 * reproducible and auditable when a ranking looks wrong - the same rule the
 * rest of the pipeline follows. No model is asked whether it would like to
 * write more.
 */
export function deservesDossier(verdict: TriageVerdict, policy: DossierPolicy): boolean {
  if (policy.recommendations.includes(verdict.recommendation)) return true;
  return verdict.fitScore >= policy.minFit;
}

/**
 * Why the dossier was or was not fetched, for the log.
 *
 * A per-job line rather than a total, because "spent on 6 of 40" is the number
 * that tells you whether the policy is set sensibly.
 */
export function dossierReason(verdict: TriageVerdict, policy: DossierPolicy): string {
  if (policy.recommendations.includes(verdict.recommendation)) return `verdict ${verdict.recommendation}`;
  if (verdict.fitScore >= policy.minFit) return `fit ${verdict.fitScore} >= ${policy.minFit}`;
  return `triage only (${verdict.recommendation}, fit ${verdict.fitScore})`;
}
