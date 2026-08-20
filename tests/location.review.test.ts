import { describe, it, expect } from "vitest";
import { assessLocation, statesAPlace } from "../src/lib/location.js";

const PREFS = {
  homeMetro: "Austin",
  remoteOk: true,
  hybridMetros: ["Austin"],
  onsiteOkMetros: ["Austin"],
  relocationOk: false,
};

/**
 * JOB-35. 213 postings whose location field reads exactly "Hybrid" were
 * rejected as "Hybrid outside acceptable metros (Hybrid)" - a sentence that
 * treats the absence of a city as evidence of the wrong city.
 */
describe("statesAPlace", () => {
  it("says no when the value is only a work arrangement", () => {
    for (const v of ["Hybrid", "hybrid", "Remote", "On-site", "Onsite", "In-Office", "Flexible", "WFH"]) {
      expect(statesAPlace(v)).toBe(false);
    }
  });

  it("says no for arrangement words joined by punctuation", () => {
    for (const v of ["Hybrid / Remote", "Remote - Hybrid", "Hybrid, Flexible", "On-site (Full-time)"]) {
      expect(statesAPlace(v)).toBe(false);
    }
  });

  it("says yes as soon as a place appears", () => {
    // The anchoring that keeps this from rescuing real rejections.
    for (const v of [
      "Hybrid - San Francisco",
      "San Francisco, US (Hybrid)",
      "Hybrid, San Francisco",
      "London",
      "Austin, TX",
      "Remote - US",
    ]) {
      expect(statesAPlace(v)).toBe(true);
    }
  });

  it("says no for empty", () => {
    expect(statesAPlace("")).toBe(false);
    expect(statesAPlace("   ")).toBe(false);
  });
});

describe("assessLocation with a placeless value", () => {
  it("no longer rejects a posting whose location is just 'Hybrid'", () => {
    const v = assessLocation("Hybrid", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.needsLocationReview).toBe(true);
    expect(v.reason).toContain("Location unknown - review");
  });

  it("still rejects a hybrid role in a metro that is genuinely wrong", () => {
    // The 213 must be rescued without rescuing the 144 San Francisco ones,
    // which are rejections on real evidence.
    const v = assessLocation("Hybrid - San Francisco", PREFS);
    expect(v.acceptable).toBe(false);
    expect(v.needsLocationReview).toBe(false);
    expect(v.reason).toContain("outside acceptable metros");
  });

  it("still accepts a hybrid role in an acceptable metro", () => {
    const v = assessLocation("Hybrid - Austin, TX", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.needsLocationReview).toBe(false);
  });

  it("treats a placeless onsite value as unknown too", () => {
    const v = assessLocation("On-site", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.needsLocationReview).toBe(true);
  });

  it("still rejects an onsite role in a named foreign city", () => {
    const v = assessLocation("London", PREFS);
    expect(v.acceptable).toBe(false);
    expect(v.needsLocationReview).toBe(false);
  });

  it("flags a posting with no location at all for review", () => {
    const v = assessLocation(null, PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.needsLocationReview).toBe(true);
    expect(v.reason).toContain("Location unknown - review");
  });

  it("does not rescue a non-US remote scope", () => {
    // Geo-blocking is a rejection on evidence and must survive this change.
    const v = assessLocation("Remote - Germany", PREFS);
    expect(v.acceptable).toBe(false);
    expect(v.geoBlocked).toBe(true);
  });
});
