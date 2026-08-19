import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";

/**
 * JOB-25. `analyze` reported "nothing to analyze: no unanalyzed jobs above the
 * fit threshold" whenever the gate was above the pool, which reads as an
 * exhausted index. It was not: the gate sat at 55 while the entire remaining
 * pool topped out at 44, hiding roles that later analyzed into strong
 * recommendations (Vercel Site Engineer raw 54 -> fit 84, Resend raw 21 ->
 * fit 72).
 *
 * "Nothing above the threshold" and "nothing worth looking at" are different
 * statements and must not print the same way.
 */

describe("what the gate is holding back", () => {
  it("counts the jobs sitting below the threshold and names the best", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { fitScore: 44 });
    seedJob(db, { fitScore: 38 });
    seedJob(db, { fitScore: 12 });

    const below = repo.belowThreshold(55);
    expect(below.count).toBe(3);
    expect(below.best).toBe(44);
  });

  it("reports zero when the pool really is exhausted", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { fitScore: 80 });
    expect(repo.belowThreshold(55).count).toBe(0);
    expect(repo.belowThreshold(55).best).toBeNull();
  });

  it("excludes jobs already above the threshold", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { fitScore: 70 });
    seedJob(db, { fitScore: 30 });
    expect(repo.belowThreshold(55).count).toBe(1);
  });

  it("moves with the threshold", () => {
    const { repo, db } = memoryRepo();
    for (const f of [50, 40, 30, 20]) seedJob(db, { fitScore: f });
    expect(repo.belowThreshold(55).count).toBe(4);
    expect(repo.belowThreshold(35).count).toBe(2);
    expect(repo.belowThreshold(15).count).toBe(0);
  });

  it("ignores jobs the human has already dismissed", () => {
    // A skipped or rejected job is not something the gate is withholding.
    const { repo, db } = memoryRepo();
    seedJob(db, { fitScore: 40, status: "SKIPPED" });
    seedJob(db, { fitScore: 40, status: "REJECTED" });
    seedJob(db, { fitScore: 40, status: "NEW" });
    expect(repo.belowThreshold(55).count).toBe(1);
  });
});
