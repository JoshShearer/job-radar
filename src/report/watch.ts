import { readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { PROJECT_ROOT } from "../config/load.js";
import { log } from "../lib/log.js";

/**
 * Rebuild-on-change for the generated pages.
 *
 * The manual loop is edit, `npm run cli -- dashboard`, refresh. This removes
 * the middle step. It is a development convenience and nothing else: it
 * regenerates the same file the same command does, and adds no capability the
 * CLI does not already have.
 *
 * Only the **dashboard** is rebuilt. The briefing goes through `daily`, which
 * re-scores the whole index and takes about ten seconds against a real
 * database; the dashboard is a pure read and takes about one. A watch loop that
 * pauses for ten seconds on every save is not a watch loop.
 *
 * ## Why polling rather than fs.watch
 *
 * `fs.watch(dir, { recursive: true })` was the obvious implementation and it
 * silently half-worked. Measured on Linux/Node 24: the first edit to a file
 * rebuilt, and every later edit to that same file did not. `sed -i`, and most
 * editors, save by writing a temp file and renaming it over the original, and
 * the recursive watcher does not follow the file across that inode swap. The
 * failure is worse than not working at all, because the first edit succeeds and
 * teaches you to trust it.
 *
 * Stat-polling has none of that. It compares content identity, not inodes, so a
 * rename-over looks exactly like a write. It costs one `stat` per source file
 * per tick - low tens of files at 400ms - which is not measurable next to a
 * process that spawns a TypeScript compile on every change.
 */

/** Source directories whose contents change what the dashboard renders. */
export const WATCHED_DIRS = ["src/report", "src/stats", "src/model", "src/db"] as const;

/**
 * Whether a file should be watched at all.
 *
 * Editors leave swap, backup and probe files next to the real one. Including
 * them means rebuilding several times per save.
 */
export function isWatchedFile(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const name = basename(filename);
  if (name.startsWith(".")) return false; // .foo.ts.swp, .#foo.ts
  if (name.endsWith("~")) return false; // emacs backups
  if (name.endsWith(".test.ts")) return false; // tests do not change the output
  return name.endsWith(".ts");
}

/** path -> a value that changes whenever the file's content could have. */
export type Snapshot = Map<string, string>;

/**
 * Stamp every watched file under `dirs`.
 *
 * `mtimeMs:size` rather than a hash: reading every file on every tick to detect
 * a change nobody made is the wrong trade. A same-size same-millisecond edit
 * would be missed in theory; in practice an editor save moves the mtime.
 */
export function takeSnapshot(dirs: readonly string[], root = PROJECT_ROOT): Snapshot {
  const snap: Snapshot = new Map();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory that does not exist is not an error worth stopping for.
      // It shows up as "no files", and the next tick tries again.
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!isWatchedFile(entry.name)) continue;
      try {
        const s = statSync(full);
        snap.set(full, `${s.mtimeMs}:${s.size}`);
      } catch {
        // Vanished between readdir and stat. The next tick will see the truth.
      }
    }
  };
  for (const dir of dirs) walk(resolve(root, dir));
  return snap;
}

/** Whether anything was added, removed, or modified between two snapshots. */
export function snapshotsDiffer(before: Snapshot, after: Snapshot): boolean {
  if (before.size !== after.size) return true;
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) return true;
  }
  return false;
}

/**
 * The command that regenerates the dashboard, as a fresh process.
 *
 * It has to be a new process. This one is already running under tsx with the
 * module graph loaded, so calling `buildDashboard` again after editing
 * `dashboard.ts` would re-run the code from before the edit and report success.
 * `execArgv` carries tsx's loader flags, so re-invoking with them gets a process
 * that can load TypeScript exactly the way this one did.
 */
export function rebuildCommand(args: string[] = ["dashboard"]): { command: string; argv: string[] } {
  const entry = process.argv[1] ?? resolve(PROJECT_ROOT, "src", "cli.ts");
  return { command: process.execPath, argv: [...process.execArgv, entry, ...args] };
}

export interface WatcherHandle {
  close(): void;
}

export interface WatchOptions {
  /** Directories to watch, relative to the project root. */
  dirs?: readonly string[];
  /** How often to compare stamps. */
  intervalMs?: number;
  /** Called after each rebuild attempt. */
  onRebuild?: (result: { ok: boolean; ms: number }) => void;
}

export function startDashboardWatcher(opts: WatchOptions = {}): WatcherHandle {
  const dirs = opts.dirs ?? WATCHED_DIRS;
  const intervalMs = opts.intervalMs ?? 400;

  let snapshot = takeSnapshot(dirs);
  let running = false;
  let queued = false;
  let closed = false;

  const rebuild = () => {
    if (closed) return;
    // A save during a rebuild is queued, not dropped. Otherwise the last edit
    // before a slow rebuild finishes is the one that never renders, which is
    // the most confusing possible way for a watch loop to fail.
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const started = Date.now();
    const { command, argv } = rebuildCommand();
    const child = spawn(command, argv, { stdio: "ignore" });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      running = false;
      const ms = Date.now() - started;
      if (ok) log.info(`dashboard rebuilt in ${ms}ms`);
      else log.warn("dashboard rebuild failed - run `npm run cli -- dashboard` to see the error");
      opts.onRebuild?.({ ok, ms });
      if (queued) {
        queued = false;
        rebuild();
      }
    };

    child.on("exit", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  };

  const tick = () => {
    if (closed) return;
    const next = takeSnapshot(dirs);
    if (snapshotsDiffer(snapshot, next)) {
      snapshot = next;
      rebuild();
    }
  };

  const timer = setInterval(tick, intervalMs);
  // The poll must not be the reason the process stays alive; the server is.
  timer.unref?.();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
