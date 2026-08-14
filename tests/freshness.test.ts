import { describe, it, expect } from "vitest";
import { isStale, newestBySource, closedPostingMarker } from "../src/model/freshness.js";

/**
 * JOB-17. `resume tailor && apply && autofill` on a closed Algolia posting
 * produced a tailored resume, an application pack, and a browser window on a
 * generic job board. Two model calls paid for before anything checked whether
 * the job still existed.
 *
 * The signal was already on every row - `last_seen`, written on every sweep -
 * and nothing read it.
 */

const job = (id: string, source: string, lastSeen: string) => ({ id, source, lastSeen });

describe("newestBySource", () => {
  it("takes the newest sighting per source, not across the index", () => {
    const m = newestBySource([
      job("a", "greenhouse", "2026-08-14T10:00:00Z"),
      job("b", "greenhouse", "2026-08-12T10:00:00Z"),
      job("c", "lever", "2026-08-11T10:00:00Z"),
    ]);
    expect(m.get("greenhouse")).toBe("2026-08-14T10:00:00Z");
    expect(m.get("lever")).toBe("2026-08-11T10:00:00Z");
  });
});

describe("isStale", () => {
  const index = [
    job("live", "greenhouse", "2026-08-14T22:00:00Z"),
    job("gone", "greenhouse", "2026-08-12T00:50:00Z"),
    job("lever-1", "lever", "2026-08-12T00:50:00Z"),
    job("lever-2", "lever", "2026-08-12T00:50:00Z"),
  ];
  const newest = newestBySource(index);

  it("marks a posting that its own board stopped listing", () => {
    expect(isStale(job("gone", "greenhouse", "2026-08-12T00:50:00Z"), newest)).toBe(true);
  });

  it("leaves a posting still on the board alone", () => {
    expect(isStale(job("live", "greenhouse", "2026-08-14T22:00:00Z"), newest)).toBe(false);
  });

  /**
   * The invariant that matters. One failing source must never mark its whole
   * catalogue closed - the same rule the ingest path already holds.
   */
  it("marks nothing stale when a whole source failed to refresh", () => {
    // Lever's newest sighting is old because the board failed, not because the
    // jobs went away. Nothing from lever is behind lever's own high-water mark.
    expect(isStale(job("lever-1", "lever", "2026-08-12T00:50:00Z"), newest)).toBe(false);
    expect(isStale(job("lever-2", "lever", "2026-08-12T00:50:00Z"), newest)).toBe(false);
  });

  it("is not fooled by another source being fresher", () => {
    // greenhouse ran today; lever did not. Lever's jobs are not closed.
    expect(newest.get("greenhouse")).not.toBe(newest.get("lever"));
    expect(isStale(job("lever-1", "lever", "2026-08-12T00:50:00Z"), newest)).toBe(false);
  });

  it("treats a source it has never seen as not stale", () => {
    expect(isStale(job("x", "brand-new-source", "2026-01-01T00:00:00Z"), newest)).toBe(false);
  });

  it("treats a missing timestamp as not stale rather than guessing", () => {
    expect(isStale({ id: "x", source: "greenhouse", lastSeen: "" }, newest)).toBe(false);
    expect(isStale({ id: "x", source: "greenhouse", lastSeen: null }, newest)).toBe(false);
  });

  /**
   * The bug that only showed up against the real index. A sweep stamps each job
   * as it walks the boards, so one run spreads its own jobs across minutes of
   * timestamps. Comparing against the exact maximum marked every one of the top
   * eight closed, including postings confirmed live minutes earlier.
   */
  it("does not mark a job closed for being stamped earlier in the same sweep", () => {
    const oneSweep = newestBySource([
      job("early", "greenhouse", "2026-08-14T22:02:43Z"),
      job("late", "greenhouse", "2026-08-14T22:02:58Z"),
    ]);
    expect(isStale(job("early", "greenhouse", "2026-08-14T22:02:43Z"), oneSweep)).toBe(false);
  });

  it("still marks a posting missed for days", () => {
    const m = newestBySource([job("fresh", "greenhouse", "2026-08-14T22:02:58Z")]);
    expect(isStale(job("gone", "greenhouse", "2026-08-12T01:35:00Z"), m)).toBe(true);
  });

  it("tolerates a slow sweep but not a missed day", () => {
    const m = newestBySource([job("fresh", "greenhouse", "2026-08-14T12:00:00Z")]);
    // Four hours earlier: same sweep, or a slow one. Not closed.
    expect(isStale(job("a", "greenhouse", "2026-08-14T08:00:00Z"), m)).toBe(false);
    // A full day earlier: the board was swept without it.
    expect(isStale(job("b", "greenhouse", "2026-08-13T12:00:00Z"), m)).toBe(true);
  });

  it("does not throw on an unparseable timestamp", () => {
    const m = newestBySource([job("fresh", "greenhouse", "2026-08-14T12:00:00Z")]);
    expect(isStale({ id: "x", source: "greenhouse", lastSeen: "not-a-date" }, m)).toBe(false);
  });
});

/**
 * Direct evidence, for the command that costs nothing and puts a human in
 * front of the page. Greenhouse redirects a closed posting to the board root
 * and says so in the body.
 */
describe("closedPostingMarker", () => {
  it("recognises the Greenhouse closed-posting redirect", () => {
    expect(
      closedPostingMarker(
        "https://job-boards.greenhouse.io/algolia?error=true",
        "The job you are looking for is no longer open. Current openings at Algolia",
      ),
    ).toBeTruthy();
  });

  it("recognises the wording without the redirect", () => {
    expect(closedPostingMarker("https://example.com/jobs/1", "This position has been filled")).toBeTruthy();
    expect(closedPostingMarker("https://example.com/jobs/1", "This job is no longer accepting applications")).toBeTruthy();
  });

  it("leaves a real application form alone", () => {
    expect(
      closedPostingMarker(
        "https://job-boards.greenhouse.io/vercel/jobs/5732855004",
        "Apply for this job First Name Last Name Email Resume/CV",
      ),
    ).toBeNull();
  });

  it("does not fire on a posting that merely mentions open roles", () => {
    expect(
      closedPostingMarker(
        "https://jobs.lever.co/brilliant/abc/apply",
        "We have several open positions. Apply below. First Name",
      ),
    ).toBeNull();
  });
});
