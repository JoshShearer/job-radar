import { describe, it, expect } from "vitest";
import {
  advanceStatus,
  nextAction,
  GHOSTED_AFTER_DAYS,
  STATUSES,
  type AdvanceTarget,
  type Status,
} from "../src/model/status.js";

/**
 * The rule these tests defend: a command that prepares a pack or fills a form
 * may nudge a job forward, and may never move one backwards or resurrect one a
 * human parked. Getting this wrong does not throw - it quietly writes a number
 * into the funnel that the funnel then reasons from.
 */
describe("advanceStatus", () => {
  const APPLY_OK: Status[] = ["NEW", "REVIEWED", "SAVED"];
  const APPLIED_OK: Status[] = ["NEW", "REVIEWED", "SAVED", "APPLY"];

  it("advances the statuses `apply` is allowed to advance", () => {
    for (const s of APPLY_OK) expect(advanceStatus(s, "APPLY")).toBe("APPLY");
  });

  it("advances the statuses `autofill` is allowed to advance", () => {
    for (const s of APPLIED_OK) expect(advanceStatus(s, "APPLIED")).toBe("APPLIED");
  });

  // Table-driven over the whole vocabulary, so adding a status to STATUSES
  // without deciding what it means here shows up as a failure rather than as an
  // accidental permission.
  it("refuses every status outside the allowlist, for both targets", () => {
    const allowed: Record<AdvanceTarget, Status[]> = { APPLY: APPLY_OK, APPLIED: APPLIED_OK };
    for (const target of ["APPLY", "APPLIED"] as AdvanceTarget[]) {
      for (const s of STATUSES) {
        if (allowed[target].includes(s)) continue;
        expect(advanceStatus(s, target), `${s} -> ${target}`).toBeNull();
      }
    }
  });

  it("never drags a job that is further along back down the funnel", () => {
    for (const s of ["APPLIED", "CONTACTED", "SCREEN", "INTERVIEW", "FINAL", "OFFER"] as Status[]) {
      expect(advanceStatus(s, "APPLY")).toBeNull();
    }
    for (const s of ["CONTACTED", "SCREEN", "INTERVIEW", "FINAL", "OFFER"] as Status[]) {
      expect(advanceStatus(s, "APPLIED")).toBeNull();
    }
  });

  it("leaves deliberately parked jobs alone", () => {
    for (const s of ["SKIPPED", "REJECTED", "WITHDRAWN", "GHOSTED"] as Status[]) {
      expect(advanceStatus(s, "APPLY")).toBeNull();
      expect(advanceStatus(s, "APPLIED")).toBeNull();
    }
  });

  it("is idempotent - re-running apply on an APPLY job changes nothing", () => {
    expect(advanceStatus("APPLY", "APPLY")).toBeNull();
    expect(advanceStatus("APPLIED", "APPLIED")).toBeNull();
  });
});

describe("nextAction for APPLY", () => {
  // `apply` writes APPLY and leaves a generated pack on disk. Saying only
  // "marked to apply" would hide that the work is already done.
  it("says a pack exists, both fresh and stale", () => {
    expect(nextAction("APPLY", 0)).toContain("pack prepared");
    expect(nextAction("APPLY", 30)).toContain("pack prepared");
  });
});

describe("GHOSTED_AFTER_DAYS", () => {
  it("is a threshold for asking, and no transition can reach a terminal outcome", () => {
    expect(GHOSTED_AFTER_DAYS).toBeGreaterThan(0);
    // A clock may prompt. It may not conclude. Whatever advanceStatus is given,
    // it can never produce an outcome that describes what an employer did.
    const terminal = ["GHOSTED", "REJECTED", "WITHDRAWN", "SCREEN", "INTERVIEW", "FINAL", "OFFER"];
    for (const s of STATUSES) {
      for (const target of ["APPLY", "APPLIED"] as AdvanceTarget[]) {
        const result = advanceStatus(s, target);
        if (result !== null) expect(terminal).not.toContain(result);
      }
    }
  });
});
