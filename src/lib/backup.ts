import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Backup retention.
 *
 * Lives here rather than in cli.ts for two reasons. It is a decision about
 * deleting the user's data, so it belongs somewhere a test can reach it - and
 * importing cli.ts to test it runs the argument parser, which in a test
 * process parses vitest's own argv and exits.
 */

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
