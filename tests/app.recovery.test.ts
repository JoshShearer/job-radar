import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, restore } from "../src/app/recovery.js";
import { FsRecoveryStore, hashTree } from "../src/adapters/fs/recovery-store.js";
import { FsArtifactStore } from "../src/adapters/fs/artifact-store.js";
import { openDatabase, probeDatabase, type DB } from "../src/adapters/sqlite/db.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { FixedClock } from "../src/kernel/clock.js";
import { manifestSchema, planRetention } from "../src/domain/recovery/recovery-set.js";

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
