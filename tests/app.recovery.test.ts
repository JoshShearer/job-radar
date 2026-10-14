import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, restore } from "../src/app/recovery.js";
import { FsRecoveryStore, hashTree } from "../src/adapters/fs/recovery-store.js";
import { FsArtifactStore } from "../src/adapters/fs/artifact-store.js";
import { openDatabase, probeDatabase, type DB } from "../src/adapters/sqlite/db.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { FixedClock } from "../src/kernel/clock.js";
import { buildManifest, manifestSchema, planRetention, treeProblems } from "../src/domain/recovery/recovery-set.js";

/**
 * `jr backup` / `jr restore` through their use cases over the real
 * filesystem and a real SQLite file: a scratch home with config (evidence and
 * personal included), some facts, and a published generation.
 */
const EXAMPLE = resolve(import.meta.dirname, "../config.example");
let base: string;
let home: string;
let db: DB;
let clock: FixedClock;
let store: FsRecoveryStore;
let generationDir: string;

const backups = () => join(home, "data/backups");
const sets = () => readdirSync(backups()).sort();
const run = (opts: { withArtifacts?: boolean; keep?: number } = {}) => {
  clock.advanceMs(60_000);
  return backup({ clock }, store, { withArtifacts: opts.withArtifacts ?? true, keep: opts.keep ?? 14 });
};
const live = () => ({ liveHome: home, liveDb: join(home, "data/jr.sqlite") });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "jr-recovery-"));
  home = join(base, "home");
  cpSync(EXAMPLE, join(home, "config"), { recursive: true });
  clock = new FixedClock("2026-10-14T12:00:00.000Z");
  db = openDatabase(join(home, "data/jr.sqlite"), () => clock.now().toISOString());
  const s = new SqliteStore(db);
  const runId = s.startRun("sweep", clock.now().toISOString());
  s.finishRun(runId, "ok", { n: 1 }, null, clock.now().toISOString());
  s.addInterview({ applicationId: "app-1", company: "Acme", role: "Engineer", stage: "screen", occurredOn: "2026-10-01", questions: ["q"], topics: [], selfRating: null, compDiscussed: false, notes: null, recordedAt: clock.now().toISOString() });
  generationDir = new FsArtifactStore(join(home, "artifacts")).publish("opp-1", "gen-1", { "resume.md": "# Resume\n", "cover.pdf": new Uint8Array([1, 2, 3]) }).dir;
  // An abandoned in-flight generation is never part of a recovery set.
  mkdirSync(join(home, "artifacts/opp-1/.tmp-gen-2-999"), { recursive: true });
  writeFileSync(join(home, "artifacts/opp-1/.tmp-gen-2-999/half.md"), "half");
  // Credentials and browser state that must never be copied.
  writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=secret\n");
  mkdirSync(join(home, ".browser-profile"), { recursive: true });
  writeFileSync(join(home, ".browser-profile/Cookies"), "session");
  store = new FsRecoveryStore(backups(), { db, config: join(home, "config"), artifacts: join(home, "artifacts") });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("jr backup", () => {
  it("writes a completed manifest naming versions, hashes, inclusions and exclusions", async () => {
    const r = await run();
    expect(r.outcome).toBe("ok");
    expect(sets()).toEqual([r.value.dir!.split("/").pop()]);
    const m = manifestSchema.parse(JSON.parse(readFileSync(join(r.value.dir!, "manifest.json"), "utf8")));
    expect(m.completed).toBe(true);
    expect(m.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(m.database.schemaVersion).toBeGreaterThan(0);
    expect(m.database.integrityCheck).toBe("ok");
    expect(m.database.rowCounts.run).toBe(1);
    expect(m.database.rowCounts.interview).toBe(1);
    expect(Object.keys(m.files)).toEqual(expect.arrayContaining(["data/jr.sqlite", "config/candidate/evidence.yaml", "config/candidate/personal.yaml", "artifacts/opp-1/gen-1/resume.md", "artifacts/opp-1/gen-1/cover.pdf"]));
    expect(Object.keys(m.files).some((f) => f.includes(".tmp-") || f.includes(".env") || f.includes("browser") || f.startsWith("reports/"))).toBe(false);
    expect(m.excluded.map((e) => e.path)).toEqual(expect.arrayContaining([".env", ".browser-profile/", "reports/"]));
    for (const e of m.excluded) expect(e.reason.length).toBeGreaterThan(10);
    expect(m.files["config/candidate/evidence.yaml"]!.sha256).toBe(hashTree(join(home, "config")) ["candidate/evidence.yaml"]!.sha256);
    expect(existsSync(join(r.value.dir!, "data/jr.sqlite-wal"))).toBe(false);
  });

  it("--without-artifacts says so in the manifest", async () => {
    const r = await run({ withArtifacts: false });
    const m = manifestSchema.parse(JSON.parse(readFileSync(join(r.value.dir!, "manifest.json"), "utf8")));
    expect(Object.keys(m.files).some((f) => f.startsWith("artifacts/"))).toBe(false);
    expect(m.excluded.find((e) => e.path === "artifacts/")?.reason).toMatch(/NOT recoverable/);
  });

  it("a crash mid-backup leaves a .partial that is never counted, pruned or reported complete", async () => {
    const first = await run();
    // Simulate a crash: a set staged but never completed.
    const crashed = await store.stage("jr-2026-10-14T13-00-00-000Z", { withArtifacts: true });
    expect(crashed.dir.endsWith(".partial")).toBe(true);
    const r = await run({ keep: 1 });
    expect(r.outcome).toBe("degraded");
    expect(r.notes.join("\n")).toMatch(/kept, not counted: jr-2026-10-14T13-00-00-000Z\.partial \(partial/);
    expect(r.value.pruned).toEqual([first.value.dir!.split("/").pop()]);
    expect(sets()).toEqual(["jr-2026-10-14T13-00-00-000Z.partial", r.value.dir!.split("/").pop()].sort());
  });

  it("--keep 1 keeps the newest verified set; manifest-less and tampered sets are not counted or deleted", async () => {
    const a = await run({ keep: 1 });
    const b = await run({ keep: 1 });
    expect(b.value.pruned).toEqual([a.value.dir!.split("/").pop()]);
    // A pre-manifest backup and a tampered newer set.
    mkdirSync(join(backups(), "jr-2026-01-01T00-00-00"), { recursive: true });
    const c = await run({ keep: 1 });
    expect(c.value.pruned).toEqual([b.value.dir!.split("/").pop()]);
    writeFileSync(join(c.value.dir!, "config/candidate/personal.yaml"), "tampered: true\n");
    // The next run's set is the only verified one; c no longer verifies, so it is kept and not counted.
    const d = await run({ keep: 1 });
    expect(d.value.pruned).toEqual([]);
    expect(sets()).toEqual(["jr-2026-01-01T00-00-00", c.value.dir!.split("/").pop(), d.value.dir!.split("/").pop()].sort());
    expect(d.notes.join("\n")).toMatch(/unverified: hash mismatch config\/candidate\/personal\.yaml/);
    expect(d.notes.join("\n")).toMatch(/jr-2026-01-01T00-00-00 \(no-manifest/);
  });

  it("retention never prunes the newest verified set, whatever --keep says", () => {
    const plan = planRetention([{ name: "jr-a", state: "verified", problems: [] }, { name: "jr-b", state: "verified", problems: [] }, { name: "jr-c", state: "unverified", problems: ["x"] }, { name: "jr-d.partial", state: "partial", problems: [] }], 0);
    expect(plan.prune).toEqual(["jr-a"]);
    expect(plan.keptVerified).toEqual(["jr-b"]);
    expect(plan.leftovers.map((l) => l.name)).toEqual(["jr-c", "jr-d.partial"]);
  });
});

describe("jr backup: symlinks inside the included trees", () => {
  const manifestOf = (dir: string) => manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const restoreTo = (dir: string, name: string) => restore(store, { set: dir, to: join(base, name), ...live() });

  it("a symlinked file is copied as real bytes, hashed, and restored", async () => {
    const outside = join(base, "elsewhere/evidence.yaml");
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(outside, "claims: [the real evidence]\n");
    rmSync(join(home, "config/candidate/evidence.yaml"));
    symlinkSync(outside, join(home, "config/candidate/evidence.yaml"));
    const r = await run();
    expect(r.outcome).toBe("ok");
    expect(lstatSync(join(r.value.dir!, "config/candidate/evidence.yaml")).isFile()).toBe(true);
    expect(manifestOf(r.value.dir!).files["config/candidate/evidence.yaml"]?.bytes).toBe(readFileSync(outside).length);
    const back = await restoreTo(r.value.dir!, "sym-file");
    expect(back.outcome).toBe("ok");
    expect(readFileSync(join(base, "sym-file/config/candidate/evidence.yaml"), "utf8")).toBe("claims: [the real evidence]\n");
    // Losing the live target later does not touch the set.
    rmSync(outside);
    expect(store.inspect(r.value.dir!).problems).toEqual([]);
  });

  it("a symlinked directory (config subtree or a generation) is copied as real files", async () => {
    const cand = join(base, "cand");
    cpSync(join(home, "config/candidate"), cand, { recursive: true });
    rmSync(join(home, "config/candidate"), { recursive: true });
    symlinkSync(cand, join(home, "config/candidate"));
    const gens = join(base, "gens");
    cpSync(join(home, "artifacts/opp-1"), gens, { recursive: true });
    rmSync(join(home, "artifacts/opp-1"), { recursive: true });
    symlinkSync(gens, join(home, "artifacts/opp-1"));
    const r = await run();
    expect(r.outcome).toBe("ok");
    const files = Object.keys(manifestOf(r.value.dir!).files);
    expect(files).toEqual(expect.arrayContaining(["config/candidate/evidence.yaml", "config/candidate/personal.yaml", "artifacts/opp-1/gen-1/resume.md", "artifacts/opp-1/gen-1/cover.pdf"]));
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(lstatSync(join(r.value.dir!, "config/candidate")).isDirectory()).toBe(true);
    const back = await restoreTo(r.value.dir!, "sym-dir");
    expect(back.outcome).toBe("ok");
    expect(readFileSync(join(base, "sym-dir/artifacts/opp-1/gen-1/resume.md"), "utf8")).toBe("# Resume\n");
  });

  it("a dangling symlink fails the backup, is never reported complete, and retention does not run", async () => {
    const good = await run({ keep: 1 });
    rmSync(join(home, "config/candidate/evidence.yaml"));
    symlinkSync(join(base, "gone.yaml"), join(home, "config/candidate/evidence.yaml"));
    const r = await run({ keep: 1 });
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/config\/candidate\/evidence\.yaml.*(dangling|does not exist)/);
    expect(sets().filter((s) => !s.endsWith(".partial"))).toEqual([good.value.dir!.split("/").pop()]);
    expect(store.list().filter((s) => s.state === "verified").map((s) => s.name)).toEqual([good.value.dir!.split("/").pop()]);
  });

  it("a dangling symlink in artifacts fails too", async () => {
    symlinkSync(join(base, "nowhere"), join(home, "artifacts/opp-1/gen-9"));
    const r = await run();
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/artifacts\/opp-1\/gen-9/);
  });

  it("a symlink loop fails instead of recursing", async () => {
    symlinkSync(join(home, "config"), join(home, "config/candidate/loop"));
    const r = await run();
    expect(r.outcome).toBe("failed");
    // The ancestors check names the link itself; without it the walk would recurse until the OS gave up with ELOOP deep inside.
    expect(r.notes.join("\n")).toMatch(/config\/candidate\/loop is a symlink loop \(it leads back to /);
  });

  it("a FIFO (or any special file) inside config/ fails the backup", async () => {
    execFileSync("mkfifo", [join(home, "config/candidate/pipe")]);
    const r = await run();
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/config\/candidate\/pipe is not a regular file or directory/);
    expect(sets().filter((s) => !s.endsWith(".partial"))).toEqual([]);
  });

  it("a symlink that leads to the backup root fails instead of copying backups into themselves", async () => {
    await run();
    symlinkSync(home, join(home, "config/home-link"));
    const r = await run();
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/backup root/);
  });
});

