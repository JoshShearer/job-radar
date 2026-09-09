import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";
import { resolveAnalyzeOptions } from "../src/analysis/budget.js";
import type { AnalysisDiversity } from "../src/db/repo.js";
import type { CareerProfile } from "../src/config/schema.js";

/**
 * `analyze` was a speculative batch enrichment of the top-K index: of 329
 * analyzed jobs 242 still sat at NEW and 54 closed before anyone looked - 10%
 * utilization - while 12 of 43 applications went to jobs never analyzed at
 * all, because the verdict was absent when it was needed.
 *
 * Triage goes wide; the dossier fires on intent.
 */

const DIVERSITY: AnalysisDiversity = {
  perCompanyCap: 2,
  backfillCap: 4,
  coldAfter: 5,
  unexploredBonus: 10,
  coldPenalty: 10,
  freshDays: 30,
  freshBonus: 5,
  evergreenDays: null,
  maxAttempts: 2,
};

const profile = {
  scoring: { max_spend_per_run_usd: 5 },
} as unknown as CareerProfile;

function eligible(db: ReturnType<typeof memoryRepo>["db"], company: string, roi: number): string {
  const id = seedJob(db, { company, title: "Engineer", applicationRoi: roi, fitScore: roi });
  db.prepare("UPDATE jobs SET filter_passed = 1 WHERE id = ?").run(id);
  return id;
}

describe("eligibleForAnalysis sizes the slate", () => {
  it("counts every eligible posting, not the top of the ranking", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 25; i++) eligible(db, `Co${i}`, 50 + i);
    expect(repo.eligibleForAnalysis(DIVERSITY)).toBe(25);
    // The ranked selection is still capped by its limit - that is the whole
    // difference between a top-K pass and a slate pass.
    expect(repo.needingAnalysis(10, DIVERSITY)).toHaveLength(10);
  });

  it("excludes what needingAnalysis excludes, so the two agree", () => {
    const { repo, db } = memoryRepo();
    eligible(db, "Acme", 90);
    const filtered = seedJob(db, { company: "Beta", title: "Engineer", applicationRoi: 95, fitScore: 95 });
    db.prepare("UPDATE jobs SET filter_passed = 0 WHERE id = ?").run(filtered);
    const analyzed = eligible(db, "Gamma", 80);
    repo.saveAnalysis(analyzed, { recommendation: "skip" } as never, "m");
    const closed = eligible(db, "Delta", 70);
    db.prepare("UPDATE jobs SET status = 'CLOSED' WHERE id = ?").run(closed);

    expect(repo.eligibleForAnalysis(DIVERSITY)).toBe(1);
    expect(repo.needingAnalysis(50, DIVERSITY)).toHaveLength(1);
  });

  it("respects a fit floor the same way the selection does", () => {
    const { repo, db } = memoryRepo();
    eligible(db, "Acme", 90);
    eligible(db, "Beta", 20);
    expect(repo.eligibleForAnalysis(DIVERSITY, 50)).toBe(1);
  });

  it("counts past the per-company cap, because the cap shapes a pass and not the slate", () => {
    // The diversity cap exists to stop one employer taking a whole pass. It is
    // not a statement about how much work remains, so the slate size must not
    // be silently reduced by it.
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 6; i++) eligible(db, "Acme", 50 + i);
    expect(repo.eligibleForAnalysis(DIVERSITY)).toBe(6);
    expect(repo.needingAnalysis(6, DIVERSITY).length).toBeLessThanOrEqual(6);
  });
});

describe("--slate is carried through to the analyzer", () => {
  it("is off by default, so the existing top-K pass is unchanged", () => {
    const o = resolveAnalyzeOptions({ limit: "10" }, profile);
    expect(o.slate).toBeUndefined();
    expect(o.limit).toBe(10);
  });

  it("is passed through when asked for", () => {
    expect(resolveAnalyzeOptions({ limit: "10", slate: true }, profile).slate).toBe(true);
  });

  it("leaves the spend ceiling in charge", () => {
    // Spend is bounded DIRECTLY by --limit and max_spend_per_run_usd, never by
    // a fit proxy - JOB-32 retired that and it is not coming back. A slate pass
    // that cannot finish stops on the ceiling and resumes next run.
    const o = resolveAnalyzeOptions({ limit: "10", slate: true }, profile);
    expect(o.maxSpendUsd).toBe(5);
    expect(o.minFit).toBeUndefined();
  });

  it("does not smuggle in a fit floor of its own", () => {
    expect(resolveAnalyzeOptions({ limit: "10", slate: true }, profile).minFit).toBeUndefined();
  });
});
