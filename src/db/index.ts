import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import { paths } from "../config/load.js";
import { log } from "../lib/log.js";

export type DB = Database.Database;

let handle: DB | null = null;

/** Open (and migrate) the database. Idempotent within a process. */
export function openDb(file = paths.db()): DB {
  if (handle) return handle;
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  applyColumnMigrations(db);

  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(SCHEMA_VERSION);
    log.debug(`initialized database at ${file} (schema v${SCHEMA_VERSION})`);
  } else if (row.value !== SCHEMA_VERSION) {
    // CREATE TABLE IF NOT EXISTS above is additive-safe; a real breaking change
    // would need a migration step here. Record the bump so it is visible.
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(SCHEMA_VERSION);
    log.warn(`database schema version moved ${row.value} -> ${SCHEMA_VERSION}`);
  }

  handle = db;
  return db;
}

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema.ts creates new databases correctly but
 * does nothing to an existing one, so a column added later would be missing on
 * every database created before it. Each entry here is applied only if absent,
 * which makes startup idempotent and safe to run against an old file.
 *
 * Additive only. A destructive change needs a real versioned migration.
 */
const COLUMN_MIGRATIONS: { table: string; column: string; definition: string }[] = [
  // How the current fit/ROI numbers were arrived at:
  //   analyzed  - an LLM analysis backs them
  //   projected - deterministic, adjusted by the observed calibration bias
  //   raw       - deterministic, uncalibrated (not enough samples yet)
  { table: "jobs", column: "score_confidence", definition: "TEXT" },
  // The uncalibrated deterministic score, kept so calibration can be
  // recomputed later without re-deriving it.
  { table: "jobs", column: "raw_fit_score", definition: "REAL" },
  // Failed analysis attempts. Without these a malformed response was refused
  // correctly and then forgotten: the job stayed eligible, got re-selected on
  // the next pass, and was paid for again. The reason existed only as a warn
  // line in a console that had already scrolled away.
  { table: "jobs", column: "analysis_failures", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "jobs", column: "analysis_failure_reason", definition: "TEXT" },
  { table: "jobs", column: "analysis_failure_kind", definition: "TEXT" },
  { table: "jobs", column: "analysis_failed_at", definition: "TEXT" },
  // Which half of the analysis a cache row holds. Every pre-existing row was
  // written before `two_stage` was ever enabled, so 'full' is the provable
  // default, not a guess: lifetime SUM(stats_json.triageOnly) over `runs` is 0.
  { table: "analysis_cache", column: "tier", definition: "TEXT NOT NULL DEFAULT 'full'" },
];

/**
 * Exported so tests build the SAME schema production uses.
 *
 * `tests/helpers/db.ts` applied SCHEMA_SQL alone, so every in-memory test ran
 * against a database missing every migrated column. Any query touching one
 * failed with "no such column" in tests while working fine in production -
 * which is backwards, and meant `needingAnalysis` had no test at all.
 */
export function applyColumnMigrations(db: DB): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
    log.debug(`migration: added ${m.table}.${m.column}`);
  }
}

/**
 * Columns to physically remove, with the reason each is dead.
 *
 * SEPARATE FROM `COLUMN_MIGRATIONS` ON PURPOSE. That list is additive-only by
 * rule, and it runs from `openDb()` - on the hot path of every command and
 * every test. A destructive change must never run there: it has to be
 * deliberate, backed up first, and followed by a VACUUM that cannot execute
 * inside a transaction. So this list is applied only by `job-radar migrate`.
 */
const DESTRUCTIVE_MIGRATIONS: { table: string; column: string; why: string }[] = [
  // 114 MB, written on every ingest and never read once. The only references
  // were the write path, the type, the 200 KB truncation, and the row mapper -
  // no query, no scorer, no filter, no report. `deploy/job-radar-daily.service`
  // backs the database up daily, so it was paid for every day, forever.
  { table: "jobs", column: "description_raw", why: "written but never read (114 MB)" },
];

/**
 * Physically drop dead columns. Destructive, explicit, never automatic.
 *
 * Guarded by `PRAGMA table_info` so it is idempotent and a no-op on a database
 * created after the column was removed from `schema.ts`.
 *
 * `ALTER TABLE ... DROP COLUMN` needs SQLite 3.35+; the bundled better-sqlite3
 * is 3.53.4. It refuses on an indexed column, so anything added here must be
 * checked against `sqlite_master` first.
 */
export function applyDestructiveMigrations(db: DB): string[] {
  const dropped: string[] = [];
  for (const m of DESTRUCTIVE_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} DROP COLUMN ${m.column}`);
    dropped.push(`${m.table}.${m.column} - ${m.why}`);
    log.debug(`destructive migration: dropped ${m.table}.${m.column}`);
  }
  return dropped;
}

/**
 * One-off data cleanups, applied by `migrate` alongside the schema changes.
 *
 * These are historical by nature - each entry names a specific mess and the
 * fix that stopped it recurring - so a hardcoded date here is a fact about
 * what happened, not a magic number.
 */
export function applyDataCleanups(db: DB): string[] {
  const done: string[] = [];

  // 1,098 `dashboard` rows written on 2026-08-14 by a rebuild loop: each
  // watcher-triggered render wrote a run row, which grew the database file,
  // which the watcher saw as a data change, which triggered another render.
  // The mechanism is already fixed by JOB_RADAR_NO_RUN_LOG (src/cli.ts) and
  // exactly one legitimate dashboard run has been logged since, on 2026-08-20
  // - which the date bound deliberately keeps. This is cleanup, not a fix.
  const purged = db
    .prepare("DELETE FROM runs WHERE command = 'dashboard' AND started_at < '2026-08-20'")
    .run();
  if (purged.changes > 0) done.push(`purged ${purged.changes} runaway dashboard run row(s)`);

  return done;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
