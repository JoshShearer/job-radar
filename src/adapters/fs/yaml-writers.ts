import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseDocument, stringify, YAMLSeq } from "yaml";
import type { Evidence } from "../../domain/candidate/evidence.js";

/** Write atomically: a crash never leaves a half-written config file. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-(\d+))?`;

/** A backup dated further ahead than this was written by a wrong clock, not by another process. */
const CLOCK_SLACK_MS = 24 * 60 * 60 * 1000;

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stamp(at: string): string {
  return at.replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Copy `file` to `<file>.<stamp>.bak`, never overwriting an existing backup:
 * two writes in the same second get `-1`, `-2`... suffixes.
 */
function backUp(file: string, at: string): string {
  // Start above any same-second backup still on disk: pruning frees low names,
  // and reusing one would make a newer backup sort as the oldest.
  const same = new RegExp(`^${escapeRe(basename(file))}\\.${stamp(at)}(?:-(\\d+))?\\.bak$`);
  let taken = -1;
  try {
    for (const name of readdirSync(dirname(file))) {
      const m = same.exec(name);
      if (m) taken = Math.max(taken, m[1] ? Number(m[1]) : 0);
    }
  } catch {
    /* the EXCL copy below is the real guard, as it is against another process */
  }
  for (let n = taken + 1; ; n++) {
    const backup = `${file}.${stamp(at)}${n ? `-${n}` : ""}.bak`;
    try {
      copyFileSync(file, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/**
 * Delete backups of `file` beyond the newest `keep`, oldest first. Runs only
 * after the write succeeded. `keep` null means the limit is unknown (the config
 * could not be read), and then nothing is deleted.
 *
 * What protects other files is the name and the directory, nothing else. Only
 * `<base>.<YYYY-MM-DDTHH-MM-SS>[-n].bak` in `file`'s own directory is ever
 * deleted; any other name, and any other directory, is left alone. v1 wrote
 * this exact name, so a v1 backup moved beside `file` counts and is pruned;
 * the ones in the config root survive because they are in another directory.
 *
 * Age is the stamp in the name, the same order for every process, so two
 * writers at once cannot each delete the other's backup. Two consequences of a
 * wrong clock are handled: `current`, the backup just taken, is never deleted
 * whatever its stamp, and a backup stamped more than CLOCK_SLACK_MS after it can
 * only predate a clock correction, so it rotates out first instead of outliving
 * every correctly dated one. After a smaller backwards step, backups taken
 * since are the first to go until the clock catches up, and one extra file may
 * remain.
 *
 * A failure to delete is reported through `warn` and never undoes the write. A
 * backup that is already gone was pruned by another process, which is success.
 */
function pruneBackups(file: string, current: string, at: string, keep: number | null, warn: (m: string) => void): void {
  if (keep === null) return;
  const dir = dirname(file);
  const own = new RegExp(`^${escapeRe(basename(file))}\\.(${STAMP})\\.bak$`);
  try {
    const found: Array<{ name: string; stamp: string; n: number }> = [];
    for (const name of readdirSync(dir)) {
      const m = own.exec(name);
      if (m) found.push({ name, stamp: m[1]!.slice(0, 19), n: m[2] ? Number(m[2]) : 0 });
    }
    const horizon = stamp(new Date(Date.parse(at) + CLOCK_SLACK_MS).toISOString());
    const misdated = (f: { stamp: string }) => Number(f.stamp > horizon);
    found.sort((a, b) => misdated(b) - misdated(a) || (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.n - b.n));
    const surplus = found.length - Math.max(1, keep);
    for (const f of found.slice(0, Math.max(0, surplus))) {
      // Compared by name: `current` may be spelled through an unnormalised path.
      if (f.name === basename(current)) continue;
      const path = join(dir, f.name);
      try {
        unlinkSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        warn(`could not prune old backup ${path}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    warn(`could not prune backups of ${file}: ${(e as Error).message}`);
  }
}

const stderrWarn = (m: string): void => void process.stderr.write(`${m}\n`);

export function saveEvidence(file: string, e: Evidence, at: string, keep: number | null, warn: (m: string) => void = stderrWarn): string | null {
  const backup = existsSync(file) ? backUp(file, at) : null;
  writeFileAtomic(file, stringify(e, { lineWidth: 0 }));
  if (backup) pruneBackups(file, backup, at, keep, warn);
  return backup;
}

/**
 * Append learned answers to personal.yaml through the YAML document, so the
 * candidate's comments and formatting survive. The original is copied aside
 * first: it is a statement of fact and software is never its only copy.
 */
export function appendAnswers(file: string, entries: ReadonlyArray<{ match: string; answer: string }>, at: string, keep: number | null, warn: (m: string) => void = stderrWarn): string | null {
  if (!entries.length) return null;
  const original = readFileSync(file, "utf8");
  const backup = backUp(file, at);
  const doc = parseDocument(original);
  let list = doc.get("answers");
  if (!(list instanceof YAMLSeq)) {
    list = new YAMLSeq();
    doc.set("answers", list);
  }
  for (const e of entries) (list as YAMLSeq).add(doc.createNode({ match: e.match, answer: e.answer }));
  writeFileAtomic(file, doc.toString({ lineWidth: 0 }));
  pruneBackups(file, backup, at, keep, warn);
  return backup;
}
