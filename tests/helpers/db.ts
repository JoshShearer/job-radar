import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { applyColumnMigrations, registerSha256 } from "../../src/db/index.js";
import { JobRepo } from "../../src/db/repo.js";
import { normalizeForIdentity, sha256 } from "../../src/lib/hash.js";
import type { Analysis } from "../../src/model/job.js";

/**
 * An isolated in-memory repo.
 *
 * Deliberately constructs the Database directly rather than calling `openDb`:
 * that function memoises a single handle per process and ignores the file
 * argument on every call after the first, so two test files asking for
 * ":memory:" would silently share one database - and, worse, could end up
 * pointed at the developer's real one.
 */
export function memoryRepo(): { repo: JobRepo; db: Database.Database } {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  // The SAME registration production uses (`registerSha256`), not a lookalike
  // - `needingAnalysis`/`eligibleForAnalysis` compare a stored snapshot hash
  // against `sha256(...)` computed in SQL, and a test-only reimplementation
  // that drifted from `src/lib/hash.ts` would pass here and fail in production.
  registerSha256(db);
  // Migrations too, or tests run against a different schema than production
  // and any query touching a migrated column fails only in tests.
  applyColumnMigrations(db);
  return { repo: new JobRepo(db), db };
}

let seq = 0;

/** Insert a job row directly, filling in the columns the schema requires. */
export function seedJob(
  db: Database.Database,
  over: Partial<{
    id: string;
    company: string;
    companyNormalized: string;
    title: string;
    status: string;
    statusChangedAt: string | null;
    applicationRoi: number | null;
    fitScore: number | null;
    priority: string | null;
    // JOB-51: only overridden by tests exercising the identity/staleness
    // machinery. Every other seeded job gets the same schema defaults
    // `matchingIdentityHashes()` below assumes when neither is passed a
    // matching override.
    location: string;
    remoteStatus: string;
    employmentType: string;
    salaryMin: number | null;
    salaryMax: number | null;
    salaryCurrency: string;
    salaryPeriod: string | null;
  }> = {},
): string {
  seq += 1;
  const id = over.id ?? `job${seq}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (
       id, dedupe_key, external_id, source, source_url, company, company_normalized,
       title, title_normalized, location, remote_status, employment_type,
       salary_min, salary_max, salary_currency, salary_period,
       date_discovered, first_seen, last_seen, description_hash,
       status, status_changed_at, application_roi, fit_score, priority, filter_passed
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  ).run(
    id,
    `dedupe-${id}`,
    `ext-${id}`,
    "greenhouse",
    `https://example.test/${id}`,
    over.company ?? "Acme Corp",
    // The real normalizer, not a lookalike: a fixture that normalizes
    // differently from production would let a query bug pass here and fail on
    // the actual database.
    over.companyNormalized ?? normalizeForIdentity(over.company ?? "Acme Corp"),
    over.title ?? "Staff Engineer",
    (over.title ?? "Staff Engineer").toLowerCase(),
    over.location ?? "",
    over.remoteStatus ?? "unknown",
    over.employmentType ?? "unknown",
    over.salaryMin ?? null,
    over.salaryMax ?? null,
    over.salaryCurrency ?? "USD",
    over.salaryPeriod ?? null,
    now,
    now,
    now,
    `hash-${id}`,
    over.status ?? "NEW",
    over.statusChangedAt === undefined ? now : over.statusChangedAt,
    over.applicationRoi ?? 50,
    over.fitScore ?? 80,
    over.priority ?? "B",
  );
  return id;
}

/**
 * A fixed stand-in for `sha256(buildSystemPrompt(profile))`
 * (`AnalysisIdentity.evidenceHash`, src/analysis/identity.ts), so tests that
 * only care about title/location/employment/compensation staleness do not
 * need to build a full `CareerProfile` just to hash its system prompt.
 *
 * Pass this SAME string as `currentEvidenceHash` to `needingAnalysis` /
 * `eligibleForAnalysis` wherever a test wants "the standing snapshot still
 * matches" to be true on the evidence axis specifically.
 */
export const TEST_EVIDENCE_HASH = "test-evidence-hash-v1";

/**
 * The identity snapshot hashes that match a job row's CURRENT
 * title/location/employment/compensation exactly - i.e. what `saveAnalysis`
 * would have written had the analysis been formed against today's values.
 *
 * Reads the row back rather than trusting the caller's `seedJob` overrides,
 * so it can never drift from what the eligibility SQL in
 * `STALE_OR_UNANALYZED_SQL` (src/db/repo.ts) actually compares against.
 */
export function matchingIdentityHashes(
  db: Database.Database,
  jobId: string,
  evidenceHash: string = TEST_EVIDENCE_HASH,
): {
  titleHash: string;
  locationHash: string;
  employmentHash: string;
  compensationHash: string;
  evidenceHash: string;
} {
  const row = db
    .prepare(
      `SELECT title, location, remote_status, employment_type,
              salary_min, salary_max, salary_currency, salary_period
         FROM jobs WHERE id = ?`,
    )
    .get(jobId) as {
    title: string;
    location: string;
    remote_status: string;
    employment_type: string;
    salary_min: number | null;
    salary_max: number | null;
    salary_currency: string;
    salary_period: string | null;
  };
  return {
    titleHash: sha256(row.title),
    locationHash: sha256(`${row.location}|${row.remote_status}`),
    employmentHash: sha256(row.employment_type),
    compensationHash: sha256(
      `${row.salary_min ?? ""}|${row.salary_max ?? ""}|${row.salary_currency}|${row.salary_period ?? ""}`,
    ),
    evidenceHash,
  };
}

/**
 * Mark a job analyzed with a FRESH, matching identity snapshot - the way
 * `saveAnalysis` does when the analysis was just formed against the job's
 * current inputs. The counterpart to `seedJob` + a raw `UPDATE ... SET
 * analysis_json` (which simulates a LEGACY row instead - see
 * `tests/analysis.selection.test.ts`).
 */
export function saveAnalysisFresh(
  repo: JobRepo,
  db: Database.Database,
  jobId: string,
  analysis: Analysis,
  model = "claude-opus-5",
): void {
  repo.saveAnalysis(jobId, analysis, model, matchingIdentityHashes(db, jobId));
}

/**
 * An ISO timestamp `days` before `from`, which defaults to the real clock.
 *
 * PASS `from` WHENEVER THE CODE UNDER TEST IS GIVEN A PINNED `now`. Mixing the
 * two is a test that passes on the day it is written and fails later:
 * `tests/dashboard.test.ts` pinned `now` to 2026-08-14 and seeded ages from
 * `Date.now()`, so a row seeded 32 days old measured 32 days on the day it was
 * written and 29 three days later, at which point it stopped counting as
 * ghosted and the suite went red with nothing having changed.
 */
export function daysBefore(from: Date, days: number): string {
  return new Date(from.getTime() - days * 86400000).toISOString();
}

/** An ISO timestamp `days` before now. Only safe when the test does not pin a clock. */
export function daysAgo(days: number): string {
  return daysBefore(new Date(), days);
}
