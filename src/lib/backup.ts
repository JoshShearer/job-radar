import Database from "better-sqlite3";
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Backup creation and retention.
 *
 * Lives here rather than in cli.ts for two reasons. It is a decision about
 * protecting (and deleting) the user's data, so it belongs somewhere a test
 * can reach it - and importing cli.ts to test it runs the argument parser,
 * which in a test process parses vitest's own argv and exits.
 */

export interface SnapshotResult {
  /** Final path of the verified snapshot - only ever `destPath` on success. */
  path: string;
  /** Size in bytes of the verified snapshot file. */
  bytes: number;
}

/**
 * Create a verified, consistent snapshot of `sourceDb` at `destPath`.
 *
 * `migrate` and `backup` both used to do this by hand: `wal_checkpoint`,
 * `closeDb()`, then `copyFileSync`. That sequence is not coordinated with
 * anything else that might hold the database open - a concurrent writer
 * between the checkpoint and the copy produces a file that looks like a
 * backup and is actually inconsistent (JOB-55). `Database#backup()` wraps
 * SQLite's Online Backup API instead, which is built for exactly this: it
 * takes its own lock for the duration of each page copy rather than for the
 * whole operation, so a reader or writer on `sourceDb` can keep going while
 * this runs, and the destination file it produces is a valid, internally
 * consistent snapshot regardless. That is why the source connection is never
 * closed here - staying open while it works is the point.
 *
 * The snapshot is written to `${destPath}.tmp` and verified with
 * `PRAGMA integrity_check` on a fresh read-only connection before being
 * renamed into place. A snapshot that fails partway - a full disk, a killed
 * process - must never replace a known-good backup already at `destPath`,
 * and the caller must not prune old backups until this resolves
 * successfully (AC#3): renaming only on success is what makes both true.
 *
 * The source database is in WAL mode (JOB-55 assumes `openDb()`'s default),
 * and that setting lives in the copied file's own header, not in the
 * connection - so the verification connection opened on `tmpPath` picks it
 * up too, and SQLite creates `-wal`/`-shm` sidecars for it the moment
 * anything opens it, even read-only. Left alone those sidecars would sit
 * next to `destPath.tmp` forever with the `.tmp` name baked in, since
 * `renameSync` only moves the one file asked of it. They are safe to delete
 * once the check connection is closed - `PRAGMA integrity_check` writes
 * nothing - so this cleans them up rather than leaving accumulating junk in
 * the backup directory on every run.
 */
export async function createSnapshot(sourceDb: Database.Database, destPath: string): Promise<SnapshotResult> {
  const tmpPath = `${destPath}.tmp`;
  removeIfExists(tmpPath);
  removeWalSidecars(tmpPath);

  try {
    await sourceDb.backup(tmpPath);
    verifyIntegrity(tmpPath);
    removeWalSidecars(tmpPath);
    const bytes = statSync(tmpPath).size;
    renameSync(tmpPath, destPath);
    return { path: destPath, bytes };
  } catch (err) {
    removeIfExists(tmpPath);
    removeWalSidecars(tmpPath);
    throw err;
  }
}

/**
 * `PRAGMA integrity_check` on its own connection to `path`, never the live
 * one. Byte-size alone does not prove a valid SQLite file - a snapshot that
 * is the right size but internally corrupt is exactly the failure mode this
 * ticket asks to catch - and a size comparison against the source is now
 * advisory at best: the Online Backup API produces a valid, consistent
 * snapshot of a WAL-mode source, not a byte-identical copy of it, so the two
 * files can legitimately differ in size even when both are fine.
 */
function verifyIntegrity(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const ok = rows.length === 1 && rows[0]?.integrity_check === "ok";
    if (!ok) {
      throw new Error(`snapshot failed integrity_check: ${rows.map((r) => r.integrity_check).join("; ")}`);
    }
  } finally {
    db.close();
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/** See the note on `createSnapshot` about why WAL-mode sidecars appear at all. */
function removeWalSidecars(path: string): void {
  removeIfExists(`${path}-wal`);
  removeIfExists(`${path}-shm`);
}

/** Backup files, newest last. Named so a lexical sort is a chronological one. */
export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^job-radar-.*\.sqlite$/.test(f))
    .sort();
}

/**
 * Delete all but the newest `keep` backups. Returns what it removed.
 *
 * Sorting is lexical, which is chronological here because the timestamp is
 * ISO-8601 with the punctuation swapped for hyphens. That is a property of the
 * filename format above, so the two must not drift apart.
 */
export function pruneBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  if (all.length <= keep) return [];
  const doomed = all.slice(0, all.length - keep);
  for (const f of doomed) unlinkSync(resolve(dir, f));
  return doomed;
}
