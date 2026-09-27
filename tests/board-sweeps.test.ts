import { describe, it, expect } from "vitest";
import { RunStats } from "../src/lib/log.js";
import { computeOutcome } from "../src/pipeline/ingest.js";
import { planParking, newestByBoard } from "../src/model/freshness.js";
import { isAutoParkable } from "../src/model/status.js";
import { memoryRepo } from "./helpers/db.js";
import type { NormalizedJob } from "../src/model/job.js";

/**
 * JOB-50. Freshness and parking used to key on `source` - the ATS provider
 * ("greenhouse") - not on employer-board identity ("greenhouse:acme"). Two
 * employer boards on the same provider are otherwise independent: one can go
 * dark while the other keeps refreshing normally. Keying on provider let the
 * healthy board's fresh sweep advance the SAME high-water mark the dead
 * board was judged against, so the dead board's stale jobs looked freshly
 * closed purely because a same-provider sibling happened to be healthy.
 *
 * This file pins the mechanism end to end: RunStats.sweep -> repo.recordBoardSweep
 * -> repo.boardSweepSightings -> newestByBoard -> planParking, with the
 * literal two-boards-one-fails reproduction as the centrepiece.
 */

const NOW = Date.parse("2026-09-26T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

/** Insert a job row with full control over board_id, status, and last_seen. */
function seedJobOnBoard(
  db: ReturnType<typeof memoryRepo>["db"],
  opts: { id: string; board: string; source: string; lastSeen: string; status?: string },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (
       id, dedupe_key, external_id, source, board_id, source_url, company, company_normalized,
       title, title_normalized, date_discovered, first_seen, last_seen, description_hash,
       status, filter_passed
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  ).run(
    opts.id,
    `dedupe-${opts.id}`,
    `ext-${opts.id}`,
    opts.source,
    opts.board,
    `https://example.test/${opts.id}`,
    "Acme",
    "acme",
    "Staff Engineer",
    "staff engineer",
    now,
    now,
    opts.lastSeen,
    `hash-${opts.id}`,
    opts.status ?? "NEW",
  );
}

describe("RunStats.sweep", () => {
  it("records one board result per call, exposed as sweeps", () => {
    const stats = new RunStats();
    stats.sweep("greenhouse:acme", "greenhouse", true, 42);
    stats.sweep("greenhouse:widgetco", "greenhouse", false, 0);
    expect(stats.sweeps).toEqual([
      { boardId: "greenhouse:acme", provider: "greenhouse", ok: true, jobCount: 42 },
      { boardId: "greenhouse:widgetco", provider: "greenhouse", ok: false, jobCount: 0 },
    ]);
  });

  it("does not affect bump/fail counters, which stay independent", () => {
    const stats = new RunStats();
    stats.sweep("greenhouse:acme", "greenhouse", false, 0);
    expect(stats.failureCount).toBe(0);
    expect(stats.get("greenhouse.boards_failed")).toBe(0);
  });
});

describe("computeOutcome", () => {
  it("is ok when every attempted board succeeded", () => {
    expect(computeOutcome([{ ok: true }, { ok: true }])).toBe("ok");
  });

  it("is degraded when some boards failed and some succeeded", () => {
    expect(computeOutcome([{ ok: true }, { ok: false }])).toBe("degraded");
  });

  it("is failed when every attempted board failed", () => {
    expect(computeOutcome([{ ok: false }, { ok: false }])).toBe("failed");
  });

  it("is failed when nothing was attempted - nothing was refreshed either way", () => {
    expect(computeOutcome([])).toBe("failed");
  });
});

describe("JobRepo.recordBoardSweep + boardSweepSightings", () => {
  it("advances succeeded_at only on a successful attempt", () => {
    const { repo, db } = memoryRepo();
    repo.recordBoardSweep("greenhouse:acme", "greenhouse", true, 10);
    const first = db.prepare("SELECT succeeded_at FROM board_sweeps WHERE board_id = ?").get("greenhouse:acme") as {
      succeeded_at: string | null;
    };
    expect(first.succeeded_at).toBeTruthy();

    // A later failed attempt must not erase the earlier success.
    repo.recordBoardSweep("greenhouse:acme", "greenhouse", false, 0);
    const second = db.prepare("SELECT succeeded_at, status FROM board_sweeps WHERE board_id = ?").get(
      "greenhouse:acme",
    ) as { succeeded_at: string | null; status: string };
    expect(second.status).toBe("failed");
    expect(second.succeeded_at).toBe(first.succeeded_at);
  });

  it("surfaces succeeded_at through boardSweepSightings, keyed per board", () => {
    const { repo } = memoryRepo();
    repo.recordBoardSweep("greenhouse:healthyco", "greenhouse", true, 5);
    repo.recordBoardSweep("greenhouse:deadco", "greenhouse", false, 0);
    const sightings = repo.boardSweepSightings();
    const byBoard = new Map(sightings.map((s) => [s.board, s.lastSeen]));
    expect(byBoard.get("greenhouse:healthyco")).toBeTruthy();
    expect(byBoard.get("greenhouse:deadco")).toBeNull();
  });
});

describe("JobRepo.upsert writes board_id", () => {
  function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
    return {
      id: "j1",
      externalId: "acme:1",
      source: "greenhouse",
      board: "greenhouse:acme",
      ats: "greenhouse",
      sourceUrl: "https://example.test/j1",
      applicationUrl: null,
      company: "Acme",
      title: "Staff Engineer",
      location: "Remote",
      remoteStatus: "remote",
      employmentType: "full_time",
      seniority: "staff",
      datePosted: null,
      dateDiscovered: new Date().toISOString(),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: "USD",
      salaryPeriod: null,
      descriptionClean: "Build things.",
      descriptionHash: "hash-1",
      materialHash: "material-1",
      department: null,
      team: null,
      companySizeEstimate: null,
      companyStage: null,
      industry: null,
      ...over,
    } as NormalizedJob;
  }

  it("sets board_id on insert", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    const row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string };
    expect(row.board_id).toBe("greenhouse:acme");
  });

  it("reads board_id back through the repo", () => {
    const { repo } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    expect(repo.get("j1")!.board).toBe("greenhouse:acme");
  });
});

