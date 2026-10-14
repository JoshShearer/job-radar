import type { Preferences } from "../config/schema.js";
import { htmlToText } from "../text/html.js";
import { materialHash, sha256 } from "../text/identity.js";
import { assessLocation, type LocationPrefs } from "../text/location.js";
import { classifyEmployment, classifySeniority } from "../text/seniority.js";
import { mergeSalary, parseSalary } from "../text/salary.js";
import type { PostingSnapshot, RawPosting } from "./posting.js";

/** Bumped whenever normalization output can change for the same input. */
export const NORMALIZE_VERSION = "normalize@2"; // 2: board URLs kept only when http(s)

export function locationPrefs(p: Preferences): LocationPrefs {
  return {
    homeMetro: p.location.home_metro,
    remoteOk: p.location.remote_ok,
    hybridMetros: p.location.hybrid_metros,
    onsiteOkMetros: p.location.onsite_ok_metros,
    relocationOk: p.location.relocation_ok,
  };
}

/** The single place classification happens. Pure. */
export function normalizePosting(raw: RawPosting, prefs: Preferences): PostingSnapshot {
  const description = raw.descriptionPlain?.trim() ? raw.descriptionPlain.trim() : htmlToText(raw.descriptionHtml);
  const loc = assessLocation(raw.locationRaw, locationPrefs(prefs), {
    workplaceType: raw.workplaceType ?? null,
    isRemote: raw.isRemote ?? null,
    description,
  });
  const salary = mergeSalary(
    {
      min: raw.salary?.min ?? null,
      max: raw.salary?.max ?? null,
      currency: raw.salary?.currency ?? "USD",
      period: raw.salary?.period ?? null,
      raw: raw.salary ? "structured field from source" : null,
    },
    parseSalary(description),
  );
  return {
    boardId: raw.boardId,
    provider: raw.provider,
    externalId: raw.externalId,
    sourceUrl: httpUrl(raw.sourceUrl) ?? "",
    applicationUrl: httpUrl(raw.applicationUrl),
    company: raw.company.trim(),
    title: raw.title.trim(),
    location: loc.location,
    remoteStatus: loc.remoteStatus,
    employmentType: classifyEmployment(raw.title, raw.employmentTypeRaw, description),
    seniority: classifySeniority(raw.title).level,
    datePosted: raw.datePosted,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    description,
    descriptionHash: sha256(description),
    materialHash: materialHash(description),
    department: raw.department ?? null,
    team: raw.team ?? null,
  };
}

/**
 * The fields of a posting that, if they change, mean any judgement formed
 * against it is about a different posting. ONE definition, used by every
 * derivation that depends on the posting.
 */
export function materialPosting(s: PostingSnapshot) {
  return {
    company: s.company,
    title: s.title,
    location: s.location,
    remoteStatus: s.remoteStatus,
    employmentType: s.employmentType,
    salary: [s.salaryMin, s.salaryMax, s.salaryCurrency, s.salaryPeriod],
    department: s.department,
    datePosted: s.datePosted,
    material: s.materialHash,
  };
}

/**
 * A board's URL is untrusted input: it becomes a link in the briefing and the
 * page `jr fill` opens. Only absolute http(s) URLs survive; `javascript:`,
 * `data:` and anything unparseable become null.
 */
export function httpUrl(u: string | null | undefined): string | null {
  const t = (u ?? "").trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const parsed = new URL(t);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}
