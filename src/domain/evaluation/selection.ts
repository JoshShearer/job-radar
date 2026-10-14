import type { EvaluationPolicy } from "../config/schema.js";
import { postingAgeDays } from "./eligibility.js";

/**
 * Which postings to spend assessment money on: the top K by RANK, spread
 * across companies. Never gated on an absolute keyword score (its error
 * against the analyst is too large to gate on; the rank is reliable).
 *
 * Deterministic. Both caps hold: a cap with an uncapped backfill is not a cap.
 */
export interface SelectionCandidate {
  opportunityId: string;
  company: string;
  roi: number;
  fit: number;
  datePosted: string | null;
}

export interface CompanyHistory {
  /** Postings at this company with a current assessment. */
  assessed: number;
  /** How many of those came back apply / apply_and_outreach. */
  hits: number;
}

export function selectForAssessment(
  candidates: readonly SelectionCandidate[],
  history: ReadonlyMap<string, CompanyHistory>,
  limit: number,
  policy: EvaluationPolicy["selection"],
  now: Date,
): SelectionCandidate[] {
  const adjusted = candidates.map((c) => {
    const h = history.get(c.company);
    let rank = c.roi;
    if (!h || h.assessed === 0) rank += policy.unexplored_bonus;
    else if (h.assessed >= policy.cold_after && h.hits === 0) rank -= policy.cold_penalty;
    const age = postingAgeDays(c.datePosted, now);
    if (age !== null && age <= policy.fresh_days) rank += policy.fresh_bonus;
    return { c, rank };
  });
  adjusted.sort((a, b) => b.rank - a.rank || b.c.fit - a.c.fit || a.c.opportunityId.localeCompare(b.c.opportunityId));

  const perCompany = new Map<string, number>();
  const picked: SelectionCandidate[] = [];
  const overflow: SelectionCandidate[] = [];
  for (const { c } of adjusted) {
    if (picked.length >= limit) break;
    const n = perCompany.get(c.company) ?? 0;
    if (n < policy.per_company_cap) {
      perCompany.set(c.company, n + 1);
      picked.push(c);
    } else overflow.push(c);
  }
  for (const c of overflow) {
    if (picked.length >= limit) break;
    const n = perCompany.get(c.company) ?? 0;
    if (n >= policy.backfill_cap) continue;
    perCompany.set(c.company, n + 1);
    picked.push(c);
  }
  return picked;
}
