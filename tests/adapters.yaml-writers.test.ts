import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { appendAnswers, saveEvidence } from "../src/adapters/fs/yaml-writers.js";
import { OperationsSchema } from "../src/domain/config/schema.js";
import { loadConfig } from "../src/adapters/fs/config-loader.js";
import { EXAMPLE_CONFIG } from "./helpers/context.js";
import type { Evidence } from "../src/domain/candidate/evidence.js";

/** Lets a test change what the writer's next directory listing sees (a race, a phantom, an unreadable directory). */
const listing = vi.hoisted(() => ({ once: [] as Array<(real: string[]) => string[]> }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readdir = ((p: string, ...rest: unknown[]) => {
    const real = (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    const hook = listing.once.shift();
    return hook ? hook(real as string[]) : real;
  }) as typeof actual.readdirSync;
  return { ...actual, readdirSync: readdir };
});

/** JOB-81: every YAML config write leaves a backup; only the writer's own, newest N survive. All paths are temp dirs. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jr-yaml-writers-"));
});
afterEach(() => {
  listing.once.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const baks = (prefix: string) => readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".bak")).sort();
const answer = (i: number) => [{ match: `q${i}`, answer: `a${i}` }];

describe("backup retention", () => {
  it("after N+3 writes to personal.yaml exactly N backups remain, the newest ones", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const N = 4;
    for (let i = 0; i < N + 3; i++) appendAnswers(f, answer(i), at(i), N);
    const left = baks("personal.yaml.");
    expect(left).toHaveLength(N);
    // the backup taken before write i holds i entries; the oldest three (0, 1, 2 entries) are gone
    const sizes = left.map((b) => (parse(readFileSync(join(dir, b), "utf8")).answers as unknown[]).length);
    expect(sizes).toEqual([3, 4, 5, 6]);
  });

  it("applies to evidence.yaml too", () => {
    const f = join(dir, "evidence.yaml");
    writeFileSync(f, "claims: []\n");
    for (let i = 0; i < 6; i++) saveEvidence(f, { claims: [] } as unknown as Evidence, at(i), 2);
    expect(baks("evidence.yaml.")).toHaveLength(2);
  });

  it("two writes in the same second keep separate backups and both count", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), "2026-01-01T00:00:00.000Z", 10);
    expect(baks("personal.yaml.")).toHaveLength(3);
    for (let i = 3; i < 8; i++) appendAnswers(f, answer(i), "2026-01-01T00:00:00.000Z", 3);
    const left = baks("personal.yaml.");
    expect(left).toHaveLength(3);
    // oldest first by write order: the survivors are the last three writes' backups (5, 6, 7 entries)
    const sizes = left.map((b) => (parse(readFileSync(join(dir, b), "utf8")).answers as unknown[]).length).sort();
    expect(sizes).toEqual([5, 6, 7]);
  });

  // Every fixture below is dated BEFORE the writes: a pattern loose enough to
  // match one would sort it as the oldest and delete it.
  const later = (s: number) => new Date(Date.UTC(2027, 0, 1, 0, 0, s)).toISOString();
  /** The name v1 wrote (`v1-final:src/apply/learn.ts`): identical to this writer's own pattern. */
  const V1 = ["2026-08-14T19-30-00", "2026-08-15T09-00-01", "2026-08-19T23-59-59"].map((t) => `personal.yaml.${t}.bak`);

  it.each([
    "personal.yaml.2026-08-14T19-30-00.bak.keep", // end anchor
    "personal.yaml.2026-08-14T19-30-00.bak~",
    "personal.yaml.2026-08-14T19-30-00.bak2",
    "my-personal.yaml.2026-08-14T19-30-00.bak", // start anchor
    "old.personal.yaml.2026-08-14T19-30-00.bak",
    "personalXyaml.2026-08-14T19-30-00.bak", // the dot is literal
    "personal.yaml2.2026-08-14T19-30-00.bak",
    "personal.yaml.old.2026-08-14T19-30-00.bak",
    "personal.yaml.2026-08-14T19-30-00Xbak",
    "personal.yamlX2026-08-14T19-30-00.bak",
    "personal.yaml.2026-08-14-193000.bak", // a looser stamp
    "personal.yaml.2026-08-14.bak",
    "personal.yaml.2026-08-14T19-30.bak",
    "personal.yaml.2026-08-14T19-30-00-000Z.bak",
    "personal.yaml.2026-08-14T19-30-00-.bak",
    "personal.yaml.2026-08-14T19-30-00-pre-web.bak",
    "personal.yaml.2026-08-14T19-30-00 copy.bak",
    "personal.yaml.2026-08-14T19-30-00.BAK",
    "personal.yaml.pre-web.bak",
    "operations.yaml.2026-08-14-pre-web.bak",
    "evidence.yaml.2026-08-14T19-30-00.bak", // a sibling's own backup
  ])("never deletes a file that is not this writer's own: %s", (name) => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    writeFileSync(join(dir, name), "x");
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), later(i), 1);
    expect(readFileSync(join(dir, name), "utf8")).toBe("x");
    expect(existsSync(join(dir, "personal.yaml.2027-01-01T00-00-02.bak"))).toBe(true);
    expect(readdirSync(dir)).toHaveLength(3); // the yaml, the foreign file, one backup
  });

  it("prunes only in its own directory: real v1-named backups in the parent, a sibling or a child directory survive", () => {
    const own = join(dir, "config", "candidate");
    const elsewhere = [join(dir, "config"), join(dir, "config", "search"), join(own, "kept"), dir];
    for (const d of [own, ...elsewhere]) mkdirSync(d, { recursive: true });
    for (const d of elsewhere) for (const n of V1) writeFileSync(join(d, n), d);
    const f = join(own, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (let i = 0; i < 4; i++) appendAnswers(f, answer(i), later(i), 1);
    for (const d of elsewhere) for (const n of V1) expect(readFileSync(join(d, n), "utf8"), join(d, n)).toBe(d);
    expect(readdirSync(own).sort()).toEqual(["kept", "personal.yaml", "personal.yaml.2027-01-01T00-00-03.bak"]);
  });

  it("a v1 backup BESIDE the yaml has this writer's own name, so it counts and is pruned as the oldest", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (const n of V1) writeFileSync(join(dir, n), "v1");
    appendAnswers(f, answer(0), later(0), 2);
    expect(baks("personal.yaml.")).toEqual([V1[2], "personal.yaml.2027-01-01T00-00-00.bak"]);
  });

  it("never prunes below the limit and does not prune a lone backup with keep 1", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    appendAnswers(f, answer(0), at(0), 1);
    appendAnswers(f, answer(1), at(1), 1);
    expect(baks("personal.yaml.")).toHaveLength(1);
  });

  it("the backup just taken survives even if the clock went backwards", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    appendAnswers(f, answer(0), at(500), 1);
    const backup = appendAnswers(f, answer(1), at(1), 1);
    expect(existsSync(backup!)).toBe(true);
  });

  it("the backup just taken survives a backwards clock through a path that is not normalised", () => {
    writeFileSync(join(dir, "personal.yaml"), "answers: []\n");
    const f = `${dir}/./personal.yaml`;
    appendAnswers(f, answer(0), at(500), 1);
    const backup = appendAnswers(f, answer(1), at(1), 1);
    expect(existsSync(backup!)).toBe(true);
    expect(baks("personal.yaml.")).toContain("personal.yaml.2026-01-01T00-00-01.bak");
  });

  it("a slightly later backup from another process is not deleted as misdated, up to the 24 hour slack", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const inside = "personal.yaml.2026-01-02T00-00-01.bak"; // exactly 24 h after the write below
    const beyond = "personal.yaml.2026-01-02T00-00-02.bak";
    for (const n of [inside, beyond]) writeFileSync(join(dir, n), "x");
    appendAnswers(f, answer(0), at(1), 1);
    expect(baks("personal.yaml.")).toEqual(["personal.yaml.2026-01-01T00-00-01.bak", inside]);
  });

  it("backups stamped in the future by a wrong clock rotate out; they never starve newer ones", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const wrong = (s: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, s)).toISOString();
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), wrong(i), 3);
    appendAnswers(f, answer(3), at(0), 3);
    // the oldest of the three went, not the one just taken, and never N+1 files
    expect(baks("personal.yaml.")).toEqual(["2026-01-01T00-00-00", "2030-01-01T00-00-01", "2030-01-01T00-00-02"].map((t) => `personal.yaml.${t}.bak`));
    for (let i = 4; i < 6; i++) appendAnswers(f, answer(i), at(i), 3);
    expect(baks("personal.yaml.")).toEqual(["00", "04", "05"].map((t) => `personal.yaml.2026-01-01T00-00-${t}.bak`));
  });

  it.each([0, -5])("a direct caller passing keep %i gets the minimum of 1", (keep) => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    appendAnswers(f, answer(0), at(500), 1);
    appendAnswers(f, answer(1), at(1), keep); // sorts first but is the one just taken, so nothing else is surplus
    expect(baks("personal.yaml.")).toHaveLength(2);
  });

  it.each([
    ["appendAnswers", (f: string) => appendAnswers(f, answer(9), at(50), 1)],
    ["saveEvidence", (f: string) => saveEvidence(f, { claims: [] } as unknown as Evidence, at(50), 1)],
  ])("a failed write does not prune: %s", (_name, write) => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), at(i), 10);
    const before = baks("personal.yaml.");
    const content = readFileSync(f, "utf8");
    mkdirSync(`${f}.tmp-${process.pid}`); // the atomic write cannot create its temp file
    expect(() => write(f)).toThrow();
    expect(baks("personal.yaml.")).toEqual([...before, "personal.yaml.2026-01-01T00-00-50.bak"]);
    expect(readFileSync(f, "utf8")).toBe(content);
  });

  it("a ledger that cannot be serialised prunes nothing and leaves the file alone", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), at(i), 10);
    const before = baks("personal.yaml.");
    const bad = {
      get claims(): never {
        throw new Error("cannot serialise");
      },
    };
    expect(() => saveEvidence(f, bad as unknown as Evidence, at(50), 1)).toThrow();
    const after = baks("personal.yaml.");
    expect(after.filter((b) => before.includes(b))).toEqual(before);
    expect(readFileSync(f, "utf8")).toContain("q2");
  });

  it.each([
    ["appendAnswers", (f: string) => appendAnswers(f, answer(9), later(9), null)],
    ["saveEvidence", (f: string) => saveEvidence(f, { claims: [] } as unknown as Evidence, later(9), null)],
  ])("keep null (the limit is unknown) backs up and writes but deletes nothing: %s", (_name, write) => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (const n of V1) writeFileSync(join(dir, n), "v1");
    expect(existsSync(write(f)!)).toBe(true);
    expect(baks("personal.yaml.")).toEqual([...V1, "personal.yaml.2027-01-01T00-00-09.bak"]);
    expect(readFileSync(f, "utf8")).not.toBe("answers: []\n");
  });

  it("never overwrites a same-second backup another process took after the directory was listed", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const theirs = join(dir, "personal.yaml.2026-01-01T00-00-01.bak");
    writeFileSync(theirs, "theirs");
    listing.once.push(() => []); // listed before the other process wrote
    const backup = appendAnswers(f, answer(0), at(1), 10);
    expect(readFileSync(theirs, "utf8")).toBe("theirs");
    expect(backup).toBe(join(dir, "personal.yaml.2026-01-01T00-00-01-1.bak"));
    expect(readFileSync(backup!, "utf8")).toBe("answers: []\n");
  });

  it("a backup another process already pruned is not reported as a failure", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const warnings: string[] = [];
    listing.once.push(
      (real) => real,
      (real) => [...real, "personal.yaml.2025-01-01T00-00-00.bak"], // listed, then gone
    );
    appendAnswers(f, answer(0), at(1), 1, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(baks("personal.yaml.")).toEqual(["personal.yaml.2026-01-01T00-00-01.bak"]);
  });

  it("a directory that cannot be listed still gets its backup and write, and the missed prune is reported", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const warnings: string[] = [];
    const unreadable = () => {
      throw new Error("EACCES: simulated");
    };
    listing.once.push(unreadable, unreadable);
    const backup = appendAnswers(f, answer(1), at(1), 1, (m) => warnings.push(m));
    expect(existsSync(backup!)).toBe(true);
    expect(readFileSync(f, "utf8")).toContain("q1");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not prune backups");
  });

  it("a failed prune is reported, never silent, and the write and its backup are kept", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    // a directory with a matching name cannot be unlinked
    mkdirSync(join(dir, "personal.yaml.2025-01-01T00-00-00.bak"));
    const warnings: string[] = [];
    const backup = appendAnswers(f, answer(1), at(1), 1, (m) => warnings.push(m));
    expect(warnings.join("\n")).toContain("personal.yaml.2025-01-01T00-00-00.bak");
    expect(existsSync(backup!)).toBe(true);
    expect(readFileSync(f, "utf8")).toContain("q1");
  });
});

describe("operations.yaml config_backups", () => {
  const example = () => parse(readFileSync(join(EXAMPLE_CONFIG, "operations.yaml"), "utf8"));
  it("config.example sets keep 10 and an absent key defaults to 10", () => {
    expect(loadConfig(EXAMPLE_CONFIG).operations.config_backups.keep).toBe(10);
    const o = example();
    delete o.config_backups;
    expect(OperationsSchema.parse(o).config_backups.keep).toBe(10);
  });
  it("rejects keep 0, a fraction, and unknown keys", () => {
    for (const bad of [{ keep: 0 }, { keep: 1.5 }, { keep: -1 }, { keep: 10, days: 3 }]) {
      expect(OperationsSchema.safeParse({ ...example(), config_backups: bad }).success).toBe(false);
    }
    expect(OperationsSchema.safeParse({ ...example(), config_backups: { keep: 1 } }).success).toBe(true);
  });
});
