import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { buildBriefing } from "../src/app/briefing.js";
import { FsArtifactStore } from "../src/adapters/fs/artifact-store.js";
import { GH_ACME, ghBoard, makeEnv } from "./helpers/context.js";

async function seeded() {
  const env = makeEnv({
    routes: {
      [GH_ACME]: ghBoard([
        { id: 1, title: "Senior Software Engineer" },
        { id: 2, title: "100% Remote Frontend_Engineer" },
        { id: 3, title: "Staff Engineer", location: "Berlin, Germany" },
      ]),
    },
  });
  await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
  evaluate(env.ctx, null);
  return env;
}

describe("ranking reads for the briefing and the web UI", () => {
  it("counts the whole ranking without reading rows, matching a full read", async () => {
    const env = await seeded();
    const all = env.store.ranking({});
    expect(env.store.rankingCounts()).toEqual({
      opportunities: all.length,
      eligible: all.filter((r) => r.eligible).length,
      assessed: all.filter((r) => r.confidence === "analyzed").length,
      open: all.filter((r) => r.postingState === "open").length,
      closed: all.filter((r) => r.postingState === "closed").length,
    });
    expect(buildBriefing(env.ctx).counts).toEqual(env.store.rankingCounts());
  });

  it("an empty table counts zero", () => {
    expect(makeEnv().store.rankingCounts()).toEqual({ opportunities: 0, eligible: 0, assessed: 0, open: 0, closed: 0 });
  });

  it("filters by an id list; an empty list matches nothing, not everything", async () => {
    const env = await seeded();
    const ids = env.store.ranking({}).map((r) => r.opportunityId);
    expect(env.store.ranking({ opportunityIds: [] })).toEqual([]);
    expect(env.store.ranking({ opportunityIds: [ids[0]!] }).map((r) => r.opportunityId)).toEqual([ids[0]]);
    expect(env.store.ranking({ opportunityIds: ids }).length).toBe(ids.length);
  });

  it("searches company and title case-insensitively, with % and _ taken literally", async () => {
    const env = await seeded();
    expect(env.store.ranking({ text: "frontend_engineer" }).map((r) => r.title)).toEqual(["100% Remote Frontend_Engineer"]);
    expect(env.store.ranking({ text: "100%" }).map((r) => r.title)).toEqual(["100% Remote Frontend_Engineer"]);
    expect(env.store.ranking({ text: "%" })).toHaveLength(1);
    expect(env.store.ranking({ text: "_" })).toHaveLength(1);
    expect(env.store.ranking({ text: "ACME" }).length).toBe(env.store.ranking({}).length);
    expect(env.store.ranking({ text: "   " }).length).toBe(env.store.ranking({}).length);
  });

  it("pages with limit and offset in rank order", async () => {
    const env = await seeded();
    const all = env.store.ranking({}).map((r) => r.opportunityId);
    expect(env.store.ranking({ limit: 1, offset: 1 }).map((r) => r.opportunityId)).toEqual([all[1]]);
    expect(env.store.ranking({ limit: 10, offset: all.length })).toEqual([]);
  });
});

describe("artifact store after the home moved", () => {
  it("finds a generation under its own root when the recorded absolute directory is gone", () => {
    const oldRoot = mkdtempSync(join(tmpdir(), "jr-old-"));
    const store = new FsArtifactStore(oldRoot);
    const { dir } = store.publish("opp1", "pack-g1", { "a.md": "hello" });
    expect(store.read(dir, "a.md")).toBe("hello");

    // Move the whole artifacts tree, as copying a home to another machine does.
    const newRoot = join(mkdtempSync(join(tmpdir(), "jr-new-")), "artifacts");
    mkdirSync(join(newRoot, ".."), { recursive: true });
    renameSync(oldRoot, newRoot);
    const moved = new FsArtifactStore(newRoot);
    expect(moved.read(dir, "a.md")).toBe("hello");
    expect(moved.path(dir, "a.md")).toBe(join(newRoot, "opp1", "pack-g1", "a.md"));
    expect(moved.read(dir, "missing.md")).toBeNull();
    expect(moved.read(join(tmpdir(), "nowhere", "opp9", "pack-x"), "a.md")).toBeNull();
  });
});
