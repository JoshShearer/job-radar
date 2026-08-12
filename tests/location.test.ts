import { describe, it, expect } from "vitest";
import { classifyRemote, assessLocation, cleanLocation, findAuthBlockers } from "../src/lib/location.js";

const PREFS = {
  homeMetro: "Austin, TX",
  remoteOk: true,
  hybridMetros: ["Austin", "Austin, TX"],
  onsiteOkMetros: ["Austin", "Austin, TX"],
  relocationOk: false,
};

describe("classifyRemote", () => {
  it("detects plain remote", () => {
    expect(classifyRemote("Remote")).toBe("remote");
    expect(classifyRemote("Remote - US")).toBe("remote");
    expect(classifyRemote("Remote (United States)")).toBe("remote");
    expect(classifyRemote("Fully Remote")).toBe("remote");
  });

  it("detects hybrid", () => {
    expect(classifyRemote("Hybrid - London")).toBe("hybrid");
    expect(classifyRemote("Austin, TX (Hybrid)")).toBe("hybrid");
  });

  it("detects onsite from a bare city", () => {
    expect(classifyRemote("San Francisco, CA")).toBe("onsite");
  });

  it("prefers the structured workplaceType field over the location string", () => {
    expect(classifyRemote("New York, NY", { workplaceType: "Remote" })).toBe("remote");
    expect(classifyRemote("New York, NY", { workplaceType: "Hybrid" })).toBe("hybrid");
  });

  it("uses the isRemote flag when there is no other signal", () => {
    expect(classifyRemote("", { isRemote: true })).toBe("remote");
  });

  it("returns unknown for an empty location with no hints", () => {
    expect(classifyRemote("")).toBe("unknown");
  });

  it("ranks hybrid above remote when both words appear", () => {
    // "Hybrid remote" is hybrid, not remote - getting this backwards sends
    // you to an office three days a week.
    expect(classifyRemote("Hybrid remote - Austin, TX")).toBe("hybrid");
  });
});

describe("assessLocation", () => {
  it("accepts fully remote", () => {
    const v = assessLocation("Remote - US", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.remoteStatus).toBe("remote");
  });

  it("accepts hybrid in Austin", () => {
    const v = assessLocation("Austin, TX (Hybrid)", PREFS);
    expect(v.acceptable).toBe(true);
  });

  it("rejects hybrid outside Austin", () => {
    const v = assessLocation("Hybrid - New York, NY", PREFS);
    expect(v.acceptable).toBe(false);
    expect(v.reason).toMatch(/relocation is off/i);
  });

  it("rejects onsite outside Austin", () => {
    const v = assessLocation("Seattle, WA", PREFS);
    expect(v.acceptable).toBe(false);
  });

  it("accepts onsite in Austin", () => {
    const v = assessLocation("Austin, TX", PREFS);
    expect(v.acceptable).toBe(true);
  });

  it("rejects remote scoped to a non-US region", () => {
    const v = assessLocation("Remote - EMEA", PREFS);
    expect(v.acceptable).toBe(false);
    expect(v.geoBlocked).toBe(true);
  });

  it("rejects a bare non-US country without an 'only' qualifier", () => {
    // Boards write "Remote - Canada", not "Remote - Canada only". Requiring
    // the qualifier let every non-US remote role through the filter.
    for (const loc of ["Remote - Canada", "Remote (Germany)", "Remote, India", "Remote - UK"]) {
      const v = assessLocation(loc, PREFS);
      expect(v.geoBlocked, `${loc} should be geo-blocked`).toBe(true);
      expect(v.acceptable).toBe(false);
    }
  });

  it("accepts a multi-region remote posting that includes the US", () => {
    for (const loc of ["Remote (US, Canada)", "Remote - North America", "Remote (Worldwide)"]) {
      const v = assessLocation(loc, PREFS);
      expect(v.acceptable, `${loc} should be acceptable`).toBe(true);
      expect(v.geoBlocked).toBe(false);
    }
  });

  it("does not let a US city name containing 'us' trigger a false US scope", () => {
    // "Austin" contains the letters "us"; word boundaries must prevent that
    // from reading as a US-scope declaration on a foreign posting.
    const v = assessLocation("Remote - Australia", PREFS);
    expect(v.geoBlocked).toBe(true);
  });

  it("accepts remote scoped to the US even when other regions are named", () => {
    const v = assessLocation("Remote (US)", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.geoBlocked).toBe(false);
  });

  it("does not reject an unstated location, but flags it", () => {
    const v = assessLocation("", PREFS);
    expect(v.acceptable).toBe(true);
    expect(v.reason).toMatch(/not stated/i);
  });
});

describe("cleanLocation", () => {
  it("collapses whitespace and separators", () => {
    expect(cleanLocation("  Austin,   TX  ")).toBe("Austin, TX");
    expect(cleanLocation("Austin;TX")).toBe("Austin, TX");
  });
  it("handles null", () => {
    expect(cleanLocation(null)).toBe("");
  });
});

describe("findAuthBlockers", () => {
  const blockers = ["security clearance", "must be a us citizen"];

  it("finds a stated clearance requirement", () => {
    const found = findAuthBlockers("Applicants must hold an active security clearance.", blockers);
    expect(found).toContain("security clearance");
  });

  it("returns empty when nothing matches", () => {
    expect(findAuthBlockers("We sponsor visas.", blockers)).toEqual([]);
  });
});
