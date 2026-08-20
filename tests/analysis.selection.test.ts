import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";
import type { AnalysisDiversity } from "../src/db/repo.js";

/**
 * `needingAnalysis` decides where the only money this tool spends goes, and it
 * had no test at all - the in-memory helper used to build a schema missing the
 * migrated columns, so every query touching them failed in tests while working
 * in production, and nobody could write one.
 *
 * The bug these pin: 175 of the first 362 analyses went to 15 companies while
 * 245 companies with filter-passing jobs had never had a single job looked at.
 */

const DIVERSITY: AnalysisDiversity = {
  perCompanyCap: 2,
  backfillCap: 3,
  coldAfter: 6,
  unexploredBonus: 8,
  coldPenalty: 15,
  // Freshness off by default in these tests: seedJob writes no date_posted, and
  // a NULL date must never be treated as old. The evergreen tests below turn
  // it on explicitly.
  freshDays: 21,
  freshBonus: 12,
  evergreenDays: null,
};

/** Mark a job analyzed with a given recommendation, the way the analyzer does. */
function markAnalyzed(db: any, id: string, recommendation: string): void {
  db.prepare("UPDATE jobs SET analysis_json = ?, analyzed_at = ? WHERE id = ?").run(
    JSON.stringify({ recommendation, fitScore: 50 }),
    new Date().toISOString(),
    id,
  );
}

describe("needingAnalysis company diversity", () => {
  it("never lets one company exceed the backfill ceiling", () => {
    const { repo, db } = memoryRepo();
    // One employer, many open roles - the ClickUp shape.
    for (let i = 0; i < 20; i += 1) {
      seedJob(db, { id: `hog${i}`, company: "Hogzilla", applicationRoi: 90 - i, fitScore: 80 });
    }
    const picked = repo.needingAnalysis(10, DIVERSITY);
    expect(picked.length).toBe(DIVERSITY.backfillCap);
  });

  /*
   * The regression that actually happened. The old code capped the first pass
   * at 2 and then backfilled leftover budget with no cap whatsoever, so a
   * narrow pool removed the limit entirely: ClickUp took 3 analyses in a single
   * minute, and 16 across two days, for zero `apply` results.
   */
  it("caps the backfill pass, not just the first pass", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 20; i += 1) {
      seedJob(db, { id: `hog${i}`, company: "Hogzilla", applicationRoi: 90 - i, fitScore: 80 });
    }
    seedJob(db, { id: "other", company: "Smallco", applicationRoi: 10, fitScore: 20 });

    const picked = repo.needingAnalysis(10, DIVERSITY);
    const fromHog = picked.filter((j) => j.company === "Hogzilla").length;
    expect(fromHog).toBeLessThanOrEqual(DIVERSITY.backfillCap);
    expect(fromHog).toBeGreaterThan(DIVERSITY.perCompanyCap); // backfill did run
  });

  it("spreads a pass across companies rather than down one board", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 10; i += 1) {
      seedJob(db, { id: `hog${i}`, company: "Hogzilla", applicationRoi: 90, fitScore: 80 });
    }
    for (let i = 0; i < 10; i += 1) {
      seedJob(db, { id: `co${i}`, company: `Company${i}`, applicationRoi: 85, fitScore: 78 });
    }
    const picked = repo.needingAnalysis(10, DIVERSITY);
    const companies = new Set(picked.map((j) => j.company));
    expect(companies.size).toBeGreaterThanOrEqual(6);
  });

  it("promotes a company nobody has looked at over an equal-ROI known one", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "known-seen", company: "Known", applicationRoi: 60, fitScore: 60 });
    markAnalyzed(db, "known-seen", "skip");
    seedJob(db, { id: "known-next", company: "Known", applicationRoi: 60, fitScore: 60 });
    seedJob(db, { id: "fresh", company: "Unseen", applicationRoi: 60, fitScore: 60 });

    const picked = repo.needingAnalysis(1, DIVERSITY);
    expect(picked[0]!.company).toBe("Unseen");
  });

  /*
   * The nudge must not become a sort key. Ranking every unexplored company
   * above every known one would put a ROI-5 unknown ahead of a ROI-70 role at a
   * company that has already produced offers - worse than the concentration it
   * is fixing.
   */
  it("still prefers a much stronger role at a known company", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "known-seen", company: "Known", applicationRoi: 50, fitScore: 50 });
    markAnalyzed(db, "known-seen", "apply");
    seedJob(db, { id: "strong", company: "Known", applicationRoi: 70, fitScore: 70 });
    seedJob(db, { id: "weak-fresh", company: "Unseen", applicationRoi: 40, fitScore: 40 });

    const picked = repo.needingAnalysis(1, DIVERSITY);
    expect(picked[0]!.id).toBe("strong");
  });

  it("ranks a cold company behind one that has produced an apply", () => {
    const { repo, db } = memoryRepo();
    // Cold: past `coldAfter` analyses, never once `apply`.
    for (let i = 0; i < DIVERSITY.coldAfter; i += 1) {
      seedJob(db, { id: `cold${i}`, company: "ColdCo", applicationRoi: 50, fitScore: 50 });
      markAnalyzed(db, `cold${i}`, "skip");
    }
    seedJob(db, { id: "cold-next", company: "ColdCo", applicationRoi: 60, fitScore: 60 });

    seedJob(db, { id: "warm-seen", company: "WarmCo", applicationRoi: 50, fitScore: 50 });
    markAnalyzed(db, "warm-seen", "apply");
    seedJob(db, { id: "warm-next", company: "WarmCo", applicationRoi: 55, fitScore: 55 });

    const picked = repo.needingAnalysis(1, DIVERSITY);
    expect(picked[0]!.company).toBe("WarmCo");
  });

  it("deprioritises a cold company without excluding it", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < DIVERSITY.coldAfter; i += 1) {
      seedJob(db, { id: `cold${i}`, company: "ColdCo", applicationRoi: 50, fitScore: 50 });
      markAnalyzed(db, `cold${i}`, "skip");
    }
    seedJob(db, { id: "cold-next", company: "ColdCo", applicationRoi: 60, fitScore: 60 });

    // Nothing else to spend on: the cold company must still be reachable.
    const picked = repo.needingAnalysis(5, DIVERSITY);
    expect(picked.map((j) => j.id)).toContain("cold-next");
  });
});

