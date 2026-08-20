import { describe, it, expect } from "vitest";
import { shouldStopForBudget } from "../src/analysis/analyzer.js";
import { estimateCostUsd } from "../src/lib/cost.js";
import { loadProfile } from "../src/config/load.js";

/**
 * `--limit` bounded how many jobs a pass looked at. Nothing bounded the bill.
 * Three routine passes in one afternoon came to $4.30 and a fortnight to
 * $19.54, with the first real feedback arriving on a credit-card statement.
 */
describe("spend ceiling", () => {
  it("ships a ceiling by default rather than leaving it opt-in", () => {
    const profile = loadProfile();
    expect(profile.scoring.max_spend_per_run_usd).toBeGreaterThan(0);
  });

  /*
   * Checked BEFORE the call that would cross it, never after. After the call
   * the limit is advisory: the run reports having exceeded it and the money is
   * already gone.
   */
  it("stops once spend has reached the ceiling", () => {
    expect(shouldStopForBudget(1.5, 1.5)).toBe(true);
    expect(shouldStopForBudget(1.51, 1.5)).toBe(true);
  });

  it("keeps going below the ceiling", () => {
    expect(shouldStopForBudget(1.49, 1.5)).toBe(false);
    expect(shouldStopForBudget(0, 1.5)).toBe(false);
  });

  /*
   * At exactly the ceiling the budget is used up. Treating that as "not yet
   * over" and paying for one more job is how a ceiling becomes a suggestion -
   * and at Opus rates one more job is another $0.046.
   */
  it("treats exactly-at-the-ceiling as spent, not as headroom", () => {
    expect(shouldStopForBudget(1.5, 1.5)).toBe(true);
  });

  it("imposes no ceiling when none is configured", () => {
    expect(shouldStopForBudget(9999, undefined)).toBe(false);
  });

  it("costs what the ceiling implies at Opus rates", () => {
    // Sanity-check the default is a real bound: 1.5 USD is ~32 jobs at the
    // measured $0.046/job, not a number so high it never fires.
    const perJob = estimateCostUsd({ input: 2400, cacheRead: 2800, output: 1300 }, "claude-opus-5");
    expect(perJob).toBeGreaterThan(0.02);
    expect(1.5 / perJob).toBeLessThan(60);
  });
});

/**
 * Found while benchmarking cheaper models: Haiku 4.5 rejects
 * `output_config.effort` with a 400, so passing it unconditionally made
 * `analyze --model claude-haiku-4-5` fail on every single job.
 */