describe("jr backup: every included root is accounted for", () => {
  const manifestOf = (dir: string) => manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const complete = () => sets().filter((s) => !s.endsWith(".partial"));

  for (const tree of ["config", "artifacts"] as const) {
    it(`a dangling symlink at the root of ${tree}/ fails the backup instead of dropping the whole tree`, async () => {
      const good = await run({ keep: 1 });
      renameSync(join(home, tree), join(base, `${tree}-moved`));
      symlinkSync(join(base, `${tree}-unmounted`), join(home, tree));
      const r = await run({ keep: 1 });
      expect(r.outcome).toBe("failed");
      expect(r.notes.join("\n")).toMatch(new RegExp(`${tree} is a dangling symlink`));
      expect(complete()).toEqual([good.value.dir!.split("/").pop()]);
    });

    it(`${tree}/ that is a file, not a directory, fails the backup`, async () => {
      rmSync(join(home, tree), { recursive: true });
      writeFileSync(join(home, tree), "not a directory");
      const r = await run();
      expect(r.outcome).toBe("failed");
      expect(r.notes.join("\n")).toMatch(new RegExp(`${tree} \\(.*\\) is not a directory`));
      expect(complete()).toEqual([]);
    });

    it(`an unreadable ${tree}/ fails the backup`, async () => {
      chmodSync(join(home, tree), 0o000);
      try {
        const r = await run();
        expect(r.outcome).toBe("failed");
        expect(r.notes.join("\n")).toMatch(new RegExp(`${tree} cannot be read \\(EACCES\\)`));
        expect(complete()).toEqual([]);
      } finally {
        chmodSync(join(home, tree), 0o755);
      }
    });
  }

  it("a root symlink to a real directory is followed and copied in full", async () => {
    renameSync(join(home, "config"), join(base, "config-real"));
    symlinkSync(join(base, "config-real"), join(home, "config"));
    const r = await run();
    expect(r.outcome).toBe("ok");
    expect(Object.keys(manifestOf(r.value.dir!).files)).toEqual(expect.arrayContaining(["config/candidate/evidence.yaml", "config/candidate/personal.yaml"]));
  });

  it("a missing config/ fails: a set without config can never restore a working home", async () => {
    rmSync(join(home, "config"), { recursive: true });
    const r = await run();
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/config\/ is missing/);
    expect(complete()).toEqual([]);
  });

  it("an empty config/ fails too", async () => {
    rmSync(join(home, "config"), { recursive: true });
    mkdirSync(join(home, "config"));
    const r = await run();
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/config\/ has no files/);
  });

  it("a fresh home with no artifacts/ succeeds and the manifest records artifacts/ as absent, not included", async () => {
    rmSync(join(home, "artifacts"), { recursive: true });
    const r = await run();
    expect(r.outcome).toBe("ok");
    const m = manifestOf(r.value.dir!);
    expect(m.included.map((i) => i.path)).not.toContain("artifacts/");
    expect(m.excluded.find((e) => e.path === "artifacts/")?.reason).toMatch(/^absent/);
    expect(Object.keys(m.files).some((f) => f.startsWith("artifacts/"))).toBe(false);
  });

  it("the manifest's included trees must match what the walker copied and what was hashed", () => {
    const database = { schemaVersion: 1, integrityCheck: "ok", tables: 1, rowCounts: { t: 0 } };
    const h = { sha256: "0".repeat(64), bytes: 0 };
    const files = { "data/jr.sqlite": h, "config/a.yaml": h };
    const base = { name: "jr-x", createdAt: "2026-10-14T00:00:00.000Z", app: { name: "jr", version: "1" }, database, withArtifacts: true, files };
    const config = { path: "config/" as const, state: "copied" as const, files: ["config/a.yaml"] };
    expect(() => buildManifest({ ...base, trees: [config, { path: "artifacts/", state: "absent", files: [] }] })).not.toThrow();
    // A promised tree that was never checked, a copied file that was not hashed, a hashed file that was not copied, an "absent" tree with files.
    expect(treeProblems(true, [config], files)).toEqual([expect.stringMatching(/artifacts\/ was never checked/)]);
    expect(treeProblems(false, [{ ...config, files: ["config/a.yaml", "config/b.yaml"] }], files)).toEqual([expect.stringMatching(/config\/b\.yaml was copied but is not in the set/)]);
    expect(treeProblems(false, [{ ...config, files: [] }], files)).toEqual(expect.arrayContaining([expect.stringMatching(/config\/a\.yaml is in the set but the walker never copied it/)]));
    expect(treeProblems(false, [{ path: "config/", state: "absent", files: [] }], files)).toEqual(expect.arrayContaining([expect.stringMatching(/config\/ is missing/), expect.stringMatching(/reported absent/)]));
    expect(() => buildManifest({ ...base, withArtifacts: false, trees: [] })).toThrow(/not complete/);
  });

  it("a set whose manifest lists no config/ files is never verified, counted or restored", async () => {
    const r = await run();
    const dir = r.value.dir!;
    const m = manifestOf(dir);
    rmSync(join(dir, "config"), { recursive: true });
    const files = Object.fromEntries(Object.entries(m.files).filter(([f]) => !f.startsWith("config/")));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, files }, null, 2));
    expect(store.inspect(dir).problems).toEqual(expect.arrayContaining([expect.stringMatching(/no config\/ files/)]));
    expect(store.list().find((s) => dir.endsWith(s.name))?.state).toBe("unverified");
    const back = await restore(store, { set: dir, to: join(base, "no-config"), ...live() });
    expect(back.outcome).toBe("refused");
    expect(existsSync(join(base, "no-config"))).toBe(false);
  });
});