/**
 * Selection is by RANK, not by an absolute score.
 *
 * The gate these replace was fed from `scoring.analysis_threshold`, which was
 * retired: the keyword engine's absolute score has a mean absolute error of
 * 26.6 points against the analyst, and its hit rate is not even monotonic
 * through the middle of the range. A gate set above what the scorer could
 * produce also made `analyze` claim an exhausted index while the index was
 * full.
 */
describe("needingAnalysis rank-based selection", () => {
  it("returns work when every candidate scores low, instead of refusing", () => {
    // The failure this replaces: a threshold of 60 against a pool topping out
    // at 44 reported "nothing to analyze" and read as an exhausted index.
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 5; i += 1) {
      seedJob(db, { id: `low${i}`, company: `Co${i}`, applicationRoi: 12 - i, fitScore: 9 });
    }
    const picked = repo.needingAnalysis(5, DIVERSITY);
    expect(picked.length).toBe(5);
  });

  it("orders by rank, best first", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "mid", company: "Beta", applicationRoi: 50, fitScore: 40 });
    seedJob(db, { id: "best", company: "Alpha", applicationRoi: 90, fitScore: 40 });
    seedJob(db, { id: "worst", company: "Gamma", applicationRoi: 10, fitScore: 40 });
    const picked = repo.needingAnalysis(3, DIVERSITY);
    expect(picked.map((j) => j.id)).toEqual(["best", "mid", "worst"]);
  });

  it("takes the top K and leaves the rest, so spend is bounded by limit", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 30; i += 1) {
      seedJob(db, { id: `j${i}`, company: `Co${i}`, applicationRoi: i, fitScore: 50 });
    }
    const picked = repo.needingAnalysis(4, DIVERSITY);
    expect(picked.length).toBe(4);
    // The four highest-ranked, not an arbitrary four.
    expect(picked.map((j) => j.id)).toEqual(["j29", "j28", "j27", "j26"]);
  });

  it("still honours an explicit floor when one is passed", () => {
    // `--min-fit` remains available as a deliberate per-pass choice.
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "high", company: "Alpha", applicationRoi: 50, fitScore: 80 });
    seedJob(db, { id: "low", company: "Beta", applicationRoi: 90, fitScore: 20 });
    const picked = repo.needingAnalysis(10, DIVERSITY, 50);
    expect(picked.map((j) => j.id)).toEqual(["high"]);
  });

  it("treats an explicit floor of 0 as a floor, not as absent", () => {
    // `0` is falsy; if the optional parameter were tested for truthiness
    // instead of nullness, a deliberate `--min-fit 0` would silently behave
    // the same as no flag. Here they agree, but the distinction must hold.
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "a", company: "Alpha", applicationRoi: 50, fitScore: 0 });
    expect(repo.needingAnalysis(10, DIVERSITY, 0).map((j) => j.id)).toEqual(["a"]);
  });

  it("returns nothing only when there is genuinely nothing left", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { company: "Alpha", applicationRoi: 90, fitScore: 90 });
    markAnalyzed(db, id, "skip");
    expect(repo.needingAnalysis(10, DIVERSITY)).toHaveLength(0);
  });
});

