import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { buildBriefing } from "../src/app/briefing.js";
import { FsArtifactStore } from "../src/adapters/fs/artifact-store.js";
import { GH_ACME, ghBoard, makeEnv } from "./helpers/context.js";
import { RANKING_SORT_KEYS, type RankingRecord, type RankingSortKey } from "../src/ports/records.js";
import { PURSUIT_STATES } from "../src/domain/pursuit/machines.js";

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

/**
 * Eight rows with deliberate ties on every sort key and one undated posting.
 * The ranking table is derived, so the test sets its columns directly to get
 * values evaluate would take a whole fixture world to produce.
 */
async function sortable() {
  const env = makeEnv({
    routes: { [GH_ACME]: ghBoard([1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, title: `Engineer ${id}` }))) },
  });
  await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
  evaluate(env.ctx, null);
  const rows: Array<[string, number, number, string, string, string, string | null]> = [
    // title, fit, roi, confidence, posting_state, pursuit_state, date_posted
    ["beta", 70, 50, "raw", "open", "new", "2026-09-01T00:00:00.000Z"],
    ["Alpha", 70, 60, "projected", "closed", "applied", "2026-09-03T00:00:00.000Z"],
    ["gamma", 90, 60, "analyzed", "unknown", "reviewed", null],
    ["delta", 40, 60, "raw", "missing", "new", "2026-09-03T00:00:00.000Z"],
    ["Alpha", 55, 20, "raw", "open", "skipped", "2026-08-15T00:00:00.000Z"],
    ["epsilon", 90, 80, "projected", "open", "shortlisted", "2026-09-02T00:00:00.000Z"],
    ["zeta", 10, 50, "analyzed", "closed", "preparing", "2026-09-01T00:00:00.000Z"],
    ["eta", 70, 50, "raw", "open", "new", "2026-09-01T00:00:00.000Z"],
  ];
  const ids = env.store.ranking({}).map((r) => r.opportunityId).sort();
  expect(ids).toHaveLength(rows.length);
  const set = env.store.db.prepare(
    "UPDATE ranking SET title = ?, fit = ?, roi = ?, confidence = ?, posting_state = ?, pursuit_state = ?, date_posted = ? WHERE opportunity_id = ?",
  );
  rows.forEach((r, i) => set.run(...r, ids[i]));
  return env;
}

/** The order each key promises, written independently of the store's SQL. */
const KEY: Record<RankingSortKey, (r: RankingRecord) => string | number | null> = {
  roi: (r) => r.roi,
  fit: (r) => r.fit,
  title: (r) => r.title.toLowerCase(),
  basis: (r) => ({ analyzed: 3, projected: 2, raw: 1 })[r.confidence],
  posting: (r) => ["open", "unknown", "missing", "closed"].indexOf(r.postingState),
  decision: (r) => (PURSUIT_STATES as readonly string[]).indexOf(r.pursuitState),
  posted: (r) => r.datePosted,
};
function expected(rows: RankingRecord[], key: RankingSortKey, dir: "asc" | "desc"): string[] {
  const cmp = (a: string | number | null, b: string | number | null) => (a === b ? 0 : a! < b! ? -1 : 1);
  return [...rows]
    .sort((a, b) => {
      const ka = KEY[key](a);
      const kb = KEY[key](b);
      if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
      return (dir === "asc" ? cmp(ka, kb) : cmp(kb, ka)) || b.roi - a.roi || b.fit - a.fit || cmp(a.opportunityId, b.opportunityId);
    })
    .map((r) => r.opportunityId);
}

describe("ranking sort and count for the Ranked page", () => {
  it("sorts by every key in both directions, nulls last, ties broken by ROI, fit and id", async () => {
    const env = await sortable();
    const all = env.store.ranking({});
    for (const key of RANKING_SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const got = env.store.ranking({ sort: { key, dir } }).map((r) => r.opportunityId);
        expect(got, `${key} ${dir}`).toEqual(expected(all, key, dir));
      }
    }
    // The undated posting is last whichever way dates run.
    const undated = all.find((r) => r.datePosted === null)!.opportunityId;
    expect(env.store.ranking({ sort: { key: "posted", dir: "asc" } }).at(-1)!.opportunityId).toBe(undated);
    expect(env.store.ranking({ sort: { key: "posted", dir: "desc" } }).at(-1)!.opportunityId).toBe(undated);
  });

  it("no sort is ROI then fit, descending, exactly as before", async () => {
    const env = await sortable();
    const ids = env.store.ranking({}).map((r) => r.opportunityId);
    expect(ids).toEqual(expected(env.store.ranking({}), "roi", "desc"));
    expect(env.store.ranking({ sort: { key: "roi", dir: "desc" } }).map((r) => r.opportunityId)).toEqual(ids);
  });

  it("a key outside the allowlist falls back to the default order and never reaches SQL", async () => {
    const env = await sortable();
    const ids = env.store.ranking({}).map((r) => r.opportunityId);
    const hostile = { key: "fit; DROP TABLE ranking; --" as RankingSortKey, dir: "asc" as const };
    expect(env.store.ranking({ sort: hostile }).map((r) => r.opportunityId)).toEqual(ids);
    expect(env.store.rankingCount({})).toBe(ids.length);
  });

  it("pages a tied sort with no row repeated or skipped", async () => {
    const env = await sortable();
    for (const key of RANKING_SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const whole = env.store.ranking({ sort: { key, dir } }).map((r) => r.opportunityId);
        const paged = [0, 3, 6].flatMap((offset) => env.store.ranking({ sort: { key, dir }, limit: 3, offset }).map((r) => r.opportunityId));
        expect(paged, `${key} ${dir}`).toEqual(whole);
      }
    }
  });

  it("counts what the filter matches, ignoring limit, offset and sort", async () => {
    const env = await sortable();
    const filters = [
      {},
      { postingStates: ["open"] },
      { pursuitStates: ["new", "reviewed"] },
      { text: "alpha" },
      { minFit: 70 },
      { opportunityIds: [] },
      { text: "no-such-thing" },
    ];
    for (const f of filters) {
      const n = env.store.ranking(f).length;
      expect(env.store.rankingCount(f), JSON.stringify(f)).toBe(n);
      expect(env.store.rankingCount({ ...f, limit: 2, offset: 1, sort: { key: "title", dir: "desc" } }), JSON.stringify(f)).toBe(n);
    }
    expect(env.store.rankingCount({ postingStates: ["open"] })).toBe(4);
    expect(makeEnv().store.rankingCount({})).toBe(0);
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