describe("jr backup: retention and the set just written", () => {
  it("never prunes the set this run wrote, even when the clock went backwards", async () => {
    const future = await run({ keep: 1 });
    clock.advanceMs(-3 * 24 * 3600_000);
    const now = await run({ keep: 1 });
    expect(now.outcome).toBe("ok");
    expect(existsSync(now.value.dir!)).toBe(true);
    expect(now.value.pruned).not.toContain(now.value.dir!.split("/").pop());
    expect(store.inspect(now.value.dir!).problems).toEqual([]);
    expect(now.value.pruned).toEqual([future.value.dir!.split("/").pop()]);
  });

  it("--keep 2 with a wound-back clock keeps the new set plus the newest other", async () => {
    const a = await run({ keep: 2 });
    const b = await run({ keep: 2 });
    clock.advanceMs(-3 * 24 * 3600_000);
    const c = await run({ keep: 2 });
    expect(c.value.pruned).toEqual([a.value.dir!.split("/").pop()]);
    expect(sets()).toEqual([b.value.dir!.split("/").pop(), c.value.dir!.split("/").pop()].sort());
  });

  it("planRetention protects the named set first", () => {
    const v = (name: string) => ({ name, state: "verified" as const, problems: [] });
    expect(planRetention([v("jr-a"), v("jr-b"), v("jr-z")], 1, "jr-a").prune).toEqual(["jr-b", "jr-z"]);
    expect(planRetention([v("jr-a"), v("jr-b"), v("jr-z")], 2, "jr-a").prune).toEqual(["jr-b"]);
  });
});