/** Set a posting date on an already-seeded job. */
function setPosted(db: any, id: string, daysAgo: number | null): void {
  db.prepare("UPDATE jobs SET date_posted = ? WHERE id = ?").run(
    daysAgo === null ? null : new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    id,
  );
}

/**
 * JOB-27. Freshness-first spend.
 *
 * Median posting age at apply was 55 days, not because the user was slow - all
 * 43 applications went out within 7 days of the tool first seeing the posting -
 * but because selection did not care how old a posting was.
 */
describe("needingAnalysis freshness", () => {
  const FRESH = { ...DIVERSITY, evergreenDays: 180 };

  it("does not pay to analyze a posting it would refuse to recommend", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "old", company: "Alpha", applicationRoi: 99, fitScore: 90 });
    seedJob(db, { id: "new", company: "Beta", applicationRoi: 10, fitScore: 10 });
    setPosted(db, "old", 300);
    setPosted(db, "new", 2);
    // The evergreen job outranks the fresh one on every other axis and is
    // still excluded, because nothing will ever recommend it.
    expect(repo.needingAnalysis(10, FRESH).map((j) => j.id)).toEqual(["new"]);
  });

  it("keeps a posting whose date the board never published", () => {
    // Unknown age is not old age. Excluding it would be the same defect as
    // rejecting a location field that only reads "Hybrid".
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "undated", company: "Alpha", applicationRoi: 50, fitScore: 50 });
    setPosted(db, "undated", null);
    expect(repo.needingAnalysis(10, FRESH).map((j) => j.id)).toEqual(["undated"]);
  });

  it("prefers the fresher posting when quality is comparable", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "stale", company: "Alpha", applicationRoi: 50, fitScore: 50 });
    seedJob(db, { id: "fresh", company: "Beta", applicationRoi: 45, fitScore: 50 });
    setPosted(db, "stale", 120);
    setPosted(db, "fresh", 3);
    // 45 + 12 (fresh bonus) beats 50.
    expect(repo.needingAnalysis(2, FRESH).map((j) => j.id)).toEqual(["fresh", "stale"]);
  });

  it("is a nudge, not a sort key - a clearly better old posting still wins", () => {
    // The failure mode of over-correcting: burning the budget on whatever
    // arrived most recently regardless of whether it fits.
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "goodold", company: "Alpha", applicationRoi: 80, fitScore: 80 });
    seedJob(db, { id: "weaknew", company: "Beta", applicationRoi: 20, fitScore: 20 });
    setPosted(db, "goodold", 120);
    setPosted(db, "weaknew", 1);
    expect(repo.needingAnalysis(2, FRESH).map((j) => j.id)).toEqual(["goodold", "weaknew"]);
  });

  it("keeps everything when the evergreen ceiling is off", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "ancient", company: "Alpha", applicationRoi: 50, fitScore: 50 });
    setPosted(db, "ancient", 900);
    expect(repo.needingAnalysis(10, { ...DIVERSITY, evergreenDays: null })).toHaveLength(1);
  });
});

describe("top evergreen exclusion", () => {
  it("hides the six-month-old requisition but keeps the four-month-old one", () => {
    // The measured constraint: a tight cutoff destroys the pool. 180 days cost
    // exactly one of eight apply-recommendations on the live index.
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "evergreen", company: "Alpha", applicationRoi: 90, fitScore: 90 });
    seedJob(db, { id: "aging", company: "Beta", applicationRoi: 80, fitScore: 80 });
    setPosted(db, "evergreen", 219);
    setPosted(db, "aging", 125);
    const shown = repo.top({ minFit: 0, limit: 10, evergreenDays: 180 });
    expect(shown.map((j) => j.id)).toEqual(["aging"]);
  });

  it("shows everything when the ceiling is lifted", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "evergreen", company: "Alpha", applicationRoi: 90, fitScore: 90 });
    setPosted(db, "evergreen", 219);
    expect(repo.top({ minFit: 0, limit: 10, evergreenDays: null })).toHaveLength(1);
    expect(repo.top({ minFit: 0, limit: 10 })).toHaveLength(1);
  });

  it("keeps an undated posting in the list", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "undated", company: "Alpha", applicationRoi: 90, fitScore: 90 });
    setPosted(db, "undated", null);
    expect(repo.top({ minFit: 0, limit: 10, evergreenDays: 180 }).map((j) => j.id)).toEqual(["undated"]);
  });
});
