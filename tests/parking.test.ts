import { describe, it, expect } from "vitest";
import { planParking, type ParkCandidate } from "../src/model/freshness.js";
import { isAutoParkable } from "../src/model/status.js";

const NOW = Date.parse("2026-08-20T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const OPTS = { afterDays: 3, maxFractionPerSource: 0.5, isParkable: isAutoParkable };

function newest(map: Record<string, number>): Map<string, string> {
  return new Map(Object.entries(map).map(([k, v]) => [k, iso(v)]));
}

/**
 * JOB-36. 339 filter-passing jobs were still NEW although their board had
 * stopped listing them. They held ranking slots and could eat analysis budget.
 *
 * JOB-50 rescoped grouping from provider (`greenhouse`) to employer-board
 * (`greenhouse:acme`), including `maxFractionPerSource`, which is now scoped
 * per board rather than diluted across every board sharing a provider.
 */
describe("planParking", () => {
  it("parks a posting its board has stopped listing", () => {
    const jobs: ParkCandidate[] = [
      { id: "gone", board: "greenhouse:acme", lastSeen: iso(10), status: "NEW" },
      { id: "here", board: "greenhouse:acme", lastSeen: iso(0), status: "NEW" },
    ];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual(["gone"]);
  });

  it("never parks a posting a person has acted on", () => {
    // A posting vanishing from the board is often exactly what happens right
    // after you apply to it. An inference must not overwrite a human record.
    const jobs: ParkCandidate[] = [
      { id: "applied", board: "greenhouse:acme", lastSeen: iso(30), status: "APPLIED" },
      { id: "screen", board: "greenhouse:acme", lastSeen: iso(30), status: "SCREEN" },
      { id: "offer", board: "greenhouse:acme", lastSeen: iso(30), status: "OFFER" },
      { id: "skipped", board: "greenhouse:acme", lastSeen: iso(30), status: "SKIPPED" },
    ];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual([]);
  });

  it("waits longer than the [CLOSED?] tag does, so one bad sweep parks nothing", () => {
    // isStale uses a six-hour window, which is right for colouring a listing.
    // A state change has to be slower than that.
    const jobs: ParkCandidate[] = [{ id: "a", board: "greenhouse:acme", lastSeen: iso(1), status: "NEW" }];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual([]);
  });

  it("refuses to park a board that would lose most of its catalogue", () => {
    // A board returning a truncated list looks exactly like a board where
    // hundreds of jobs closed at once. This is the difference.
    const jobs: ParkCandidate[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `old${i}`, board: "greenhouse:flaky", lastSeen: iso(10), status: "NEW",
      })),
      { id: "fresh", board: "greenhouse:flaky", lastSeen: iso(0), status: "NEW" },
    ];
    const plan = planParking(jobs, newest({ "greenhouse:flaky": 0 }), OPTS);
    expect(plan.park).toEqual([]);
    expect(plan.refusedSources).toEqual([{ board: "greenhouse:flaky", wouldPark: 9, total: 10 }]);
  });

  it("refusing one board does not stop another", () => {
    const jobs: ParkCandidate[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `f${i}`, board: "greenhouse:flaky", lastSeen: iso(10), status: "NEW",
      })),
      { id: "ffresh", board: "greenhouse:flaky", lastSeen: iso(0), status: "NEW" },
      { id: "g1", board: "greenhouse:good", lastSeen: iso(10), status: "NEW" },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `gfresh${i}`, board: "greenhouse:good", lastSeen: iso(0), status: "NEW",
      })),
    ];
    const plan = planParking(jobs, newest({ "greenhouse:flaky": 0, "greenhouse:good": 0 }), OPTS);
    expect(plan.park).toEqual(["g1"]);
    expect(plan.refusedSources.map((r) => r.board)).toEqual(["greenhouse:flaky"]);
  });

  it("parks nothing from a board that failed completely", () => {
    // A board that returned nothing has no advanced high-water mark, so its
    // jobs cannot look stale. The per-board comparison is what guarantees it.
    const jobs: ParkCandidate[] = [
      { id: "a", board: "greenhouse:dead", lastSeen: iso(30), status: "NEW" },
      { id: "b", board: "greenhouse:dead", lastSeen: iso(30), status: "NEW" },
    ];
    expect(planParking(jobs, newest({ "greenhouse:dead": 30 }), OPTS).park).toEqual([]);
  });

  it("ignores a posting that has never been seen", () => {
    const jobs: ParkCandidate[] = [{ id: "a", board: "greenhouse:acme", lastSeen: null, status: "NEW" }];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual([]);
  });

  it("parks a REVIEWED posting, which is still only a machine-set state", () => {
    const jobs: ParkCandidate[] = [
      { id: "r", board: "greenhouse:acme", lastSeen: iso(10), status: "REVIEWED" },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`, board: "greenhouse:acme", lastSeen: iso(0), status: "NEW",
      })),
    ];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual(["r"]);
  });

  it("ignores a job with no recorded board, regardless of the map", () => {
    // Unknown provenance handled conservatively: never a park candidate.
    const jobs: ParkCandidate[] = [{ id: "a", board: "", lastSeen: iso(30), status: "NEW" }];
    expect(planParking(jobs, newest({ "greenhouse:acme": 0 }), OPTS).park).toEqual([]);
  });

  /**
   * The literal JOB-50 bug reproduction. Two employer boards on the same ATS
   * provider: one keeps sweeping successfully, the other has been dead for
   * weeks. Grouping by provider (the old behaviour) would pool both boards'
   * jobs under one "greenhouse" high-water mark, so the healthy board's fresh
   * sweep would make the dead board's stale jobs look freshly closed and park
   * them. Grouping by board must keep them completely isolated.
   */
  it("never parks a dead board's jobs just because a healthy sibling board shares its provider", () => {
    const jobs: ParkCandidate[] = [
      // healthy board: swept today, nothing stale.
      { id: "healthy-job", board: "greenhouse:healthyco", lastSeen: iso(0), status: "NEW" },
      // dead board: has not swept in 30 days, but its own last sighting is
      // exactly as old as its own board's high-water mark - not stale.
      { id: "dead-job", board: "greenhouse:deadco", lastSeen: iso(30), status: "NEW" },
    ];
    const plan = planParking(
      jobs,
      newest({ "greenhouse:healthyco": 0, "greenhouse:deadco": 30 }),
      OPTS,
    );
    expect(plan.park).toEqual([]);
    expect(plan.refusedSources).toEqual([]);
  });
});

import { memoryRepo, seedJob, TEST_EVIDENCE_HASH } from "./helpers/db.js";

/**
 * The SQL side of parking. `planParking` already refuses to nominate a
 * human-set status, but `parkJobs` writes the status column, so the guarantee
 * must not depend on the caller having filtered correctly.
 */
describe("JobRepo.parkJobs", () => {
  it("parks the ids it is given", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "a", status: "NEW" });
    seedJob(db, { id: "b", status: "REVIEWED" });
    expect(repo.parkJobs(["a", "b"])).toBe(2);
    const status = (id: string) =>
      (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
    expect(status("a")).toBe("CLOSED");
    expect(status("b")).toBe("CLOSED");
  });

  it("refuses a human-set status even when told to park it", () => {
    // Defence in depth: this is the write that could destroy a record of work.
    const { repo, db } = memoryRepo();
    for (const s of ["APPLIED", "SCREEN", "OFFER", "SKIPPED", "REJECTED"]) {
      seedJob(db, { id: `j${s}`, status: s });
    }
    expect(repo.parkJobs(["jAPPLIED", "jSCREEN", "jOFFER", "jSKIPPED", "jREJECTED"])).toBe(0);
    for (const s of ["APPLIED", "SCREEN", "OFFER", "SKIPPED", "REJECTED"]) {
      const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(`j${s}`) as { status: string };
      expect(row.status).toBe(s);
    }
  });

  it("does nothing on an empty list", () => {
    const { repo } = memoryRepo();
    expect(repo.parkJobs([])).toBe(0);
  });
});

describe("parked postings leave the pools", () => {
  it("is not offered for paid analysis", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "closed", company: "Alpha", applicationRoi: 99, fitScore: 99, status: "CLOSED" });
    seedJob(db, { id: "open", company: "Beta", applicationRoi: 10, fitScore: 10, status: "NEW" });
    const picked = repo.needingAnalysis(
      10,
      {
        perCompanyCap: 2, backfillCap: 3, coldAfter: 6, unexploredBonus: 8, coldPenalty: 15,
        freshDays: 21, freshBonus: 12, evergreenDays: null, maxAttempts: 2,
      },
      TEST_EVIDENCE_HASH,
    );
    expect(picked.map((j) => j.id)).toEqual(["open"]);
  });

  it("is not in the rankings, even with --all", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "closed", applicationRoi: 99, fitScore: 99, status: "CLOSED" });
    expect(repo.top({ minFit: 0, limit: 10 })).toHaveLength(0);
    expect(repo.top({ minFit: 0, limit: 10, includeReviewed: true })).toHaveLength(0);
  });
});