describe("jr backup: a backup root inside the included trees", () => {
  for (const tree of ["config", "artifacts", "artifacts/opp-1"]) {
    it(`refuses --out inside ${tree}/ and writes nothing there`, async () => {
      const before = hashTree(join(home, tree.split("/")[0]!));
      const inside = new FsRecoveryStore(join(home, tree, "backups"), { db, config: join(home, "config"), artifacts: join(home, "artifacts") });
      const r = await backup({ clock }, inside, { withArtifacts: true, keep: 14 });
      expect(r.outcome).toBe("refused");
      expect(r.notes.join("\n")).toMatch(/inside/);
      expect(existsSync(join(home, tree, "backups"))).toBe(false);
      expect(hashTree(join(home, tree.split("/")[0]!))).toEqual(before);
    });
  }

  it("allows a root inside artifacts/ when artifacts are not backed up", async () => {
    const inside = new FsRecoveryStore(join(home, "artifacts/backups"), { db, config: join(home, "config"), artifacts: join(home, "artifacts") });
    const r = await backup({ clock }, inside, { withArtifacts: false, keep: 14 });
    expect(r.outcome).toBe("ok");
  });
});

describe("jr restore", () => {
  it("round trip into an isolated directory preserves facts, history, candidate files and generation identity", async () => {
    const b = await run();
    const to = join(base, "restored");
    const r = await restore(store, { set: b.value.dir!, to, ...live() });
    expect(r.outcome).toBe("ok");
    const liveCounts = probeDatabase(join(home, "data/jr.sqlite")).rowCounts;
    expect(r.value.rowCounts).toEqual(liveCounts);
    expect(r.value.rowCounts.interview).toBe(1);
    for (const f of ["candidate/evidence.yaml", "candidate/personal.yaml"]) expect(readFileSync(join(to, "config", f))).toEqual(readFileSync(join(home, "config", f)));
    expect(hashTree(join(to, "artifacts/opp-1/gen-1"))).toEqual(hashTree(generationDir));
    expect(existsSync(join(to, ".env"))).toBe(false);
    expect(existsSync(join(to, ".browser-profile"))).toBe(false);
    // The restored copy is usable as a home: it opens and migrates cleanly.
    const reopened = openDatabase(join(to, "data/jr.sqlite"), () => clock.now().toISOString());
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM interview").get() as { n: number }).n).toBe(1);
    reopened.close();
  });

  it("restores by set name from the backup root", async () => {
    const b = await run();
    const r = await restore(store, { set: b.value.dir!.split("/").pop()!, to: join(base, "by-name"), ...live() });
    expect(r.outcome).toBe("ok");
  });

  it("never overwrites a file that appears in the destination after the emptiness check", async () => {
    const b = await run();
    const to = join(base, "raced");
    class Racy extends FsRecoveryStore {
      override destinationProblem(dest: string) {
        const p = super.destinationProblem(dest);
        mkdirSync(join(dest, "config/candidate"), { recursive: true });
        writeFileSync(join(dest, "config/candidate/evidence.yaml"), "mine");
        return p;
      }
    }
    const racy = new Racy(backups(), null);
    const r = await restore(racy, { set: b.value.dir!, to, ...live() });
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/config\/candidate\/evidence\.yaml/);
    expect(readFileSync(join(to, "config/candidate/evidence.yaml"), "utf8")).toBe("mine");
  });

  it("an unrelated file appearing after the check fails the restore and is left alone", async () => {
    const b = await run();
    const to = join(base, "raced2");
    class Racy extends FsRecoveryStore {
      override destinationProblem(dest: string) {
        const p = super.destinationProblem(dest);
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, "other.txt"), "mine");
        return p;
      }
    }
    const r = await restore(new Racy(backups(), null), { set: b.value.dir!, to, ...live() });
    expect(r.outcome).toBe("failed");
    expect(readFileSync(join(to, "other.txt"), "utf8")).toBe("mine");
  });

  it("refuses a non-empty destination and leaves it untouched", async () => {
    const b = await run();
    const to = join(base, "busy");
    mkdirSync(to);
    writeFileSync(join(to, "mine.txt"), "keep me");
    const r = await restore(store, { set: b.value.dir!, to, ...live() });
    expect(r.outcome).toBe("refused");
    expect(r.notes.join("\n")).toMatch(/not empty/);
    expect(readdirSync(to)).toEqual(["mine.txt"]);
  });

  it("refuses the live home and anything inside it", async () => {
    const b = await run();
    for (const to of [home, join(home, "restore-here"), join(home, "data/new")]) {
      const r = await restore(store, { set: b.value.dir!, to, ...live() });
      expect(r.outcome).toBe("refused");
      expect(r.notes.join("\n")).toMatch(/live Job Radar home/);
    }
    expect(existsSync(join(home, "restore-here"))).toBe(false);
  });

  it("refuses a tampered set before copying anything", async () => {
    const b = await run();
    writeFileSync(join(b.value.dir!, "artifacts/opp-1/gen-1/resume.md"), "# Edited\n");
    const to = join(base, "tampered");
    const r = await restore(store, { set: b.value.dir!, to, ...live() });
    expect(r.outcome).toBe("refused");
    expect(r.notes.join("\n")).toMatch(/hash mismatch artifacts\/opp-1\/gen-1\/resume\.md/);
    expect(existsSync(to)).toBe(false);
  });

  it("refuses a .partial or manifest-less directory", async () => {
    const crashed = await store.stage("jr-2026-10-14T13-00-00-000Z", { withArtifacts: false });
    const r1 = await restore(store, { set: crashed.dir, to: join(base, "p1"), ...live() });
    expect(r1.outcome).toBe("refused");
    const done = await run();
    renameSync(join(done.value.dir!, "manifest.json"), join(base, "moved.json"));
    const r2 = await restore(store, { set: done.value.dir!, to: join(base, "p2"), ...live() });
    expect(r2.outcome).toBe("refused");
    expect(r2.notes.join("\n")).toMatch(/no manifest\.json/);
  });
});

