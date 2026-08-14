import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWatchedFile,
  rebuildCommand,
  snapshotsDiffer,
  takeSnapshot,
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
