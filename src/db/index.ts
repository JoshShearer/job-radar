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

export function closeDb(): void {
  handle?.close();
  handle = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
