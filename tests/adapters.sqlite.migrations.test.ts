import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/adapters/sqlite/schema.js";
import { openDatabase, schemaVersion } from "../src/adapters/sqlite/db.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";

/** A database written before provider tracking migrates forward; its receipts read as the api, which is all that existed. */
describe("migration 2: model_call.provider", () => {
  it("upgrades a version-1 database, keeps its receipts, and reads them as api", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jr-mig-")), "jr.sqlite");
    const old = new Database(file);
    old.exec(MIGRATIONS.find((m) => m.version === 1)!.sql);
    old.exec("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    old.prepare("INSERT INTO schema_migration VALUES (1, 'initial', '2026-10-01T00:00:00.000Z')").run();
    old
      .prepare(
        `INSERT INTO model_call (run_id, purpose, subject_id, request_key, model, effort, reserved_usd, status, outcome, usage_known, actual_usd, created_at)
         VALUES (NULL, 'assess', 'opp-1', 'k1', 'claude-opus-5', 'medium', 0.5, 'settled', 'success', 1, 0.1, '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    old.close();

    const db = openDatabase(file, () => "2026-10-29T00:00:00.000Z");
    expect(schemaVersion(db)).toBe(2);
    const store = new SqliteStore(db);
    const [c] = store.modelCalls();
    expect(c!.provider).toBe("api");
    expect(c!.actualUsd).toBe(0.1);
    db.close();
  });
});
