import { describe, it, expect } from "vitest";
import { resolveAnalyzeOptions } from "../src/analysis/budget.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "../src/analysis/analyzer.js";
import type { CareerProfile } from "../src/config/schema.js";

const profile = {
  scoring: { max_spend_per_run_usd: 1.5, evergreen_days: 180 },
} as unknown as CareerProfile;

/**
 * JOB-38. The decision that bounds spend was written out twice, inline, in two
 * command bodies - and they drifted. `analyze` resolved a ceiling; the `daily`
 * path resolved none, so `shouldStopForBudget` saw `undefined`, returned false
 * on every check, and the daily pass ran UNCAPPED.
 *
 * That is the ceiling's own failure case, in its worst form: `daily` is the
 * path that runs unattended on a timer.
 */
describe("resolveAnalyzeOptions", () => {
  it("ALWAYS produces a spend ceiling, whatever the caller passed", () => {
    // The regression guard. `undefined` means "no ceiling" downstream, and no
    // caller should be able to reach that state by omission.
    for (const flags of [{}, { limit: "8" }, { dryRun: true }, { minFit: "40" }]) {
      const o = resolveAnalyzeOptions(flags, profile);
      expect(o.maxSpendUsd).toBe(1.5);
      expect(o.maxSpendUsd).not.toBeUndefined();
    }
  });

  it("gives the daily path a ceiling too", () => {
    // The exact call the daily pass makes.
    const o = resolveAnalyzeOptions({ limit: "8" }, profile, {}, 8);
    expect(o.maxSpendUsd).toBe(1.5);
    expect(o.limit).toBe(8);
  });

  it("lets an explicit flag override the configured ceiling", () => {
    expect(resolveAnalyzeOptions({ maxSpend: "0.25" }, profile).maxSpendUsd).toBe(0.25);
  });

  it("refuses a mistyped ceiling rather than falling through to none", () => {
    // Number("1.5O") is NaN, NaN fails every comparison, and `spent >= NaN` is
    // false - so a typo would have removed the ceiling.
    expect(() => resolveAnalyzeOptions({ maxSpend: "1.5O" }, profile)).toThrow(/--max-spend expects a number/);
    expect(() => resolveAnalyzeOptions({ maxSpend: "-1" }, profile)).toThrow(/must not be negative/);
  });

  it("uses the caller's default limit, and lets a flag beat it", () => {
    expect(resolveAnalyzeOptions({}, profile, {}, 8).limit).toBe(8);
    expect(resolveAnalyzeOptions({}, profile, {}, 10).limit).toBe(10);
    expect(resolveAnalyzeOptions({ limit: "3" }, profile, {}, 8).limit).toBe(3);
    // A garbage limit falls back rather than becoming NaN - it bounds job
    // count, not money, so the forgiving idiom is safe here.
    expect(resolveAnalyzeOptions({ limit: "abc" }, profile, {}, 8).limit).toBe(8);
  });

  it("has no absolute fit floor unless one is asked for", () => {
    expect(resolveAnalyzeOptions({}, profile).minFit).toBeUndefined();
    expect(resolveAnalyzeOptions({ minFit: "0" }, profile).minFit).toBe(0);
    expect(resolveAnalyzeOptions({ minFit: "45" }, profile).minFit).toBe(45);
  });

  it("prefers a flag over the environment over the built-in default", () => {
    expect(resolveAnalyzeOptions({ model: "m-flag" }, profile, { model: "m-env" }).model).toBe("m-flag");
    expect(resolveAnalyzeOptions({}, profile, { model: "m-env" }).model).toBe("m-env");
    expect(resolveAnalyzeOptions({}, profile, {}).model).toBe(DEFAULT_MODEL);
    expect(resolveAnalyzeOptions({}, profile, {}).effort).toBe(DEFAULT_EFFORT);
  });

  it("defaults the optional switches off rather than to undefined-by-accident", () => {
    const o = resolveAnalyzeOptions({}, profile);
    expect(o.includeEvergreen).toBe(false);
    expect(o.dryRun).toBe(false);
    expect(o.twoStage).toBeUndefined();
  });
});
