import { normalizeForIdentity } from "../text/identity.js";
import { shortId } from "../../kernel/hash.js";
import type { PostingSnapshot } from "./posting.js";

/**
 * Opportunity resolution: which canonical opportunity is this posting?
 *
 * Deterministic and cheapest-first, as before: exact alias, exact dedupe key,
 * identical description at the same company, then a bounded fuzzy title match
 * within the same company and location bucket. What changed is that every
 * alias is kept - a syndicated duplicate adds an alias, it is never dropped.
 */

export const RESOLVE_VERSION = "resolve@1";

const TITLE_NOISE = [
  /\((remote|hybrid|onsite|on-site|contract|full[- ]time|part[- ]time|us|usa|u\.s\.|emea|apac)[^)]*\)/gi,
  /\[(remote|hybrid|onsite|us|usa)[^\]]*\]/gi,
  /\b(remote|hybrid|onsite|on-site)\b/gi,
  /\b(m\/f\/d|m\/w\/d|f\/m\/x|d\/f\/m)\b/gi,
  /\breq(uisition)?\.?\s*#?\s*\d+\b/gi,
  /#\d{3,}/g,
  /\s[-–|,]\s*(new york|san francisco|austin|seattle|boston|chicago|denver|los angeles|atlanta|toronto|london|berlin|dublin|amsterdam|paris|singapore|sydney|bangalore|us|usa|united states)[a-z, .]*$/gi,
];

/** Level markers ("II", "Staff") are preserved: they are different roles. */
export function normalizeTitleForDedupe(title: string): string {
  let t = ` ${title} `;
  for (const re of TITLE_NOISE) t = t.replace(re, " ");
  return normalizeForIdentity(t);
}

export function locationBucket(s: Pick<PostingSnapshot, "remoteStatus" | "location">): string {
  if (s.remoteStatus === "remote") return "remote";
  const first = s.location.split(/[|,]/)[0] ?? "";
  return normalizeForIdentity(first) || "unspecified";
}

export function dedupeKey(s: PostingSnapshot): string {
  return [normalizeForIdentity(s.company), normalizeTitleForDedupe(s.title), locationBucket(s)].join("::");
}

export function contentKey(s: PostingSnapshot): string | null {
  // Short descriptions are too generic to identify a posting by content.
  return s.description.length > 200 ? `${normalizeForIdentity(s.company)}::${s.descriptionHash}` : null;
}

export function groupKey(s: PostingSnapshot): string {
  return `${normalizeForIdentity(s.company)}::${locationBucket(s)}`;
}

export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeForIdentity(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForIdentity(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const FUZZY_TITLE_THRESHOLD = 0.85;

/**
 * Identical text at the same company is a repost only when the titles are
 * also alike. Boards reuse one template description across unrelated roles,
 * and merging a "Junior Designer" into a "Senior Engineer" because their
 * boilerplate matched would hide a posting.
 */
export const CONTENT_TITLE_THRESHOLD = 0.7;

export function opportunityIdFor(boardId: string, externalId: string): string {
  return shortId(`${boardId}|${externalId}`);
}

/** Read-only lookups over opportunities already known. */
export interface ResolutionIndex {
  byAlias(boardId: string, externalId: string): string | null;
  byDedupeKey(key: string): string | null;
  byContentKey(key: string): { id: string; title: string } | null;
  /** Opportunities in a company+location group, with their current titles. */
  inGroup(key: string): Array<{ id: string; title: string }>;
}

export type ResolvedHow = "alias" | "exact" | "content" | "fuzzy" | "new";

export interface Resolution {
  snapshot: PostingSnapshot;
  opportunityId: string;
  how: ResolvedHow;
}

/**
 * Resolve a batch against what is already known AND against itself, so two
 * syndications arriving in the same sweep collapse exactly as they would
 * across sweeps.
 */
export function resolveBatch(batch: readonly PostingSnapshot[], index: ResolutionIndex): Resolution[] {
  const localKey = new Map<string, string>();
  const localContent = new Map<string, { id: string; title: string }>();
  const localGroup = new Map<string, Array<{ id: string; title: string }>>();
  const out: Resolution[] = [];

  for (const s of batch) {
    const key = dedupeKey(s);
    const ck = contentKey(s);
    const gk = groupKey(s);

    let id: string | null = index.byAlias(s.boardId, s.externalId);
    let how: ResolvedHow = "alias";
    if (!id) {
      id = localKey.get(key) ?? index.byDedupeKey(key);
      how = "exact";
    }
    if (!id && ck) {
      const hit = localContent.get(ck) ?? index.byContentKey(ck);
      if (hit && tokenSetSimilarity(normalizeTitleForDedupe(hit.title), normalizeTitleForDedupe(s.title)) >= CONTENT_TITLE_THRESHOLD) {
        id = hit.id;
        how = "content";
      }
    }
    if (!id) {
      const group = [...(localGroup.get(gk) ?? []), ...index.inGroup(gk)];
      const hit = group.find((g) => tokenSetSimilarity(g.title, s.title) >= FUZZY_TITLE_THRESHOLD);
      if (hit) {
        id = hit.id;
        how = "fuzzy";
      }
    }
    if (!id) {
      id = opportunityIdFor(s.boardId, s.externalId);
      how = "new";
    }

    localKey.set(key, id);
    if (ck && !localContent.has(ck)) localContent.set(ck, { id, title: s.title });
    const g = localGroup.get(gk) ?? [];
    if (!g.some((x) => x.id === id)) g.push({ id, title: s.title });
    localGroup.set(gk, g);
    out.push({ snapshot: s, opportunityId: id, how });
  }
  return out;
}
