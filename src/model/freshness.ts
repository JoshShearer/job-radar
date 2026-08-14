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
  source: string;
  lastSeen: string | null;
}

/**
 * High-water mark per source.
 *
 * Per-source is the whole point. A board that failed during a run leaves every
 * one of its jobs on an older timestamp, so its own high-water mark is old too
 * and nothing from it looks closed. Comparing against a global maximum instead
 * would mark an entire catalogue closed the first time one provider had a bad
 * night - the same failure the ingest path already refuses to allow, where one
 * failing source must never abort or invalidate a run.
 */
export function newestBySource(jobs: ReadonlyArray<Sighting>): Map<string, string> {
  const newest = new Map<string, string>();
  for (const j of jobs) {
    if (!j.lastSeen) continue;
    const current = newest.get(j.source);
    if (!current || j.lastSeen > current) newest.set(j.source, j.lastSeen);
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
export function isStale(job: Sighting, newestBySourceMap: ReadonlyMap<string, string>): boolean {
  if (!job.lastSeen) return false;
  const newest = newestBySourceMap.get(job.source);
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
