import { describe, it, expect } from "vitest";
import { statusAfterAutofill } from "../src/apply/record.js";
import { STATUSES } from "../src/model/status.js";

/**
 * `autofill` fills a form and stops. The one thing it may record afterwards is
 * an answer a human gave out loud, and this is where that is decided.
 *
 * The No branch is tested across the entire status vocabulary rather than on a
 * representative case, because the failure mode is not a crash: an inverted
 * condition here writes APPLIED for every job that was reviewed and not
 * submitted, and the funnel then reports applications that never happened.
 */
describe("statusAfterAutofill", () => {
  it("records nothing on a No, from every status there is", () => {
    for (const s of STATUSES) {
      expect(statusAfterAutofill(s, false), `${s} + No`).toBeNull();
    }
  });

  it("records APPLIED on a Yes, only from the statuses that precede it", () => {
    for (const s of ["NEW", "REVIEWED", "SAVED", "APPLY"] as const) {
      expect(statusAfterAutofill(s, true)).toBe("APPLIED");
    }
  });

  it("leaves a job that is already further along where it is, even on a Yes", () => {
    for (const s of ["APPLIED", "CONTACTED", "SCREEN", "INTERVIEW", "FINAL", "OFFER"] as const) {
      expect(statusAfterAutofill(s, true)).toBeNull();
    }
  });

  it("does not resurrect a job the human parked, even on a Yes", () => {
    for (const s of ["SKIPPED", "REJECTED", "WITHDRAWN", "GHOSTED"] as const) {
      expect(statusAfterAutofill(s, true)).toBeNull();
    }
  });
});
