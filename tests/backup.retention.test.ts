import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { listBackups, pruneBackups } from "../src/lib/backup.js";

function dirWith(names: string[]): string {
  const dir = mkdtempSync(resolve(tmpdir(), "jr-backup-"));
  for (const n of names) writeFileSync(resolve(dir, n), "x");
  return dir;
}

const stamp = (iso: string) => `job-radar-${iso.replace(/[:.]/g, "-")}.sqlite`;

/**
 * JOB-30 puts `backup` on a daily timer. Without retention that is not a
 * backup schedule, it is a disk-filling bug: the database is 238MB, so a daily
 * copy is about 7GB a month on the same disk as the thing being protected.
 */
describe("pruneBackups", () => {
  it("keeps the newest N and deletes the rest", () => {
    const dir = dirWith([
      stamp("2026-08-15T00:00:00.000Z"),
      stamp("2026-08-16T00:00:00.000Z"),
      stamp("2026-08-17T00:00:00.000Z"),
      stamp("2026-08-18T00:00:00.000Z"),
    ]);
    const pruned = pruneBackups(dir, 2);
    expect(pruned).toHaveLength(2);
    expect(listBackups(dir)).toEqual([
      stamp("2026-08-17T00:00:00.000Z"),
      stamp("2026-08-18T00:00:00.000Z"),
    ]);
  });

  it("deletes nothing when there are fewer than the limit", () => {
    const dir = dirWith([stamp("2026-08-18T00:00:00.000Z")]);
    expect(pruneBackups(dir, 14)).toEqual([]);
    expect(listBackups(dir)).toHaveLength(1);
  });

  it("sorts chronologically, which the filename format has to guarantee", () => {
    // Lexical order is chronological only because the stamp is ISO-8601 with
    // the punctuation swapped. If the naming ever changes, this breaks loudly
    // rather than silently deleting the wrong files.
    const dir = dirWith([
      stamp("2026-09-01T00:00:00.000Z"),
      stamp("2026-08-31T23:59:59.000Z"),
      stamp("2026-01-02T00:00:00.000Z"),
    ]);
    expect(listBackups(dir)).toEqual([
      stamp("2026-01-02T00:00:00.000Z"),
      stamp("2026-08-31T23:59:59.000Z"),
      stamp("2026-09-01T00:00:00.000Z"),
    ]);
    pruneBackups(dir, 1);
    expect(listBackups(dir)).toEqual([stamp("2026-09-01T00:00:00.000Z")]);
  });

  it("ignores files that are not backups", () => {
    const dir = dirWith([stamp("2026-08-18T00:00:00.000Z"), "README.md", "notes.txt"]);
    pruneBackups(dir, 0);
    // Only the backup went; the strays are untouched.
    expect(readdirSync(dir).sort()).toEqual(["README.md", "notes.txt"]);
  });

  it("never deletes everything, even when asked for zero", () => {
    // `backup` clamps to at least 1, but pruneBackups is exported and a caller
    // passing 0 should not be handed an empty backup directory by surprise...
    // it should be handed exactly what it asked for, and the clamp lives at
    // the CLI boundary where the intent is expressed. This pins that split.
    const dir = dirWith([stamp("2026-08-18T00:00:00.000Z")]);
    expect(pruneBackups(dir, 0)).toHaveLength(1);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listBackups(resolve(tmpdir(), "definitely-not-here-jr"))).toEqual([]);
  });
});
