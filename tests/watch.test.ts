import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isWatchedFile,
  rebuildCommand,
  snapshotsDiffer,
  startDashboardWatcher,
  takeSnapshot,
  watchedDataFiles,
  WATCHED_DIRS,
} from "../src/report/watch.js";

describe("isWatchedFile", () => {
  it("rebuilds for a source file", () => {
    expect(isWatchedFile("dashboard.ts")).toBe(true);
    expect(isWatchedFile("report/dashboard.ts")).toBe(true);
    expect(isWatchedFile("funnel.ts")).toBe(true);
  });

  it("ignores the noise editors write next to the file being saved", () => {
    // A watcher that fires on these rebuilds three or four times per save.
    expect(isWatchedFile(".dashboard.ts.swp")).toBe(false);
    expect(isWatchedFile(".#dashboard.ts")).toBe(false);
    expect(isWatchedFile("dashboard.ts~")).toBe(false);
    expect(isWatchedFile("4913")).toBe(false);
  });

  it("ignores tests, which do not change what is rendered", () => {
    expect(isWatchedFile("dashboard.test.ts")).toBe(false);
  });

  it("ignores anything that is not TypeScript", () => {
    expect(isWatchedFile("notes.md")).toBe(false);
    expect(isWatchedFile("data.json")).toBe(false);
    expect(isWatchedFile("")).toBe(false);
    expect(isWatchedFile(null)).toBe(false);
    expect(isWatchedFile(undefined)).toBe(false);
  });
});

describe("rebuildCommand", () => {
  it("re-invokes with the loader flags this process was started with", () => {
    // The rebuild has to be a fresh process. This one already has the module
    // graph loaded, so re-running buildDashboard in-process after editing
    // dashboard.ts would execute the code from before the edit and report
    // success. Carrying execArgv is what makes the new process able to load
    // TypeScript the same way.
    const { command, argv } = rebuildCommand();
    expect(command).toBe(process.execPath);
    for (const flag of process.execArgv) expect(argv).toContain(flag);
    expect(argv[argv.length - 1]).toBe("dashboard");
  });

  it("passes through a different subcommand", () => {
    expect(rebuildCommand(["daily", "--no-ingest"]).argv.slice(-2)).toEqual(["daily", "--no-ingest"]);
  });
});

