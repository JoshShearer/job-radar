import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { appendAnswers, saveEvidence } from "../src/adapters/fs/yaml-writers.js";
import { OperationsSchema } from "../src/domain/config/schema.js";
import { loadConfig } from "../src/adapters/fs/config-loader.js";
import { EXAMPLE_CONFIG } from "./helpers/context.js";
import type { Evidence } from "../src/domain/candidate/evidence.js";

/** JOB-81: every YAML config write leaves a backup; only the writer's own, newest N survive. All paths are temp dirs. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jr-yaml-writers-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("never deletes a file that is not this writer's own <file>.<stamp>.bak", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    const foreign = [
      "personal.yaml.2026-08-14-193000.bak", // v1-era naming
      "personal.yaml.2026-08-14T19-30-00.bak.keep",
      "operations.yaml.2026-10-29-pre-web.bak",
      "personal.yaml.pre-web.bak",
      "personal.yaml.old.2026-01-01T00-00-00.bak",
      "personal.yaml.extra.2026-01-01T00-00-00.bak",
      "personal.yaml2.2026-01-01T00-00-00.bak", // another file sharing a prefix
      "my-personal.yaml.2026-01-01T00-00-00.bak",
      "evidence.yaml.2026-01-01T00-00-00.bak", // a sibling's own backup
    ];
    for (const n of foreign) writeFileSync(join(dir, n), "x");
    for (let i = 0; i < 6; i++) appendAnswers(f, answer(i), at(i + 100), 1);
    for (const n of foreign) expect(existsSync(join(dir, n)), n).toBe(true);
    expect(readdirSync(dir).filter((f) => /^personal\.yaml\.\d{4}-\d\d-\d\dT[\d-]+\.bak$/.test(f))).toHaveLength(1);
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

  it("a failed write does not prune", () => {
    const f = join(dir, "personal.yaml");
    writeFileSync(f, "answers: []\n");
    for (let i = 0; i < 3; i++) appendAnswers(f, answer(i), at(i), 10);
    const before = baks("personal.yaml.");
    // serialising throws before any rename, so nothing may be pruned
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
