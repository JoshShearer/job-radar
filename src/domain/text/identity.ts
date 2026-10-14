import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Short stable id for display and CLI addressing. */
export function shortHash(input: string, len = 10): string {
  return sha256(input).slice(0, len);
}

/**
 * Normalize a string for identity comparison: lowercase, strip punctuation and
 * common corporate suffixes, collapse whitespace. Used by dedupe.
 */
export function normalizeForIdentity(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|nv|ag|pbc)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Canonicalize a URL for dedupe: drop tracking params, fragments, trailing
 * slashes, and protocol/host casing.
 */
const TRACKING_PARAMS = /^(utm_|gh_|ref$|source$|src$|fbclid$|gclid$|mc_)/i;

export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.host = u.host.toLowerCase().replace(/^www\./, "");
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort(([a], [b]) => a.localeCompare(b));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim() || null;
  }
}

/**
 * A content address that survives cosmetic edits to a posting.
 *
 * `descriptionHash` is `sha256(descriptionClean)` - byte-level, and that is
 * right for `job_events`, where change history should be exact. It is wrong for
 * the analysis cache: 4,349 `description_changed` events were recorded across
 * 13,674 jobs, one ClickUp posting changed 32 times, and Greenhouse and Ashby
 * both average 0.33 changes per job. Each one threw away an analysis that had
 * been paid for, usually because a board re-rendered the same text.
 *
 * So this reduces a description to a TOKEN MULTISET: lowercased, punctuation
 * folded to spaces, tokens sorted. Sorting is what makes it order-independent -
 * moving the benefits section above the requirements no longer counts as a
 * change - while keeping duplicates means adding or removing real sentences
 * still does.
 *
 * DELIBERATELY CONSERVATIVE. No stopword list, no boilerplate stripping, no
 * stemming, and above all no model call - this is deterministic string work
 * that has to be reproducible over the whole index. The asymmetry decides it:
 * a change wrongly called MATERIAL costs $0.046, and a change wrongly called
 * IMMATERIAL means serving a verdict formed against text that no longer
 * exists. So every ambiguous case is left looking material.
 *
 * `+`, `#` and `.` survive folding so `c++`, `c#` and `node.js` stay distinct
 * from `c` and `node`.
 */
export function materialHash(descriptionClean: string): string {
  const tokens = descriptionClean
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  return sha256(tokens.join(" "));
}
