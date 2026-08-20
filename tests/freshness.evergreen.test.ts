import { describe, it, expect } from "vitest";
import { formatAge, isEvergreen, postingAgeDays } from "../src/model/freshness.js";

const NOW = Date.parse("2026-08-20T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("postingAgeDays", () => {
  it("measures the posting's own age, not when it was last swept", () => {
    expect(postingAgeDays(daysAgo(10), NOW)).toBeCloseTo(10, 5);
    expect(postingAgeDays(daysAgo(0), NOW)).toBeCloseTo(0, 5);
  });

  it("returns null when the board did not publish a date", () => {
    expect(postingAgeDays(null, NOW)).toBeNull();
    expect(postingAgeDays("not a date", NOW)).toBeNull();
  });
});

describe("isEvergreen", () => {
  it("catches the six-month-old requisition", () => {
    // Hightouch Deployment Architect, 219 days old, was being recommended.
    expect(isEvergreen(daysAgo(219), 180, NOW)).toBe(true);
    expect(isEvergreen(daysAgo(295), 180, NOW)).toBe(true);
  });

  it("leaves the normal range alone", () => {
    // The measured constraint: a tight cutoff guts the pool. Resend at 77
    // days was the best fit in the entire index.
    expect(isEvergreen(daysAgo(77), 180, NOW)).toBe(false);
    expect(isEvergreen(daysAgo(125), 180, NOW)).toBe(false);
    expect(isEvergreen(daysAgo(179), 180, NOW)).toBe(false);
  });

  it("is exclusive at the boundary", () => {
    expect(isEvergreen(daysAgo(180), 180, NOW)).toBe(false);
    expect(isEvergreen(daysAgo(181), 180, NOW)).toBe(true);
  });

  it("never treats an unknown date as evergreen", () => {
    // Missing data is not disqualifying data. A board that publishes no date
    // says nothing about the posting; excluding it would be the same defect as
    // rejecting a location field that only reads "Hybrid".
    expect(isEvergreen(null, 180, NOW)).toBe(false);
    expect(isEvergreen("", 180, NOW)).toBe(false);
    expect(isEvergreen("garbage", 180, NOW)).toBe(false);
  });

  it("does not treat a future date as evergreen", () => {
    expect(isEvergreen(new Date(NOW + 86_400_000).toISOString(), 180, NOW)).toBe(false);
  });
});

describe("formatAge", () => {
  it("distinguishes unknown from today", () => {
    // A bare "0d" for an unknown date would read as "posted this morning".
    expect(formatAge(null)).toBe("?");
    expect(formatAge(0)).toBe("0d");
  });

  it("caps at a year so the column stays narrow", () => {
    expect(formatAge(77)).toBe("77d");
    expect(formatAge(364)).toBe("364d");
    expect(formatAge(365)).toBe("1y+");
    expect(formatAge(900)).toBe("1y+");
  });
});
