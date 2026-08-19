import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/db/schema.js";
import { applyColumnMigrations } from "../../src/db/index.js";
import { JobRepo } from "../../src/db/repo.js";
import { normalizeForIdentity } from "../../src/lib/hash.js";

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
  }> = {},
): string {
  seq += 1;
  const id = over.id ?? `job${seq}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (
       id, dedupe_key, external_id, source, source_url, company, company_normalized,
       title, title_normalized, date_discovered, first_seen, last_seen, description_hash,
       status, status_changed_at, application_roi, fit_score, priority, filter_passed
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
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
