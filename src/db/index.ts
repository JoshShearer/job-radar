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
];

function applyColumnMigrations(db: DB): void {
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === m.column)) continue;
    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
    log.debug(`migration: added ${m.table}.${m.column}`);
  }
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
