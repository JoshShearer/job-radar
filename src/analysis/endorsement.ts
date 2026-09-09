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

import type { Analysis, EnrichedJob } from "../model/job.js";

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
  | "unanalyzed";

export interface Endorsement {
  tier: EndorsementTier;
  /** Null only when `tier` is `unanalyzed`. */
  verdict: Analysis["recommendation"] | null;
  /** The analyst's own words, truncated. Null when it recorded none. */
  reason: string | null;
  fitScore: number | null;
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

export function endorsementOf(job: EnrichedJob): Endorsement {
  const analysis = job.analysis;
  if (!analysis) {
    return { tier: "unanalyzed", verdict: null, reason: null, fitScore: job.fitScore };
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
