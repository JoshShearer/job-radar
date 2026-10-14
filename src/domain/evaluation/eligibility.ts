import type { EvaluationPolicy, Preferences, Strategy } from "../config/schema.js";
import type { PostingSnapshot } from "../catalog/posting.js";
import { locationPrefs } from "../catalog/normalize.js";
import { annualize, assessCompensation } from "../text/salary.js";
import { assessLocation, findAuthBlockers } from "../text/location.js";
import { isBelowSenior } from "../text/seniority.js";
import { matchesTerm } from "../text/terms.js";
import { DAY_MS } from "../../kernel/clock.js";

export const ELIGIBILITY_VERSION = "eligibility@1";

export interface Eligibility {
  passed: boolean;
  /** Evidence that disqualifies. Empty when passed. */
  reasons: string[];
  /** Concerns worth surfacing on a passing posting. */
  warnings: string[];
}

export function compTargets(p: Preferences) {
  const c = p.compensation;
  return {
    targetMin: c.target_min,
    targetMax: c.target_max,
    acceptableMin: c.acceptable_min,
    rejectBelowMax: c.reject_below_max,
    stretchMin: c.stretch_min,
  };
}

/**
 * Hard filters. Reject on evidence, never on absence of evidence: a missing
 * salary or an unlabelled location down-ranks, it does not reject. A
 * technology in the TITLE is the job; the same word in the body is not.
 */
export function assessEligibility(
  s: PostingSnapshot,
  strategy: Strategy,
  prefs: Preferences,
  policy: EvaluationPolicy,
  now: Date,
): Eligibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const title = s.title.toLowerCase();
  const body = s.description.toLowerCase();

  for (const term of strategy.hard_exclude_titles) {
    const t = term.trim().toLowerCase();
    if (t && matchesTerm(title, t)) {
      reasons.push(`Title indicates a different specialty ("${term}").`);
      break;
    }
  }

  if (isBelowSenior(s.title, strategy.seniority.reject)) {
    reasons.push(`Title is below senior level ("${s.title}").`);
  } else if (s.seniority === "unknown") {
    warnings.push("Seniority not stated in the title; verify the level before applying.");
  }

  const loc = assessLocation(s.location, locationPrefs(prefs), { description: s.description });
  if (!loc.acceptable) reasons.push(loc.reason);
  else if (loc.needsLocationReview || s.remoteStatus === "unknown") warnings.push(loc.reason);

  const blockers = findAuthBlockers(body, prefs.location.work_authorization_blockers);
  if (blockers.length) reasons.push(`Work-authorization requirement we cannot meet: ${blockers.join(", ")}.`);

  for (const phrase of strategy.hard_exclude_description) {
    const p = phrase.trim().toLowerCase();
    if (p && matchesTerm(body, p)) {
      reasons.push(`Requires domain experience outside the profile ("${phrase}").`);
      break;
    }
  }

  if (s.salaryMin != null && s.salaryPeriod != null) {
    const comp = assessCompensation(
      { min: s.salaryMin, max: s.salaryMax, currency: s.salaryCurrency, period: s.salaryPeriod, confidence: "published", raw: null },
      compTargets(prefs),
    );
    if (comp.band === "RED") reasons.push(comp.reason);
  }

  if (s.employmentType === "internship") reasons.push("Internship.");
  else if (s.employmentType === "part_time") reasons.push("Part-time.");
  else if (s.employmentType === "contract" && prefs.compensation.prefer_employment_type === "full_time") {
    const hourlyOk = s.salaryPeriod === "hour" && s.salaryMin != null && s.salaryMin >= prefs.compensation.contract_min_hourly;
    warnings.push(
      hourlyOk
        ? `Contract role, but the rate clears the $${prefs.compensation.contract_min_hourly}/hr fallback floor.`
        : "Contract role; full-time W-2 is preferred. Check rate and duration before investing time.",
    );
  }

  const age = postingAgeDays(s.datePosted, now);
  if (age !== null && age > policy.scoring.stale_warning_days) {
    warnings.push(`Posted ${Math.round(age)} days ago; may be stale or evergreen.`);
  }

  return { passed: reasons.length === 0, reasons, warnings };
}

export function postingAgeDays(datePosted: string | null, now: Date): number | null {
  if (!datePosted) return null;
  const t = Date.parse(datePosted);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / DAY_MS;
}

/** Unknown age is never evergreen: missing data is not disqualifying data. */
export function isEvergreen(datePosted: string | null, evergreenDays: number, now: Date): boolean {
  const age = postingAgeDays(datePosted, now);
  return age !== null && age > evergreenDays;
}

export function annualTop(s: PostingSnapshot): number | null {
  if (s.salaryPeriod == null) return null;
  const top = s.salaryMax ?? s.salaryMin;
  return top == null ? null : annualize(top, s.salaryPeriod);
}
