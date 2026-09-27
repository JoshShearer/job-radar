/**
 * Is this posting still open?
 *
 * A closed posting is expensive in a way nothing else in the pipeline is: it
 * costs two model calls to prepare an application for a job that cannot be
 * applied to, and then hands over a browser window showing a generic job board
 * as though it were a form. That happened on a real Algolia posting - the
 * pipeline had every signal it needed and read none of them.
 *
 * Two mechanisms, deliberately different in kind:
 *
 * - `isStale` is an INFERENCE from `last_seen`, which every sweep already
 *   writes. It costs nothing and covers the whole index, so it can gate the
 *   commands that spend money before they spend it.
 * - `closedPostingMarker` is DIRECT EVIDENCE from the page itself. It is used
 *   where a page is already open, and it does not depend on the inference being
 *   right.
 */

export interface Sighting {
  id: string;
  /** Employer-board identity (`greenhouse:acme`), not provider (`greenhouse`). */
  board: string;
  lastSeen: string | null;
}

/**
 * High-water mark per BOARD - not per provider.
 *
 * Per-board is the whole point, and the granularity matters as much as the
 * per-source idea it replaces. Two employer boards on the same ATS provider
 * (two Greenhouse companies, say) are independent in every way that matters
 * here: one can go dark while the other keeps refreshing normally. Grouping
 * by provider instead of by board let a healthy board's fresh sweep advance
 * the SAME high-water mark a dead sibling board was judged against, so the
 * dead board's stale jobs looked freshly closed purely because something else
 * on the same ATS happened to be healthy that day. That is the JOB-50 bug.
 *
 * A board that failed during a run leaves its own high-water mark old, so
 * nothing from it looks closed - the same failure-isolation guarantee the
 * ingest path already holds to, just scoped correctly now.
 */
export function newestByBoard(jobs: ReadonlyArray<Sighting>): Map<string, string> {
  const newest = new Map<string, string>();
  for (const j of jobs) {
    // Unknown provenance is handled conservatively: an empty/falsy board can
    // never contribute a high-water mark, so it can never make anything else
    // look stale by comparison either.
    if (!j.board) continue;
    if (!j.lastSeen) continue;
    const current = newest.get(j.board);
    if (!current || j.lastSeen > current) newest.set(j.board, j.lastSeen);
  }
  return newest;
}

/**
 * A sweep is not an instant.
 *
 * `last_seen` is stamped per job as the run walks the boards, so a run taking
 * several minutes leaves its own jobs spread across several minutes of
 * timestamps. Comparing against the exact maximum therefore marks almost
 * everything closed - measured on the real index, it flagged every one of the
 * top eight, including postings confirmed live minutes earlier.
 *
 * The window groups a single sweep back together. It is generous on purpose:
 * the cost of being too tight is refusing to prepare a live application, and
 * the cost of being too loose is one wasted browser tab.
 */
export const SWEEP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Presumed closed: this job's board was swept more recently than this job was
 * last seen on it.
 *
 * Presumed, not proven - a provider can paginate oddly or drop a posting for a
 * minute. So this gates spending and colours a listing; it never silently
 * deletes anything, and `--stale-ok` exists for a posting known to be live.
 *
 * Compared with a tolerance, not exactly - see SWEEP_WINDOW_MS.
 */
export function isStale(job: Sighting, newestByBoardMap: ReadonlyMap<string, string>): boolean {
  // Unknown provenance handled conservatively: no board, no inference.
  if (!job.board) return false;
  if (!job.lastSeen) return false;
  const newest = newestByBoardMap.get(job.board);
  if (!newest) return false;

  const seen = Date.parse(job.lastSeen);
  const latest = Date.parse(newest);
  if (Number.isNaN(seen) || Number.isNaN(latest)) return false;

  return latest - seen > SWEEP_WINDOW_MS;
}

/**
 * Wording a board uses when the posting is gone, plus the redirect Greenhouse
 * performs. Returns the marker that matched, for the message, or null.
 *
 * Deliberately narrow. A posting that merely mentions other open roles must not
 * match, or the tool would refuse to fill live forms.
 */
const CLOSED_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bjob you are looking for is no longer open\b/i, "the board says this job is no longer open"],
  [/\bno longer (open|available|accepting applications)\b/i, "the board says this job is no longer open"],
  [/\bthis (job|position|posting|role) (has been|is) (filled|closed)\b/i, "the board says this job is filled or closed"],
  [/\bposition has been filled\b/i, "the board says this position has been filled"],
  [/\bthis posting (has )?(is )?(now )?closed\b/i, "the board says this posting is closed"],
];

export function closedPostingMarker(finalUrl: string, bodyText: string): string | null {
  // Greenhouse sends a dead posting to the board root with an error flag. The
  // page that results is a real listings page, which is exactly why this needs
  // catching: it looks like a working page and enumerates like one.
  if (/[?&]error=true\b/.test(finalUrl)) return "the board redirected to its job list with an error flag";

  for (const [re, why] of CLOSED_PHRASES) {
    if (re.test(bodyText)) return why;
  }
  return null;
}

/**
 * How old is the posting itself, in days? `null` when the board did not say.
 *
 * Distinct from `isStale` above, and the difference matters. `isStale` asks
 * "is this still listed on its board?" from `last_seen`. This asks "how long
 * has this been open?" from `date_posted`. A posting can be freshly swept and
 * a year old, which is the common case for the roles that were being
 * recommended.
 */