/**
 * THE LITERAL JOB-50 REPRODUCTION.
 *
 * Two employer boards, same ATS provider. This run's sweep succeeds for one
 * and fails for the other. Confirm the failing board's own (long-unseen)
 * jobs are not parked just because its healthy sibling refreshed today.
 */
describe("the two-boards-one-fails regression", () => {
  const OPTS = { afterDays: 3, maxFractionPerSource: 0.5, isParkable: isAutoParkable };

  it("never parks a dead board's jobs because a healthy sibling board on the same provider swept today", () => {
    const { repo, db } = memoryRepo();

    // Both boards are "greenhouse". healthyco is fine; deadco has been
    // failing to sweep for a month, but its last real sighting of this job
    // is only just past the parking threshold.
    seedJobOnBoard(db, { id: "healthy-job", board: "greenhouse:healthyco", source: "greenhouse", lastSeen: iso(0) });
    seedJobOnBoard(db, { id: "dead-job", board: "greenhouse:deadco", source: "greenhouse", lastSeen: iso(30) });

    // This run's sweep: healthyco succeeded, deadco failed.
    repo.recordBoardSweep("greenhouse:healthyco", "greenhouse", true, 50);
    repo.recordBoardSweep("greenhouse:deadco", "greenhouse", false, 0);

    const newest = newestByBoard(repo.boardSweepSightings());
    const plan = planParking(repo.parkCandidates(), newest, OPTS);

    // The old provider-keyed bug would have parked dead-job here: grouping by
    // "greenhouse" would have used healthyco's fresh succeeded_at as the
    // high-water mark for BOTH boards, making dead-job's 30-day-old sighting
    // look freshly closed. Grouping by board must keep them isolated.
    expect(plan.park).not.toContain("dead-job");
    expect(plan.park).toEqual([]);

    const parked = repo.parkJobs(plan.park);
    expect(parked).toBe(0);
    const status = (id: string) => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
    expect(status("dead-job")).toBe("NEW");
    expect(status("healthy-job")).toBe("NEW");
  });

  it("does park a job whose OWN board kept sweeping successfully but stopped listing it", () => {
    const { repo, db } = memoryRepo();

    seedJobOnBoard(db, { id: "gone", board: "greenhouse:acme", source: "greenhouse", lastSeen: iso(10) });
    seedJobOnBoard(db, { id: "here", board: "greenhouse:acme", source: "greenhouse", lastSeen: iso(0) });

    // acme's own board swept successfully just now (job "here" proves it).
    repo.recordBoardSweep("greenhouse:acme", "greenhouse", true, 1);

    const newest = newestByBoard(repo.boardSweepSightings());
    const plan = planParking(repo.parkCandidates(), newest, OPTS);

    expect(plan.park).toEqual(["gone"]);
    repo.parkJobs(plan.park);
    const status = (id: string) => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;
    expect(status("gone")).toBe("CLOSED");
    expect(status("here")).toBe("NEW");
  });

  it("maxFractionPerSource is now scoped per board, not diluted across a shared provider", () => {
    const { repo, db } = memoryRepo();

    // smallboard: 1 of 1 parkable jobs would go - refused (100% > 50%).
    seedJobOnBoard(db, { id: "small-stale", board: "greenhouse:smallboard", source: "greenhouse", lastSeen: iso(10) });
    // bigboard: 1 of 10 parkable jobs would go - allowed (10% <= 50%).
    seedJobOnBoard(db, { id: "big-stale", board: "greenhouse:bigboard", source: "greenhouse", lastSeen: iso(10) });
    for (let i = 0; i < 9; i++) {
      seedJobOnBoard(db, { id: `big-fresh-${i}`, board: "greenhouse:bigboard", source: "greenhouse", lastSeen: iso(0) });
    }

    repo.recordBoardSweep("greenhouse:smallboard", "greenhouse", true, 1);
    repo.recordBoardSweep("greenhouse:bigboard", "greenhouse", true, 10);

    const newest = newestByBoard(repo.boardSweepSightings());
    const plan = planParking(repo.parkCandidates(), newest, OPTS);

    // Under the old provider-wide grouping both boards would have pooled
    // into one "greenhouse" bucket (2 of 11 parkable = 18%, both allowed).
    // Scoped per board, smallboard's 1-of-1 is refused on its own.
    expect(plan.park).toEqual(["big-stale"]);
    expect(plan.refusedSources).toEqual([{ board: "greenhouse:smallboard", wouldPark: 1, total: 1 }]);
  });
});
