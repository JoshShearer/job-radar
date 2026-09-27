import { describe, it, expect } from "vitest";
import { isStale, newestByBoard, closedPostingMarker } from "../src/model/freshness.js";

/**
 * JOB-17. `resume tailor && apply && autofill` on a closed Algolia posting
 * produced a tailored resume, an application pack, and a browser window on a
 * generic job board. Two model calls paid for before anything checked whether
 * the job still existed.
 *
 * The signal was already on every row - `last_seen`, written on every sweep -
 * and nothing read it.
 *
 * JOB-50 rescoped this from provider (`greenhouse`) to employer-board
 * (`greenhouse:acme`) identity: two employer boards on the same ATS provider
 * are independent, and grouping by provider let a healthy board mask a dead
 * sibling board's own staleness.
 */

const job = (id: string, board: string, lastSeen: string) => ({ id, board, lastSeen });

describe("newestByBoard", () => {
  it("takes the newest sighting per board, not across the index", () => {
    const m = newestByBoard([
      job("a", "greenhouse:acme", "2026-08-14T10:00:00Z"),
      job("b", "greenhouse:acme", "2026-08-12T10:00:00Z"),
      job("c", "lever:ro", "2026-08-11T10:00:00Z"),
    ]);
    expect(m.get("greenhouse:acme")).toBe("2026-08-14T10:00:00Z");
    expect(m.get("lever:ro")).toBe("2026-08-11T10:00:00Z");
  });

  it("does not let one board's fresh sweep advance a different board's high-water mark", () => {
    // The JOB-50 bug, at the level of the map itself: two boards on the same
    // ATS provider must never share an entry just because they share a
    // provider name.
    const m = newestByBoard([
      job("healthy", "greenhouse:acme", "2026-08-14T22:00:00Z"),
      job("dead", "greenhouse:widgetco", "2026-08-01T00:00:00Z"),
    ]);
    expect(m.get("greenhouse:acme")).toBe("2026-08-14T22:00:00Z");
    expect(m.get("greenhouse:widgetco")).toBe("2026-08-01T00:00:00Z");
  });

  it("treats an empty board as unknown provenance: it contributes nothing", () => {
    const m = newestByBoard([job("x", "", "2026-08-14T22:00:00Z")]);
    expect(m.size).toBe(0);
  });
});

describe("isStale", () => {
  const index = [
    job("live", "greenhouse:acme", "2026-08-14T22:00:00Z"),
    job("gone", "greenhouse:acme", "2026-08-12T00:50:00Z"),
    job("lever-1", "lever:ro", "2026-08-12T00:50:00Z"),
    job("lever-2", "lever:ro", "2026-08-12T00:50:00Z"),
  ];
  const newest = newestByBoard(index);

  it("marks a posting that its own board stopped listing", () => {
    expect(isStale(job("gone", "greenhouse:acme", "2026-08-12T00:50:00Z"), newest)).toBe(true);
  });

  it("leaves a posting still on the board alone", () => {
    expect(isStale(job("live", "greenhouse:acme", "2026-08-14T22:00:00Z"), newest)).toBe(false);
  });

  /**
   * The invariant that matters. One failing board must never mark its whole
   * catalogue closed - the same rule the ingest path already holds, now
   * scoped to the board rather than diluted across its whole provider.
   */
  it("marks nothing stale when a whole board failed to refresh", () => {
    // lever:ro's newest sighting is old because the board failed, not because
    // the jobs went away. Nothing from it is behind its own high-water mark.
    expect(isStale(job("lever-1", "lever:ro", "2026-08-12T00:50:00Z"), newest)).toBe(false);
    expect(isStale(job("lever-2", "lever:ro", "2026-08-12T00:50:00Z"), newest)).toBe(false);
  });

  it("is not fooled by another board being fresher", () => {
    // greenhouse:acme ran today; lever:ro did not. lever:ro's jobs are not closed.
    expect(newest.get("greenhouse:acme")).not.toBe(newest.get("lever:ro"));
    expect(isStale(job("lever-1", "lever:ro", "2026-08-12T00:50:00Z"), newest)).toBe(false);
  });

  /**
   * The JOB-50 regression itself: two boards sharing a provider must not
   * share a high-water mark. A healthy sibling board on the same ATS must
   * never make a dead board's stale jobs look freshly closed.
   */
  it("does not let a healthy board on the same provider close a dead sibling board's jobs", () => {
    const twoBoardsSameProvider = newestByBoard([
      job("healthy-job", "greenhouse:healthyco", "2026-08-14T22:00:00Z"),
      job("dead-job", "greenhouse:deadco", "2026-08-01T00:00:00Z"),
    ]);
    // The dead board's own posting, last seen the same moment its board's own
    // high-water mark reads - not stale, even though a same-provider sibling
    // swept fresh just now.
    expect(
      isStale(job("dead-job", "greenhouse:deadco", "2026-08-01T00:00:00Z"), twoBoardsSameProvider),
    ).toBe(false);
  });

  it("treats a board it has never seen as not stale", () => {
    expect(isStale(job("x", "brand-new-board", "2026-01-01T00:00:00Z"), newest)).toBe(false);
  });

  it("treats a missing timestamp as not stale rather than guessing", () => {
    expect(isStale({ id: "x", board: "greenhouse:acme", lastSeen: "" }, newest)).toBe(false);
    expect(isStale({ id: "x", board: "greenhouse:acme", lastSeen: null }, newest)).toBe(false);
  });

  it("treats an empty/falsy board as unknown provenance: never stale regardless of the map", () => {
    expect(isStale({ id: "x", board: "", lastSeen: "2020-01-01T00:00:00Z" }, newest)).toBe(false);
  });

  /**
   * The bug that only showed up against the real index. A sweep stamps each job
   * as it walks the boards, so one run spreads its own jobs across minutes of
   * timestamps. Comparing against the exact maximum marked every one of the top
   * eight closed, including postings confirmed live minutes earlier.
   */
  it("does not mark a job closed for being stamped earlier in the same sweep", () => {
    const oneSweep = newestByBoard([
      job("early", "greenhouse:acme", "2026-08-14T22:02:43Z"),
      job("late", "greenhouse:acme", "2026-08-14T22:02:58Z"),
    ]);
    expect(isStale(job("early", "greenhouse:acme", "2026-08-14T22:02:43Z"), oneSweep)).toBe(false);
  });

  it("still marks a posting missed for days", () => {
    const m = newestByBoard([job("fresh", "greenhouse:acme", "2026-08-14T22:02:58Z")]);
    expect(isStale(job("gone", "greenhouse:acme", "2026-08-12T01:35:00Z"), m)).toBe(true);
  });

  it("tolerates a slow sweep but not a missed day", () => {
    const m = newestByBoard([job("fresh", "greenhouse:acme", "2026-08-14T12:00:00Z")]);
    // Four hours earlier: same sweep, or a slow one. Not closed.
    expect(isStale(job("a", "greenhouse:acme", "2026-08-14T08:00:00Z"), m)).toBe(false);
    // A full day earlier: the board was swept without it.
    expect(isStale(job("b", "greenhouse:acme", "2026-08-13T12:00:00Z"), m)).toBe(true);
  });

  it("does not throw on an unparseable timestamp", () => {
    const m = newestByBoard([job("fresh", "greenhouse:acme", "2026-08-14T12:00:00Z")]);
    expect(isStale({ id: "x", board: "greenhouse:acme", lastSeen: "not-a-date" }, m)).toBe(false);
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