describe("change detection", () => {
  let root: string;

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "job-radar-watch-"));
    mkdirSync(join(root, "src", "report"), { recursive: true });
    writeFileSync(join(root, "src", "report", "dashboard.ts"), "export const a = 1;\n");
    return takeSnapshot(["src/report"], root);
  };

  const cleanup = () => rmSync(root, { recursive: true, force: true });

  // The bug that made this poll-based instead of fs.watch-based. sed -i, vim,
  // and most editors save by writing a temp file and renaming it over the
  // original. Node's recursive fs.watch on Linux stopped reporting a file after
  // that inode swap: the FIRST edit rebuilt and every later one silently did
  // not, which is worse than never working, because it teaches you to trust it.
  it("notices an edit that replaces the file by rename", () => {
    const before = setup();
    try {
      const target = join(root, "src", "report", "dashboard.ts");
      const tmp = join(root, "src", "report", "sedXYZ");
      writeFileSync(tmp, "export const a = 2;\n");
      renameSync(tmp, target); // new inode, same path

      expect(snapshotsDiffer(before, takeSnapshot(["src/report"], root))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("notices repeated edits, not just the first", () => {
    let snap = setup();
    try {
      const target = join(root, "src", "report", "dashboard.ts");
      for (let i = 2; i <= 4; i++) {
        const tmp = join(root, "src", "report", `sed${i}`);
        writeFileSync(tmp, `export const a = ${i};\n`);
        renameSync(tmp, target);
        const next = takeSnapshot(["src/report"], root);
        expect(snapshotsDiffer(snap, next), `edit ${i}`).toBe(true);
        snap = next;
      }
    } finally {
      cleanup();
    }
  });

  it("reports nothing when nothing changed", () => {
    const before = setup();
    try {
      expect(snapshotsDiffer(before, takeSnapshot(["src/report"], root))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("notices a new file and a deleted one", () => {
    const before = setup();
    try {
      const added = join(root, "src", "report", "extra.ts");
      writeFileSync(added, "export const b = 1;\n");
      const withExtra = takeSnapshot(["src/report"], root);
      expect(snapshotsDiffer(before, withExtra)).toBe(true);

      rmSync(added);
      expect(snapshotsDiffer(withExtra, takeSnapshot(["src/report"], root))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("ignores files it does not watch", () => {
    const before = setup();
    try {
      writeFileSync(join(root, "src", "report", "notes.md"), "hello");
      writeFileSync(join(root, "src", "report", "dashboard.test.ts"), "// test");
      writeFileSync(join(root, "src", "report", ".dashboard.ts.swp"), "swap");

      expect(snapshotsDiffer(before, takeSnapshot(["src/report"], root))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("notices a same-size edit, because the timestamp moves", () => {
    const before = setup();
    try {
      const target = join(root, "src", "report", "dashboard.ts");
      writeFileSync(target, "export const a = 9;\n"); // identical length
      const later = new Date(Date.now() + 2000);
      utimesSync(target, later, later);

      expect(snapshotsDiffer(before, takeSnapshot(["src/report"], root))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("survives a directory that does not exist", () => {
    expect(() => takeSnapshot(["src/does-not-exist"], tmpdir())).not.toThrow();
    expect(takeSnapshot(["src/does-not-exist"], tmpdir()).size).toBe(0);
  });
});

describe("WATCHED_DIRS", () => {
  it("covers every directory the dashboard reads from", () => {
    // dashboard.ts imports from report/, stats/, model/ and db/. A directory
    // missing here is an edit that silently does not rebuild.
    expect(WATCHED_DIRS).toContain("src/report");
    expect(WATCHED_DIRS).toContain("src/stats");
    expect(WATCHED_DIRS).toContain("src/model");
    expect(WATCHED_DIRS).toContain("src/db");
  });
});

/**
 * JOB-15. Five applications were submitted, all five moved to APPLIED in the
 * database, and `npm run dev` served the same stale dashboard indefinitely.
 *
 * The watcher looked only at `.ts` files in source directories, so the one file
 * that changes when the tool is actually used was outside every watched
 * directory AND excluded by the extension filter. A stale dashboard is worse
 * than no dashboard: it answers "is this working" confidently, with old
 * numbers, and nothing on the page says so.
 */
describe("watching the database", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "job-radar-watch-db-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("notices a write to the database", () => {
    const db = resolve(dir, "job-radar.sqlite");
    writeFileSync(db, "sqlite-bytes");

    const before = takeSnapshot([], dir, [db]);
    expect(before.size).toBe(1);

    writeFileSync(db, "sqlite-bytes-plus-one-more-application");
    expect(snapshotsDiffer(before, takeSnapshot([], dir, [db]))).toBe(true);
  });

  it("notices a write that lands in the WAL sidecar first", () => {
    // SQLite runs in WAL mode, so a write can be in -wal before the main
    // file's mtime moves.
    const db = resolve(dir, "job-radar.sqlite");
    const wal = `${db}-wal`;
    writeFileSync(db, "sqlite-bytes");

    const before = takeSnapshot([], dir, [db, wal]);
    writeFileSync(wal, "pending write");
    expect(snapshotsDiffer(before, takeSnapshot([], dir, [db, wal]))).toBe(true);
  });

  it("does not treat a missing WAL sidecar as a change", () => {
    const db = resolve(dir, "job-radar.sqlite");
    const wal = `${db}-wal`;
    writeFileSync(db, "sqlite-bytes");

    const a = takeSnapshot([], dir, [db, wal]);
    const b = takeSnapshot([], dir, [db, wal]);
    expect(a.size).toBe(1); // only the file that exists
    expect(snapshotsDiffer(a, b)).toBe(false);
  });

  it("watches the database even though it is not a .ts file", () => {
    // The extension filter exists to stop editor swap files causing rebuild
    // storms in source directories. It must not reach explicit data paths.
    expect(isWatchedFile("job-radar.sqlite")).toBe(false);
    const db = resolve(dir, "job-radar.sqlite");
    writeFileSync(db, "x");
    expect(takeSnapshot([], dir, [db]).size).toBe(1);
  });

  it("still ignores editor noise in the source directories", () => {
    const src = resolve(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(resolve(src, "dashboard.ts"), "export const a = 1;");
    writeFileSync(resolve(src, ".dashboard.ts.swp"), "swap");

    expect(takeSnapshot(["src"], dir, []).size).toBe(1);
  });

  it("respects a JOB_RADAR_DB override", () => {
    const custom = resolve(dir, "somewhere-else.sqlite");
    const previous = process.env.JOB_RADAR_DB;
    process.env.JOB_RADAR_DB = custom;
    try {
      expect(watchedDataFiles()).toContain(custom);
      expect(watchedDataFiles()).toContain(`${custom}-wal`);
    } finally {
      if (previous === undefined) delete process.env.JOB_RADAR_DB;
      else process.env.JOB_RADAR_DB = previous;
    }
  });
});

/**
 * The loop this nearly shipped with.
 *
 * Watching the database made the rebuild self-triggering: `dashboard` opens
 * SQLite, closing it checkpoints the WAL back into the main file, and the mtime
 * moves. With the snapshot taken before the rebuild rather than after, the next
 * tick reads the rebuild's own footprint as a new change. Measured at 26
 * rebuilds in 20 seconds - a watcher pegging a core forever, in a process a
 * developer leaves running all day.
 */
describe("the watcher does not trigger itself", () => {
  it("settles after one rebuild when the rebuild touches a watched file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "job-radar-selftrigger-"));
    const db = resolve(dir, "job-radar.sqlite");
    writeFileSync(db, "initial");

    let rebuilds = 0;
    const handle = startDashboardWatcher({
      dirs: [],
      files: [db],
      intervalMs: 60,
      onRebuild: () => {
        rebuilds++;
        // Stand in for what the real rebuild does to the database it read.
        writeFileSync(db, `rewritten ${rebuilds}`);
      },
    });

    try {
      writeFileSync(db, "a real change"); // one genuine edit
      await new Promise((r) => setTimeout(r, 1500));
      // One edit, one rebuild. Without the re-stamp this climbs without bound.
      expect(rebuilds).toBeLessThanOrEqual(2);
      expect(rebuilds).toBeGreaterThanOrEqual(1);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
