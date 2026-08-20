import { describe, it, expect } from "vitest";
import { scoreSources, type SourceRow, type SourcePolicy } from "../src/stats/sources.js";

const POLICY: SourcePolicy = {
  minAnalyzedForVerdict: 30,
  retireBelowApplyRate: 0.04,
  watchBelowSelectionRate: 0.1,
  minPassedForSelectionVerdict: 100,
};

const row = (over: Partial<SourceRow>): SourceRow => ({
  source: "x", ingested: 0, passed: 0, analyzed: 0, applies: 0, appliedTo: 0, closed: 0, ...over,
});

/**
 * JOB-37. Boards were added because the companies seemed interesting, not
 * because they post roles that match.
 */
describe("scoreSources", () => {
  it("calls a source productive when it earns applies", () => {
    // greenhouse, real numbers.
    const [s] = scoreSources([row({ source: "greenhouse", ingested: 7590, passed: 1077, analyzed: 259, applies: 17 })], POLICY);
    expect(s!.verdict).toBe("productive");
    expect(s!.applyRate).toBeCloseTo(0.066, 2);
  });

  it("REFUSES to condemn a source on a small sample", () => {
    // The mistake this guards against. At a ~8% baseline, six analyses
    // returning zero applies is the expected outcome most of the time. It is
    // not a bad source, it is a small number.
    const [s] = scoreSources([row({ source: "new", ingested: 60, passed: 20, analyzed: 6, applies: 0 })], POLICY);
    expect(s!.verdict).toBe("insufficient data");
    expect(s!.why).toContain("small number");
  });

  it("retires a source that floods the pool and never ranks, without waiting for analyses", () => {
    // remoteok, real numbers. Selection evidence is FREE, so a source whose
    // jobs never rank can be judged without spending anything - otherwise it
    // sits at "insufficient data" forever, which is the trap.
    const [s] = scoreSources([row({ source: "remoteok", ingested: 273, passed: 227, analyzed: 6, applies: 0 })], POLICY);
    expect(s!.verdict).toBe("retire");
    expect(s!.why).toContain("without competing");
  });

  it("does not apply the selection verdict to a source with too few passing jobs", () => {
    // lever, real numbers: 50 passed is below the bar, so it stays undecided
    // rather than being retired on a thin record.
    const [s] = scoreSources([row({ source: "lever", ingested: 346, passed: 50, analyzed: 8, applies: 1 })], POLICY);
    expect(s!.verdict).toBe("insufficient data");
  });

  it("retires a well-sampled source with a genuinely poor apply rate", () => {
    const [s] = scoreSources([row({ source: "dud", ingested: 900, passed: 400, analyzed: 100, applies: 1 })], POLICY);
    expect(s!.verdict).toBe("retire");
    expect(s!.why).toContain("1 applies from 100 analyses");
  });

  it("handles a source that has ingested nothing without dividing by zero", () => {
    const [s] = scoreSources([row({ source: "empty" })], POLICY);
    expect(s!.passRate).toBe(0);
    expect(s!.selectionRate).toBe(0);
    expect(s!.applyRate).toBe(0);
    expect(s!.verdict).toBe("insufficient data");
  });

  it("orders by applies so the productive sources read first", () => {
    const scored = scoreSources(
      [
        row({ source: "b", ingested: 100, passed: 50, analyzed: 40, applies: 2 }),
        row({ source: "a", ingested: 100, passed: 50, analyzed: 40, applies: 9 }),
      ],
      POLICY,
    );
    expect(scored.map((s) => s.source)).toEqual(["a", "b"]);
  });
});
