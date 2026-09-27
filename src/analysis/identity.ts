/**
 * A content address for the INPUTS an analysis was formed against, not just
 * the description text.
 *
 * JOB-51's bug: `upsert()` overwrites `title`, `location`, `remote_status`,
 * `employment_type` and the salary columns UNCONDITIONALLY, with no
 * invalidation, while `materialHash` only tracks `description_clean`. A
 * posting that keeps the same description but changes title (a promotion, a
 * re-leveling, a re-post as a different role) or location/employment/comp
 * moves the analyst's actual inputs while `needingAnalysis` keeps reading
 * `analysis_json IS NULL` as the only eligibility test - which stays false
 * forever, so the job is never re-offered and a stale verdict keeps being
 * trusted for reconciliation and endorsement.
 *
 * This module is the fix's vocabulary: five independent hashes of the fields
 * that actually reach the analyst (see `buildUserPrompt` and
 * `buildSystemPrompt`), snapshotted at analysis time and compared against the
 * job's CURRENT state on every read that matters (selection, reconciliation,
 * endorsement).
 */

import type { CareerProfile } from "../config/schema.js";
import type { NormalizedJob } from "../model/job.js";
import { buildSystemPrompt } from "./prompt.js";
import { sha256 } from "../lib/hash.js";

/** The subset of a job's fields that feed a fresh analysis's identity. */
export type IdentityInputJob = Pick<
  NormalizedJob,
  "title" | "location" | "remoteStatus" | "employmentType" | "salaryMin" | "salaryMax" | "salaryCurrency" | "salaryPeriod"
>;

/**
 * One hash per input that, if it moves, means the analyst was answering a
 * different question than the one the job now asks.
 *
 * `evidenceHash` is deliberately coarse: `sha256(buildSystemPrompt(profile))`
 * alone, NOT the calibration-stable deterministic note that `evidenceVersion`
 * (analyzer.ts) also folds in. That note carries `lane`/compensation
 * band/signals, which are deterministic-SCORE outputs, not raw job identity -
 * mixing them in here would make this module reach back into scoring to
 * decide staleness. JOB-58 is the ticket to narrow `evidenceHash` to the
 * slice of the profile that actually changes a verdict (today, any edit to
 * career-profile.yaml - even an unrelated compensation band - marks every
 * analysis stale). Until then this is a deliberate stand-in: coarser than it
 * needs to be, but not wrong in the direction that matters (a false "stale"
 * costs a rank slot in the next `needingAnalysis` pass; a false "fresh" would
 * mean trusting a verdict formed under different rules).
 */
export interface AnalysisIdentity {
  titleHash: string;
  locationHash: string;
  employmentHash: string;
  compensationHash: string;
  evidenceHash: string;
}

/**
 * The same five hashes as read back from a stored row. Any of them is `null`
 * on a legacy row (written before this column existed - JOB-51 deliberately
 * backfills nothing) or on a row that has never carried a full identity
 * snapshot for some other reason.
 */
export interface StoredAnalysisIdentity {
  titleHash: string | null;
  locationHash: string | null;
  employmentHash: string | null;
  compensationHash: string | null;
  evidenceHash: string | null;
}

/** Which named input moved. Mirrors `AnalysisIdentity`'s keys, without `Hash`. */
export type IdentityField = "title" | "location" | "employment" | "compensation" | "evidence";

const FIELD_TO_KEY: Record<IdentityField, keyof AnalysisIdentity> = {
  title: "titleHash",
  location: "locationHash",
  employment: "employmentHash",
  compensation: "compensationHash",
  evidence: "evidenceHash",
};

/**
 * The identity a FRESH analysis would be formed against right now.
 *
 * Mirrors exactly what `buildUserPrompt` shows the model:
 *   - `Title: ${job.title}`
 *   - `Location: ${job.location} (classified: ${job.remoteStatus})`
 *   - `Employment type: ${job.employmentType}`
 *   - the salary line, built from min/max/currency/period
 *
 * and what `buildSystemPrompt` produces from the profile as a whole.
 *
 * Each hash is computed independently so `staleAnalysisFields` can name which
 * ONE thing moved - "location changed" is a more useful refusal message than
 * "something changed".
 */
export function computeAnalysisIdentity(job: IdentityInputJob, profile: CareerProfile): AnalysisIdentity {
  return {
    titleHash: sha256(job.title),
    locationHash: sha256(`${job.location}|${job.remoteStatus}`),
    employmentHash: sha256(job.employmentType),
    compensationHash: sha256(
      `${job.salaryMin ?? ""}|${job.salaryMax ?? ""}|${job.salaryCurrency ?? ""}|${job.salaryPeriod ?? ""}`,
    ),
    evidenceHash: sha256(buildSystemPrompt(profile)),
  };
}

/**
 * Which inputs moved between a stored snapshot and the job's current state.
 *
 * A `null` stored value (legacy row, or a row this ticket's migration never
 * touched) counts as stale on that field - there is nothing to compare
 * against, so the honest answer is "unverifiable", not "fresh". This is what
 * keeps a pre-JOB-51 row from being silently treated as endorsed: it is
 * eligible again and pending, exactly like a genuinely stale one.
 */
export function staleAnalysisFields(stored: StoredAnalysisIdentity, current: AnalysisIdentity): IdentityField[] {
  const stale: IdentityField[] = [];
  for (const field of Object.keys(FIELD_TO_KEY) as IdentityField[]) {
    const key = FIELD_TO_KEY[field];
    const storedValue = stored[key];
    if (storedValue == null || storedValue !== current[key]) stale.push(field);
  }
  return stale;
}