describe("jr restore: the restored database is checked, not just hashed", () => {
  /** Rewrite a set's manifest so every hash (and, unless told otherwise, every row count) matches what is on disk. */
  const resign = (dir: string, rowCounts?: (r: Record<string, number>) => Record<string, number>) => {
    const m = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    const probe = probeDatabase(join(dir, "data/jr.sqlite"));
    const database = { ...m.database, tables: probe.tables, rowCounts: rowCounts ? rowCounts(probe.rowCounts) : probe.rowCounts };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, database, files: hashTree(dir) }, null, 2));
    expect(store.inspect(dir).problems).toEqual([]);
  };

  it("fails a set whose database fails integrity_check even though every hash and row count matches", async () => {
    const r = await run();
    const dir = r.value.dir!;
    const file = join(dir, "data/jr.sqlite");
    const raw = new Database(file);
    raw.exec("CREATE TABLE corrupt_probe (x TEXT); CREATE INDEX corrupt_probe_x ON corrupt_probe (x); INSERT INTO corrupt_probe VALUES ('a'), ('b'), ('c');");
    const { rootpage } = raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'corrupt_probe_x'").get() as { rootpage: number };
    const pageSize = Number(raw.pragma("page_size", { simple: true }));
    raw.close();
    // Flip the last byte of the index's only page (the rowid of its first entry): the table is intact, the index now points nowhere.
    const bytes = readFileSync(file);
    bytes[rootpage * pageSize - 1] = bytes[rootpage * pageSize - 1]! ^ 0x40;
    writeFileSync(file, bytes);
    expect(probeDatabase(file).integrityCheck).not.toBe("ok");
    resign(dir);
    const back = await restore(store, { set: dir, to: join(base, "bad-db"), ...live() });
    expect(back.outcome).toBe("failed");
    expect(back.notes.join("\n")).toMatch(/integrity_check (?!ok)/);
  });

  it("fails a set whose row counts do not match the manifest even though every hash matches", async () => {
    const r = await run();
    const dir = r.value.dir!;
    resign(dir, (rows) => ({ ...rows, run: (rows.run ?? 0) + 1 }));
    const back = await restore(store, { set: dir, to: join(base, "bad-rows"), ...live() });
    expect(back.outcome).toBe("failed");
    expect(back.notes.join("\n")).toMatch(/table run: manifest \d+, restored \d+/);
  });
});