export function postingAgeDays(datePosted: string | null, now: number = Date.now()): number | null {
  if (!datePosted) return null;
  const t = Date.parse(datePosted);
  if (Number.isNaN(t)) return null;
  return (now - t) / 86_400_000;
}

/**
 * Has this posting been open so long that it is furniture rather than an
 * opening?
 *
 * The threshold is deliberately far out. Measured on the live index, the
 * apply-recommendation pool is destroyed by a tight cutoff and barely touched
 * by a loose one:
 *
 *     cutoff    apply-recommendations lost (of 8)
 *      30d       4        <- half the pool, including the best fit in the index
 *      90d       2
 *     180d       1        <- Hightouch Deployment Architect, 219 days old
 *
 * So this is not a freshness filter. Ranking already handles freshness within
 * the normal range. This catches only the extreme, where a posting has been up
 * for six months and is almost certainly an always-on requisition.
 *
 * UNKNOWN AGE IS NEVER EVERGREEN. A board that does not publish a date tells
 * us nothing about the posting, and treating missing data as disqualifying
 * data is the same defect as rejecting a location field that only says
 * "Hybrid". Absence of evidence is not evidence.
 */
export function isEvergreen(
  datePosted: string | null,
  evergreenDays: number,
  now: number = Date.now(),
): boolean {
  const age = postingAgeDays(datePosted, now);
  if (age === null) return false;
  return age > evergreenDays;
}

/**
 * Compact age for a listing column: `3d`, `77d`, `1y+`.
 *
 * `?` for unknown, so a reader can tell "the board did not say" from "posted
 * today" - which a bare `0d` would hide.
 */
export function formatAge(days: number | null): string {
  if (days === null) return "?";
  const d = Math.round(days);
  if (d >= 365) return "1y+";
  return `${d}d`;
}

/* -------------------------------------------------------------------------
 * Auto-parking
 * ---------------------------------------------------------------------- */

export interface ParkCandidate {
  id: string;
  /** Employer-board identity (`greenhouse:acme`), not provider (`greenhouse`). */
  board: string;
  lastSeen: string | null;
  status: string;
}

export interface ParkPlan {
  /** Job ids to move to CLOSED. */
  park: string[];
  /**
   * Boards where parking was refused because too much of the catalogue would
   * have gone at once. Reported, never silently dropped.
   */
  refusedSources: Array<{ board: string; wouldPark: number; total: number }>;
}

/**
 * Which postings should be parked after a sweep?
 *
 * `isStale` above uses a six-hour window, which is right for COLOURING a
 * listing: the cost of being wrong is one misleading tag. This is a STATE
 * CHANGE, so it is deliberately slower and more suspicious than that.
 *
 * Two guards, both aimed at the same failure: a board that returns a truncated
 * list looks exactly like a board where hundreds of jobs closed at once.
 *
 *  1. `afterDays`. A posting must have gone unseen for this long while its own
 *     board kept being swept. At six hours a single bad response parks
 *     everything it omitted; at three days it takes a sustained failure.
 *
 *  2. `maxFractionPerSource`. If more than this share of a BOARD's parkable
 *     jobs would go at once, the board is the problem, not the jobs. Parking
 *     is refused for that board entirely and reported. This is the same
 *     principle the ingest path already holds to - one failing source must
 *     never invalidate a run, scoped down to the board that actually failed
 *     rather than diluted across every board sharing its provider.
 *
 * Comparison is per-board against that board's own high-water mark, so a
 * board that failed completely has no advanced mark and parks nothing - and,
 * unlike the provider-keyed version this replaced, a board's OWN failure can
 * no longer be masked by a healthy sibling board on the same provider.
 *
 * Only `AUTO_PARKABLE_STATUSES` are touched. An inference must not overwrite
 * something a person recorded, and a posting disappearing from a board is
 * often exactly what happens just after you apply to it.
 */
export function planParking(
  jobs: ReadonlyArray<ParkCandidate>,
  newestByBoardMap: ReadonlyMap<string, string>,
  opts: { afterDays: number; maxFractionPerSource: number; isParkable: (status: string) => boolean },
): ParkPlan {
  const thresholdMs = opts.afterDays * 86_400_000;

  const perBoard = new Map<string, { candidates: string[]; total: number }>();
  for (const job of jobs) {
    if (!opts.isParkable(job.status)) continue;
    // Unknown provenance handled conservatively: a job with no recorded board
    // is never a park candidate, regardless of what else is in the map.
    if (!job.board) continue;
    const entry = perBoard.get(job.board) ?? { candidates: [], total: 0 };
    entry.total += 1;

    if (job.lastSeen) {
      const newest = newestByBoardMap.get(job.board);
      const seen = Date.parse(job.lastSeen);
      const latest = newest ? Date.parse(newest) : NaN;
      if (!Number.isNaN(seen) && !Number.isNaN(latest) && latest - seen > thresholdMs) {
        entry.candidates.push(job.id);
      }
    }
    perBoard.set(job.board, entry);
  }

  const park: string[] = [];
  const refusedSources: ParkPlan["refusedSources"] = [];
  for (const [board, { candidates, total }] of perBoard) {
    if (candidates.length === 0) continue;
    if (total > 0 && candidates.length / total > opts.maxFractionPerSource) {
      refusedSources.push({ board, wouldPark: candidates.length, total });
      continue;
    }
    park.push(...candidates);
  }
  return { park, refusedSources };
}
