import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsArtifactStore } from "../src/adapters/fs/artifact-store.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A restored installation: the old root is still on disk, the active root holds its own copy. */
function twoRoots(activeBytes: string, legacyBytes: string) {
  const oldRoot = mkdtempSync(join(tmpdir(), "jr-art-old-"));
  const activeRoot = mkdtempSync(join(tmpdir(), "jr-art-new-"));
  const { dir: legacyDir } = new FsArtifactStore(oldRoot).publish("opp1", "pack-g1", { "a.md": legacyBytes });
  const active = new FsArtifactStore(activeRoot);
  if (activeBytes !== "") active.publish("opp1", "pack-g1", { "a.md": activeBytes });
  return { oldRoot, activeRoot, legacyDir, active };
}

describe("artifact store: the active root wins over a stale recorded path", () => {
  it("reads the active root's copy when the old location still exists with different bytes", () => {
    const t = twoRoots("active bytes", "OLD bytes");
    expect(t.active.read(t.legacyDir, "a.md")).toBe("active bytes");
    expect(t.active.path(t.legacyDir, "a.md")).toBe(join(t.activeRoot, "opp1", "pack-g1", "a.md"));
  });

  it("falls back to the recorded path when the active root has no such generation", () => {
    const t = twoRoots("", "OLD bytes");
    expect(t.active.read(t.legacyDir, "a.md")).toBe("OLD bytes");
  });

  it("returns null for a generation present in neither place", () => {
    const t = twoRoots("", "x");
    expect(t.active.read(join(tmpdir(), "nowhere", "opp9", "pack-x"), "a.md")).toBeNull();
  });

  it("uses the active copy when it matches the manifest, with no warning", () => {
    const t = twoRoots("active bytes", "OLD bytes");
    const r = t.active.resolve(t.legacyDir, "a.md", { sha256: sha("active bytes") });
    expect(r).toMatchObject({ source: "active", path: join(t.activeRoot, "opp1", "pack-g1", "a.md") });
    expect(r.warning).toBeUndefined();
    expect(r.mismatch).toBeUndefined();
  });

  it("reads the legacy copy with a warning when only it matches the manifest", () => {
    const t = twoRoots("corrupt", "true bytes");
    const r = t.active.resolve(t.legacyDir, "a.md", { sha256: sha("true bytes") });
    expect(r.source).toBe("legacy");
    expect(r.path).toBe(join(t.legacyDir, "a.md"));
    expect(r.warning).toMatch(/does not match/);
    expect(t.active.read(t.legacyDir, "a.md", { sha256: sha("true bytes") })).toBe("true bytes");
  });

  it("never falls back silently when neither copy matches the manifest", () => {
    const t = twoRoots("one", "two");
    const r = t.active.resolve(t.legacyDir, "a.md", { sha256: sha("three") });
    expect(r.mismatch).toMatch(/neither/);
    expect(() => t.active.read(t.legacyDir, "a.md", { sha256: sha("three") })).toThrow(/neither/);
  });

  it("verifies a lone legacy copy against the manifest too", () => {
    const t = twoRoots("", "tampered");
    expect(t.active.resolve(t.legacyDir, "a.md", { sha256: sha("real") }).mismatch).toBeDefined();
    expect(t.active.resolve(t.legacyDir, "a.md", { sha256: sha("tampered") }).mismatch).toBeUndefined();
  });

  it("derives identity from the last two path segments, even for a foreign-style recorded path", () => {
    const t = twoRoots("active bytes", "x");
    mkdirSync(join(t.activeRoot, "opp1"), { recursive: true });
    expect(t.active.read("C:/Users/old/artifacts/opp1/pack-g1", "a.md")).toBe("active bytes");
  });

  it("a missing file in the active generation does not hide the legacy copy of that file", () => {
    const t = twoRoots("active bytes", "OLD bytes");
    writeFileSync(join(t.legacyDir, "extra.md"), "only legacy");
    expect(t.active.read(t.legacyDir, "extra.md")).toBe("only legacy");
  });

  it("reports a generation present nowhere as missing, not as a mismatch", () => {
    const t = twoRoots("", "x");
    const r = t.active.resolve(join(tmpdir(), "nowhere", "opp9", "pack-x"), "a.md", { sha256: sha("x") });
    expect(r.source).toBe("missing");
    expect(r.mismatch).toBeUndefined();
  });

  it("when the recorded path is the active copy, a hash mismatch is reported without a legacy warning", () => {
    const root = mkdtempSync(join(tmpdir(), "jr-art-same-"));
    const store = new FsArtifactStore(root);
    const { dir } = store.publish("opp1", "pack-g1", { "a.md": "bytes" });
    const r = store.resolve(dir, "a.md", { sha256: sha("other") });
    expect(r.mismatch).toMatch(/neither/);
    expect(r.warning).toBeUndefined();
    expect(store.resolve(dir, "a.md", { sha256: sha("bytes") })).toEqual({ path: join(dir, "a.md"), source: "active" });
  });
});
