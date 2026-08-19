import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decideReuse, hashFile, readStamps, writeStamp, stampPath, type Stamp } from "../src/apply/reuse.js";

/**
 * JOB-19. `resume tailor` and `apply` both called the model unconditionally, so
 * re-running the documented chain after any failure paid for both again. The
 * run log showed 21 tailor and 18 apply runs against 13 prepared directories.
 *
 * Cost is the smaller half. Bullet selection is a model decision, so a second
 * `tailor` returns a DIFFERENT resume for the same posting - quietly replacing
 * a document that may already have been read, approved, or submitted.
 */

const stamp = (over: Partial<Stamp> = {}): Stamp => ({
  descriptionHash: "desc-1",
  resumeHash: "res-1",
  generatedAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

const base = {
  artifactExists: true,
  stamp: stamp(),
  descriptionHash: "desc-1",
  resumeHash: "res-1",
  force: false,
};

describe("deciding whether to reuse a generated document", () => {
  it("reuses when nothing has changed", () => {
    const d = decideReuse(base);
    expect(d.reuse).toBe(true);
    expect(d.resumeChanged).toBe(false);
    expect(d.why).toMatch(/unchanged/);
  });

  it("regenerates when the posting text has changed", () => {
    // The plan was selected against requirements that no longer exist. Mirrors
    // `repo.upsert` dropping a cached analysis when a description changes.
    const d = decideReuse({ ...base, descriptionHash: "desc-2" });
    expect(d.reuse).toBe(false);
    expect(d.why).toMatch(/posting has changed/);
  });

  it("reuses but says so when only the master resume has changed", () => {
    // Deliberately not a regeneration. A saved plan cites bullet ids and
    // `enforceProvenance` re-checks every one on render, so a stale plan cannot
    // become a false one - it can only miss bullets added since.
    const d = decideReuse({ ...base, resumeHash: "res-2" });
    expect(d.reuse).toBe(true);
    expect(d.resumeChanged).toBe(true);
    expect(d.why).toMatch(/master resume has changed/);
    expect(d.why).toMatch(/--force/);
  });

  it("regenerates on --force even when everything matches", () => {
    const d = decideReuse({ ...base, force: true });
    expect(d.reuse).toBe(false);
    expect(d.why).toMatch(/--force/);
  });

  it("generates when there is nothing saved", () => {
    expect(decideReuse({ ...base, artifactExists: false, stamp: undefined }).reuse).toBe(false);
  });

  it("does not reuse a stamp when the artifact itself is gone", () => {
    // The stamp file outliving the plan it describes must not be read as
    // "already generated" - there would be nothing to render.
    expect(decideReuse({ ...base, artifactExists: false }).reuse).toBe(false);
  });

  it("reuses an artifact generated before stamps existed, rather than charging for it again", () => {
    // Twelve applications were prepared before this file existed. Treating an
    // absent stamp as "stale" would re-bill every one of them to learn nothing.
    const d = decideReuse({ ...base, stamp: undefined });
    expect(d.reuse).toBe(true);
    expect(d.why).toMatch(/staleness cannot be checked/);
  });

  it("never reuses silently - every branch explains itself", () => {
    for (const input of [
      base,
      { ...base, descriptionHash: "desc-2" },
      { ...base, resumeHash: "res-2" },
      { ...base, force: true },
      { ...base, artifactExists: false },
      { ...base, stamp: undefined },
    ]) {
      expect(decideReuse(input).why.length).toBeGreaterThan(10);
    }
  });
});

describe("stamps on disk", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(resolve(tmpdir(), "job-radar-reuse-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("round-trips a stamp", () => {
    withDir((dir) => {
      writeStamp(dir, "resumePlan", stamp());
      expect(readStamps(dir).resumePlan).toEqual(stamp());
    });
  });

  it("keeps the two artifacts independent", () => {
    // `tailor` and `apply` generate at different times and go stale
    // separately, so writing one must not erase the other's stamp.
    withDir((dir) => {
      writeStamp(dir, "resumePlan", stamp({ descriptionHash: "a" }));
      writeStamp(dir, "pack", stamp({ descriptionHash: "b" }));
      const s = readStamps(dir);
      expect(s.resumePlan?.descriptionHash).toBe("a");
      expect(s.pack?.descriptionHash).toBe("b");
    });
  });

  it("treats a corrupt stamp file as absent rather than crashing", () => {
    withDir((dir) => {
      writeFileSync(stampPath(dir), "{not json", "utf8");
      expect(readStamps(dir)).toEqual({});
    });
  });

  it("returns no stamps for a directory that has none", () => {
    withDir((dir) => {
      expect(readStamps(dir)).toEqual({});
      expect(existsSync(stampPath(dir))).toBe(false);
    });
  });

  it("writes valid JSON a human can read", () => {
    withDir((dir) => {
      writeStamp(dir, "pack", stamp());
      const text = readFileSync(stampPath(dir), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text).pack.descriptionHash).toBe("desc-1");
    });
  });
});

describe("hashing the master resume", () => {
  it("changes when the file changes, and only then", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "job-radar-hash-"));
    try {
      const f = resolve(dir, "resume.yaml");
      writeFileSync(f, "basics:\n  name: Ada\n", "utf8");
      const first = hashFile(f);
      expect(first).not.toBe("");
      expect(hashFile(f)).toBe(first);

      writeFileSync(f, "basics:\n  name: Ada Lovelace\n", "utf8");
      expect(hashFile(f)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty hash for a missing file instead of throwing", () => {
    expect(hashFile(resolve(tmpdir(), "job-radar-does-not-exist.yaml"))).toBe("");
  });
});

describe("asking for more than was saved", () => {
  // JOB-23. `apply` defaults to a submit-now pack and generates outreach,
  // interview prep and negotiation strategy only under `--full`. Reusing a
  // core pack for a `--full` request would hand back a document missing the
  // exact sections just asked for, and report it as a successful reuse.
  it("regenerates when --full is asked for and the saved pack is core", () => {
    const d = decideReuse({ ...base, stamp: stamp({ full: false }), wantFull: true });
    expect(d.reuse).toBe(false);
    expect(d.why).toMatch(/--full/);
  });

  it("treats a stamp written before --full existed as core", () => {
    // `full` is absent on older stamps. Reading that as "core" can only cause
    // a regeneration, which is the safe direction.
    const { full: _omit, ...noFullFlag } = stamp();
    const d = decideReuse({ ...base, stamp: noFullFlag as Stamp, wantFull: true });
    expect(d.reuse).toBe(false);
  });

  it("reuses a full pack for a full request", () => {
    expect(decideReuse({ ...base, stamp: stamp({ full: true }), wantFull: true }).reuse).toBe(true);
  });

  it("reuses a full pack for a core request, rather than paying to generate less", () => {
    expect(decideReuse({ ...base, stamp: stamp({ full: true }), wantFull: false }).reuse).toBe(true);
  });

  it("still reuses a core pack for a core request", () => {
    expect(decideReuse({ ...base, stamp: stamp({ full: false }), wantFull: false }).reuse).toBe(true);
  });
});
