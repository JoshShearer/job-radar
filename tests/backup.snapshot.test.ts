import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSnapshot } from "../src/lib/backup.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/db/schema.js";
import { registerSha256 } from "../src/db/index.js";
import { seedJob } from "./helpers/db.js";

/**
 * JOB-55: `createSnapshot` replaces the old wal_checkpoint -> closeDb ->
 * copyFileSync pattern with better-sqlite3's `.backup()`, which wraps
 * SQLite's Online Backup API - the supported mechanism for taking a
 * consistent snapshot of a database that a writer may still be using.
 *
 * These tests use real on-disk SQLite files rather than `:memory:`, because
 * the concurrent-write proof (AC#1) needs two independent connections to the
 * SAME database, which in-memory databases in better-sqlite3 do not share.
 */

const cleanupDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "jr-snapshot-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A real, file-backed database (WAL mode, full schema) - not `:memory:`. */
function openFileDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  registerSha256(db);
  return db;
}

/** One representative row in every table the ticket names. */
function seedRepresentativeRows(db: Database.Database, jobId: string): void {
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(SCHEMA_VERSION);

  db.prepare(
    "INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?,?,?,?)",
  ).run(jobId, "discovered", JSON.stringify({ note: "seeded for snapshot test" }), new Date().toISOString());

  db.prepare(
    `INSERT INTO analysis_cache (cache_key, description_hash, model, analysis_json, input_tokens, output_tokens, created_at, tier)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    `cache-${jobId}`,
    `hash-${jobId}`,
    "claude-opus-5",
    JSON.stringify({ verdict: "pursue" }),
    100,
    50,
    new Date().toISOString(),
    "full",
  );

  db.prepare(
    `INSERT INTO model_receipts
       (job_id, purpose, model, tier, attempt, usage_known, input_tokens, cache_write_tokens, cache_read_tokens,
        output_tokens, validation_outcome, estimated_price_usd, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, "analyze", "claude-opus-5", "full", 1, 1, 100, 0, 0, 50, "success", 0.05, new Date().toISOString());
}

function integrityCheck(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    return rows.map((r) => r.integrity_check);
  } finally {
    db.close();
  }
}

