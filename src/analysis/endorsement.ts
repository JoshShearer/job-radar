/**
 * Does the standing analysis endorse applying to this posting?
 *
 * 22 of 43 applications were prepared against a `skip` or `network_or_watch`
 * verdict. The tool had already formed the judgement, printed it in the
 * briefing, and then sold the full package anyway without a word of friction.
 * Each unendorsed application costs ~$0.06 to prepare plus real human time, and
 * dilutes the applied-to pool that the outcome data is eventually judged on.
 *
 * THE HUMAN OUTRANKS THE ANALYST. This module never hard-blocks. Its whole job
 * is to make the disagreement visible at the moment money would be spent, and
 * to make overriding it a deliberate act that leaves a record. A gate that
 * cannot be overridden would be wrong: the analyst is a model, and the person
 * applying knows things it does not.
 *
 * NOTHING HERE IS INVENTED. The reason line is the analyst's own
 * `reasoningSummary`, truncated on a word boundary. It is deliberately NOT
 * split into "the first sentence": `split(". ")` mangles "e.g.", "Sr. Engineer"
 * and "$160k vs. $180k", and a sentence cut in the wrong place misrepresents
 * the judgement it is quoting. Truncation is honest about being truncated.
 */

import type { CareerProfile } from "../config/schema.js";
import type { Analysis, EnrichedJob } from "../model/job.js";
import { analysisSchemaFor, isTriageOnly, triageSchemaFor } from "../model/job.js";
import { computeAnalysisIdentity, staleAnalysisFields, type IdentityField } from "./identity.js";

/**
 * The verdicts that endorse applying.
 *
 * One definition, imported by everything that asks the question. This started
 * life duplicated in `benchmark.ts`; a second copy is how the two drift and one
 * of them silently stops counting `apply_and_outreach`.
 */
export const APPLY_VERDICTS: ReadonlySet<string> = new Set(["apply", "apply_and_outreach"]);

export function isApplyVerdict(recommendation: string): boolean {
  return APPLY_VERDICTS.has(recommendation);
}

export type EndorsementTier =
  /** The analyst said apply. */
  | "endorsed"
  /** The analyst looked and said skip or watch. */
  | "unendorsed"
  /** No standing analysis. There is no verdict to agree or disagree with. */
  | "unanalyzed"
  /**
   * There IS a standing analysis, but it can no longer be trusted: one of its
   * snapshotted inputs (title/location/employment/compensation/evidence) has
   * moved since it was formed, or the stored JSON no longer conforms to the
   * live schema for its tier (JOB-51). Distinct from `unendorsed` - this is
   * not the analyst disagreeing, it is the record no longer describing this
   * posting.
   */
  | "stale";

export interface Endorsement {
  tier: EndorsementTier;
  /** Null only when `tier` is `unanalyzed`. */
  verdict: Analysis["recommendation"] | null;
  /** The analyst's own words, truncated. Null when it recorded none. */
  reason: string | null;
  fitScore: number | null;
  /** Set only when `tier` is `stale`. Which inputs moved - empty when the only problem is the schema. */
  staleFields?: IdentityField[];
  /** Set only when `tier` is `stale`. The stored JSON failed re-validation against the current schema. */
  staleSchema?: boolean;
}

/** How much of `reasoningSummary` fits on a terminal line with a label. */
const REASON_BUDGET = 160;

/** Truncate on a word boundary, marking that it was truncated. */
function oneLine(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= REASON_BUDGET) return flat;
  const cut = flat.slice(0, REASON_BUDGET);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > REASON_BUDGET / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/**
 * `profile` is optional, deliberately: it is what makes the staleness check
 * possible (the current identity and the current schema for this job's lane
 * set both depend on it), but not every caller has one in scope or wants the
 * check. `src/apply/autofill.ts`'s informational report is the one caller
 * left calling this without a profile - the residual risk of that (a reader
 * could see a corrected score next to a stale verdict's narrative) is a known
 * limitation of JOB-51, not an oversight; see the PR description.
 *
 * Every caller that GATES spend (`refuseIfUnendorsed` in src/cli.ts) passes
 * a profile, so money is never prepared against an untrustworthy verdict.
 */
export function endorsementOf(job: EnrichedJob, profile?: CareerProfile): Endorsement {
  const analysis = job.analysis;
  if (!analysis) {
    return { tier: "unanalyzed", verdict: null, reason: null, fitScore: job.fitScore };
  }

  if (profile) {
    const current = computeAnalysisIdentity(job, profile);
    const staleFields = staleAnalysisFields(job.analysisIdentity, current);
    const laneKeys = Object.keys(profile.lanes);
    const schema = isTriageOnly(analysis) ? triageSchemaFor(laneKeys) : analysisSchemaFor(laneKeys);
    const staleSchema = !schema.safeParse(analysis).success;
    if (staleFields.length > 0 || staleSchema) {
      return {
        tier: "stale",
        verdict: analysis.recommendation,
        reason: oneLine(analysis.reasoningSummary),
        fitScore: analysis.fitScore,
        staleFields,
        staleSchema,
      };
    }
  }

  return {
    tier: isApplyVerdict(analysis.recommendation) ? "endorsed" : "unendorsed",
    verdict: analysis.recommendation,
    reason: oneLine(analysis.reasoningSummary),
    fitScore: analysis.fitScore,
  };
}

/** How the verdict reads in a report or a terminal line. */
export function describeVerdict(e: Endorsement): string {
  if (e.tier === "unanalyzed") return "not analyzed";
  const fit = e.fitScore === null ? "" : ` (fit ${e.fitScore})`;
  return `${e.verdict}${fit}`;
}
