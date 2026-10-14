import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.js";

export type DB = Database.Database;

/**
 * Open a database and bring it to the current schema. Each migration and its
 * completion marker commit together, so a crash mid-migration leaves the
 * database exactly as it was and the next open retries it whole.
 */
export function openDatabase(file: string, at: () => string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, at);
  return db;
}

export function migrate(db: DB, at: () => string): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migration").all() as { version: number }[]).map((r) => r.version));
  const ran: number[] = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, at());
    })();
    ran.push(m.version);
  }
  return ran;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migration").get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * A consistent snapshot while other connections may be writing, via SQLite's
 * Online Backup API. The copy is opened and integrity-checked before it is
 * reported as a backup: a truncated or corrupt copy is worse than none,
 * because it looks like one.
 */
export async function backupDatabase(db: DB, dest: string): Promise<{ bytes: number }> {
  mkdirSync(dirname(dest), { recursive: true });
  await db.backup(dest);
  const copy = new Database(dest, { readonly: true });
  try {
    const check = copy.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new Error(`backup failed integrity_check: ${String(check)}`);
    const tables = copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
    if (tables.n === 0) throw new Error("backup contains no tables");
  } finally {
    copy.close();
  }
  return { bytes: statSync(dest).size };
}