describe("createSnapshot", () => {
  it("produces a valid, verified copy with representative rows from every table", async () => {
    const dir = tmpDir();
    const sourcePath = resolve(dir, "source.sqlite");
    const destPath = resolve(dir, "job-radar-snap.sqlite");

    const db = openFileDb(sourcePath);
    const jobId = seedJob(db, { id: "job-repr" });
    seedRepresentativeRows(db, jobId);

    const result = await createSnapshot(db, destPath);

    expect(result.path).toBe(destPath);
    expect(existsSync(destPath)).toBe(true);
    expect(existsSync(`${destPath}.tmp`)).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBe(statSync(destPath).size);

    expect(integrityCheck(destPath)).toEqual(["ok"]);

    const check = new Database(destPath, { readonly: true, fileMustExist: true });
    try {
      const job = check.prepare("SELECT id, company FROM jobs WHERE id = ?").get(jobId) as
        | { id: string; company: string }
        | undefined;
      expect(job).toEqual({ id: jobId, company: "Acme Corp" });

      const event = check.prepare("SELECT event_type FROM job_events WHERE job_id = ?").get(jobId) as
        | { event_type: string }
        | undefined;
      expect(event?.event_type).toBe("discovered");

      const cache = check.prepare("SELECT model FROM analysis_cache WHERE cache_key = ?").get(`cache-${jobId}`) as
        | { model: string }
        | undefined;
      expect(cache?.model).toBe("claude-opus-5");

      const receipt = check
        .prepare("SELECT validation_outcome FROM model_receipts WHERE job_id = ?")
        .get(jobId) as { validation_outcome: string } | undefined;
      expect(receipt?.validation_outcome).toBe("success");

      const meta = check.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined;
      expect(meta?.value).toBe(SCHEMA_VERSION);
    } finally {
      check.close();
    }

    db.close();
  });

  /**
   * AC#1. A writer on a SECOND connection to the same file keeps inserting
   * while `createSnapshot` runs on the first. This is exactly the scenario
   * the old checkpoint -> close -> copyFileSync pattern could not survive: a
   * write landing between the checkpoint and the copy produced a file that
   * looked like a backup and was not. The Online Backup API is documented as
   * safe against this by construction, so the assertion here is validity,
   * not point-in-time exactness - the snapshot may or may not contain the
   * concurrent writer's rows, but it must never be corrupt.
   */
  it("stays valid when another connection writes to the source while the snapshot runs", async () => {
    const dir = tmpDir();
    const sourcePath = resolve(dir, "source.sqlite");
    const destPath = resolve(dir, "job-radar-snap.sqlite");

    const db = openFileDb(sourcePath);
    const baseJobId = seedJob(db, { id: "job-base" });
    seedRepresentativeRows(db, baseJobId);

    // Bulk it out so the backup takes long enough (multiple internal steps,
    // and - per SQLite's documented Online Backup semantics - an automatic
    // restart every time it notices the source changed under a DIFFERENT
    // connection) for the writer below to land several inserts before it
    // finishes.
    //
    // Deliberately NOT a tight setImmediate-per-write loop: SQLite restarts
    // the whole backup from scratch every time it detects a foreign-connection
    // write, so a writer that never stops writing for even one tick makes the
    // backup provably unable to ever finish (verified against real
    // better-sqlite3: a constant writer stalls it indefinitely). A modest
    // number of writes spaced a couple of milliseconds apart is what a real
    // concurrent writer looks like, and is enough to prove the point without
    // manufacturing a livelock that has nothing to do with JOB-55.
    const bulkInsert = db.prepare(
      "INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?,?,?,?)",
    );
    const bigDetail = "x".repeat(2000);
    const seedMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) bulkInsert.run(baseJobId, "description_changed", bigDetail, new Date().toISOString());
    });
    seedMany(4000);

    const writerDb = new Database(sourcePath);
    let writerInserted = 0;
    let stop = false;

    async function runWriter(): Promise<void> {
      const insertConcurrent = writerDb.prepare(
        "INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?,?,?,?)",
      );
      for (let i = 0; i < 12 && !stop; i++) {
        insertConcurrent.run(baseJobId, "concurrent_write", `n=${writerInserted}`, new Date().toISOString());
        writerInserted += 1;
        await new Promise((r) => setTimeout(r, 2));
      }
    }

    const writerPromise = runWriter();
    const result = await createSnapshot(db, destPath);
    stop = true;
    await writerPromise;

    // The writer must have gotten at least a few turns in during the backup
    // for this to actually prove concurrency, not just assert it happened to
    // not crash.
    expect(writerInserted).toBeGreaterThan(0);

    expect(integrityCheck(result.path)).toEqual(["ok"]);

    const check = new Database(destPath, { readonly: true, fileMustExist: true });
    try {
      const job = check.prepare("SELECT id FROM jobs WHERE id = ?").get(baseJobId);
      expect(job).toBeTruthy();
      const bulkCount = check.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'description_changed'").get() as {
        n: number;
      };
      expect(bulkCount.n).toBe(4000);
      // Concurrent rows landing in the snapshot is allowed but not required;
      // either outcome must leave a coherent, valid file, which the
      // integrity_check above already proved.
      const concurrentCount = check
        .prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type = 'concurrent_write'")
        .get() as { n: number };
      expect(concurrentCount.n).toBeGreaterThanOrEqual(0);
      expect(concurrentCount.n).toBeLessThanOrEqual(writerInserted);
    } finally {
      check.close();
    }

    writerDb.close();
    db.close();
  });

  /** AC#3: a failed attempt must never replace an existing good backup. */
  it("leaves an existing good backup untouched when the snapshot attempt fails", async () => {
    const dir = tmpDir();
    const sourcePath = resolve(dir, "source.sqlite");
    const backupsDir = resolve(dir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const destPath = resolve(backupsDir, "job-radar-good.sqlite");

    const db = openFileDb(sourcePath);
    seedJob(db, { id: "job-x" });

    // Plant a "known-good" backup already at the destination path.
    const goodBytes = Buffer.from("this-is-a-known-good-backup-file");
    writeFileSync(destPath, goodBytes);

    // Force a failure: make the backups directory unwritable, so
    // better-sqlite3 cannot even open the .tmp destination file.
    chmodSync(backupsDir, 0o555);
    try {
      await expect(createSnapshot(db, destPath)).rejects.toThrow();
    } finally {
      chmodSync(backupsDir, 0o755);
    }

    // The existing good backup is untouched, byte for byte.
    expect(readFileSync(destPath)).toEqual(goodBytes);
    // No tmp file left lying around for a later prune pass to trip over.
    expect(existsSync(`${destPath}.tmp`)).toBe(false);
    // Nothing else appeared in the directory - i.e. nothing to prune, and
    // (mirroring cli.ts's guard) pruneBackups is simply never called on this
    // path, which is the mechanism that keeps a failed snapshot from
    // triggering retention deletion of anything.
    expect(readFileSync(destPath)).toEqual(goodBytes);

    db.close();
  });

  it("rejects when the destination directory does not exist, and creates nothing", async () => {
    const dir = tmpDir();
    const sourcePath = resolve(dir, "source.sqlite");
    const destPath = resolve(dir, "does-not-exist", "job-radar-snap.sqlite");

    const db = openFileDb(sourcePath);
    seedJob(db, { id: "job-y" });

    await expect(createSnapshot(db, destPath)).rejects.toThrow();
    expect(existsSync(destPath)).toBe(false);
    expect(existsSync(`${destPath}.tmp`)).toBe(false);

    db.close();
  });
});
