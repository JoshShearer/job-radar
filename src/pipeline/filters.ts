import type { CareerProfile } from "../config/schema.js";
import type { FilterResult, NormalizedJob } from "../model/job.js";
import { assessCompensation, annualize } from "../lib/salary.js";
import { findAuthBlockers } from "../lib/location.js";
import { isBelowSenior } from "../lib/seniority.js";
import { locationVerdictFor } from "./normalize.js";

/**
 * Hard filters.
 *
 * The governing principle: reject on evidence, never on absence of evidence.
 * A missing salary, an unlabeled location, or an unfamiliar tool is not a
 * rejection - those are handled by scoring, which down-ranks. Only things we
 * positively know disqualify the role end up here.
 *
 * The one distinction that matters most: a technology in the TITLE is the core
 * job ("iOS Engineer"), while the same technology in the body is usually just
 * an adjacent team or a nice-to-have. Senior engineers learn tools; they do not
 * change specialty. So title exclusions reject and body mentions only subtract
 * points (see score.ts negative signals).
 */
export function applyFilters(job: NormalizedJob, profile: CareerProfile): FilterResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const title = job.title.toLowerCase();
  const body = job.descriptionClean.toLowerCase();

  // 1. Wrong specialty, stated in the title.
  for (const term of profile.hard_exclude_titles) {
    const t = term.trim().toLowerCase();
    if (t && title.includes(t)) {
      reasons.push(`Title indicates a different specialty ("${term}").`);
      break;
    }
  }

  // 2. Below senior.
  if (isBelowSenior(job.title, profile.seniority.reject)) {
    reasons.push(`Title is below senior level ("${job.title}").`);
  } else if (job.seniority === "unknown") {
    warnings.push("Seniority not stated in the title; verify the level before applying.");
  }

  // 3. Location / remote workability.
  const loc = locationVerdictFor(job, profile);
  if (!loc.acceptable) {
    reasons.push(loc.reason);
  } else if (job.remoteStatus === "unknown") {
    warnings.push(loc.reason);
  }

  // 4. Work authorization we cannot satisfy.
  const blockers = findAuthBlockers(body, profile.location.work_authorization_blockers);
  if (blockers.length) {
    reasons.push(`Work-authorization requirement we cannot meet: ${blockers.join(", ")}.`);
  }

  // 5. Mandatory domain experience we do not have (research ML, clearances).
  for (const phrase of profile.hard_exclude_description) {
    const p = phrase.trim().toLowerCase();
    if (p && body.includes(p)) {
      reasons.push(`Requires domain experience outside the profile ("${phrase}").`);
      break;
    }
  }

  // 6. Published compensation clearly below the floor.
  //    Only applies when compensation is actually published - UNKNOWN never
  //    rejects, by design.
  if (job.salaryMin != null && job.salaryPeriod != null) {
    const comp = assessCompensation(
      {
        min: job.salaryMin,
        max: job.salaryMax,
        currency: job.salaryCurrency,
        period: job.salaryPeriod,
        confidence: "published",
        raw: null,
      },
      {
        targetMin: profile.compensation.target_min,
        targetMax: profile.compensation.target_max,
        acceptableMin: profile.compensation.acceptable_min,
        rejectBelowMax: profile.compensation.reject_below_max,
        stretchMin: profile.compensation.stretch_min,
      },
    );
    if (comp.band === "RED") reasons.push(comp.reason);
  }

  // 7. Employment type.
  if (job.employmentType === "internship") {
    reasons.push("Internship.");
  } else if (job.employmentType === "part_time") {
    reasons.push("Part-time.");
  } else if (job.employmentType === "contract" && profile.compensation.prefer_employment_type === "full_time") {
    // A contract role is a fallback, not a rejection - the profile says
    // full-time is preferred, not required.
    const hourlyOk =
      job.salaryPeriod === "hour" &&
      job.salaryMin != null &&
      job.salaryMin >= profile.compensation.contract_min_hourly;
    warnings.push(
      hourlyOk
        ? `Contract role, but the rate clears the $${profile.compensation.contract_min_hourly}/hr fallback floor.`
        : "Contract role; full-time W-2 is preferred. Check rate and duration before investing time.",
    );
  }

  // 8. Stale postings. Not a rejection, but worth flagging - a 90-day-old
  //    posting is often already filled or perpetually open.
  if (job.datePosted) {
    const ageDays = (Date.now() - new Date(job.datePosted).getTime()) / 86_400_000;
    if (ageDays > 90) warnings.push(`Posted ${Math.round(ageDays)} days ago; may be stale or evergreen.`);
  }

  return { passed: reasons.length === 0, reasons, warnings };
}

/** Annualized top-of-range, used by scoring. Null when nothing is published. */
export function annualTop(job: NormalizedJob): number | null {
  if (job.salaryPeriod == null) return null;
  const top = job.salaryMax ?? job.salaryMin;
  if (top == null) return null;
  return annualize(top, job.salaryPeriod);
}
