import type { NormalizedJob } from "../model/job.js";
import { normalizeForIdentity } from "../lib/hash.js";

/**
 * Deduplication.
 *
 * Jobs are syndicated aggressively: the same opening shows up on the company's
 * Greenhouse board, on Remote OK, and on two aggregators, each with a different
 * id and a slightly different title. We keep one canonical record and every
 * source URL that pointed at it.
 *
 * This is deliberately deterministic. An LLM is not involved and must not be:
 * dedupe runs on every job on every ingest, it has to be reproducible, and a
 * hash comparison is both cheaper and more correct than a judgement call.
 * Fuzzy matching is a bounded second pass, not the primary mechanism.
 */

/** Noise that varies between syndications of the same posting. */
const TITLE_NOISE = [
  /\((remote|hybrid|onsite|on-site|contract|full[- ]time|part[- ]time|us|usa|u\.s\.|emea|apac)[^)]*\)/gi,
  /\[(remote|hybrid|onsite|us|usa)[^\]]*\]/gi,
  /\b(remote|hybrid|onsite|on-site)\b/gi,
  /\b(m\/f\/d|m\/w\/d|f\/m\/x|d\/f\/m)\b/gi,
  /\breq(uisition)?\.?\s*#?\s*\d+\b/gi,
  /#\d{3,}/g,
  // Trailing location fragments: "Senior Engineer - New York, NY"
  /\s[-–|,]\s*(new york|san francisco|austin|seattle|boston|chicago|denver|los angeles|atlanta|toronto|london|berlin|dublin|amsterdam|paris|singapore|sydney|bangalore|us|usa|united states)[a-z, .]*$/gi,
];

/**
 * Normalize a title for identity comparison.
 *
 * Level markers ("II", "III", "Staff") are deliberately preserved: "Engineer
 * II" and "Engineer III" are genuinely different roles with different pay, and
 * collapsing them would hide one of them.
 */
export function normalizeTitleForDedupe(title: string): string {
  let t = ` ${title} `;
  for (const re of TITLE_NOISE) t = t.replace(re, " ");
  return normalizeForIdentity(t);
}

/**
 * Coarse location bucket. Remote postings are bucketed together regardless of
 * how each board phrases the region, because "Remote - US", "Remote (USA)" and
 * "Remote" are the same posting when the company and title also match.
 */
export function locationBucket(job: Pick<NormalizedJob, "remoteStatus" | "location">): string {
  if (job.remoteStatus === "remote") return "remote";
  const first = job.location.split(/[|,]/)[0] ?? "";
  const norm = normalizeForIdentity(first);
  return norm || "unspecified";
}

/** The primary dedupe key: company + normalized title + location bucket. */
export function dedupeKey(job: NormalizedJob): string {
  return [normalizeForIdentity(job.company), normalizeTitleForDedupe(job.title), locationBucket(job)].join(
    "::",
  );
}

/** Jaccard similarity over word tokens. 1.0 = identical token sets. */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeForIdentity(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForIdentity(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export interface DedupeResult {
  /** One entry per canonical opportunity, with its assigned key. */
  unique: { job: NormalizedJob; key: string }[];
  /** Jobs collapsed into an earlier entry, with the id they merged into. */
  duplicates: { job: NormalizedJob; mergedIntoId: string; how: "exact" | "fuzzy" | "content" }[];
}

const FUZZY_TITLE_THRESHOLD = 0.85;

/**
 * Collapse duplicates within a single ingest batch.
 *
 * Three passes, cheapest first:
 *   1. exact dedupe key
 *   2. identical description hash at the same company (a re-post under a
 *      slightly different title is still one opportunity)
 *   3. fuzzy title match within the same company + location bucket
 */
export function dedupeBatch(jobs: NormalizedJob[]): DedupeResult {
  const unique: { job: NormalizedJob; key: string }[] = [];
  const duplicates: DedupeResult["duplicates"] = [];

  const byKey = new Map<string, NormalizedJob>();
  const byContent = new Map<string, NormalizedJob>();
  // company+bucket -> entries, for the bounded fuzzy pass
  const byGroup = new Map<string, { job: NormalizedJob; key: string }[]>();

  for (const job of jobs) {
    const key = dedupeKey(job);

    const exact = byKey.get(key);
    if (exact) {
      duplicates.push({ job, mergedIntoId: exact.id, how: "exact" });
      continue;
    }

    const contentKey = `${normalizeForIdentity(job.company)}::${job.descriptionHash}`;
    const sameContent = job.descriptionClean.length > 200 ? byContent.get(contentKey) : undefined;
    if (sameContent) {
      duplicates.push({ job, mergedIntoId: sameContent.id, how: "content" });
      continue;
    }

    const groupKey = `${normalizeForIdentity(job.company)}::${locationBucket(job)}`;
    const group = byGroup.get(groupKey) ?? [];
    const fuzzy = group.find(
      (g) => tokenSetSimilarity(g.job.title, job.title) >= FUZZY_TITLE_THRESHOLD,
    );
    if (fuzzy) {
      duplicates.push({ job, mergedIntoId: fuzzy.job.id, how: "fuzzy" });
      continue;
    }

    const entry = { job, key };
    unique.push(entry);
    byKey.set(key, job);
    if (job.descriptionClean.length > 200) byContent.set(contentKey, job);
    group.push(entry);
    byGroup.set(groupKey, group);
  }

  return { unique, duplicates };
}
