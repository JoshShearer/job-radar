import type { SourceJob } from "../sources/types.js";
import type { NormalizedJob } from "../model/job.js";
import type { CareerProfile } from "../config/schema.js";
import { htmlToText } from "../lib/html.js";
import { sha256, shortHash, normalizeForIdentity, materialHash as computeMaterialHash } from "../lib/hash.js";
import { assessLocation } from "../lib/location.js";
import { classifyEmployment, classifySeniority } from "../lib/seniority.js";
import { mergeSalary, parseSalary, type ParsedSalary } from "../lib/salary.js";

/**
 * Turn a raw SourceJob into the canonical NormalizedJob.
 *
 * This is the single place classification happens, so a Greenhouse job and a
 * Remote OK job that describe the same role get identical treatment.
 */
export function normalizeJob(raw: SourceJob, profile: CareerProfile): NormalizedJob {
  const descriptionClean = raw.descriptionPlain?.trim()
    ? raw.descriptionPlain.trim()
    : htmlToText(raw.descriptionHtml);

  const locationVerdict = assessLocation(
    raw.locationRaw,
    {
      homeMetro: profile.location.home_metro,
      remoteOk: profile.location.remote_ok,
      hybridMetros: profile.location.hybrid_metros,
      onsiteOkMetros: profile.location.onsite_ok_metros,
      relocationOk: profile.location.relocation_ok,
    },
    {
      workplaceType: raw.workplaceType ?? null,
      isRemote: raw.isRemote ?? null,
      description: descriptionClean,
    },
  );

  const parsed: ParsedSalary = parseSalary(descriptionClean);
  const salary = mergeSalary(
    {
      min: raw.salary?.min ?? null,
      max: raw.salary?.max ?? null,
      currency: raw.salary?.currency ?? "USD",
      period: raw.salary?.period ?? null,
      raw: raw.salary ? "structured field from source" : null,
    },
    parsed,
  );

  const seniority = classifySeniority(raw.title);
  const employmentType = classifyEmployment(raw.title, raw.employmentTypeRaw, descriptionClean);
  const descriptionHash = sha256(descriptionClean);
  const materialHash = computeMaterialHash(descriptionClean);
  const id = shortHash(`${raw.source}|${raw.externalId}`, 12);

  return {
    id,
    externalId: raw.externalId,
    source: raw.source,
    board: raw.board,
    ats: raw.ats,
    sourceUrl: raw.sourceUrl,
    applicationUrl: raw.applicationUrl,
    company: raw.company.trim(),
    title: raw.title.trim(),
    location: locationVerdict.location,
    remoteStatus: locationVerdict.remoteStatus,
    employmentType,
    seniority: seniority.level,
    datePosted: raw.datePosted,
    dateDiscovered: new Date().toISOString(),
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    descriptionClean,
    descriptionHash,
    materialHash,
    department: raw.department ?? null,
    team: raw.team ?? null,
    companySizeEstimate: null,
    companyStage: null,
    industry: null,
  };
}

/** Re-run the location verdict for a normalized job (filters need the reason). */
export function locationVerdictFor(job: NormalizedJob, profile: CareerProfile) {
  return assessLocation(
    job.location,
    {
      homeMetro: profile.location.home_metro,
      remoteOk: profile.location.remote_ok,
      hybridMetros: profile.location.hybrid_metros,
      onsiteOkMetros: profile.location.onsite_ok_metros,
      relocationOk: profile.location.relocation_ok,
    },
    { description: job.descriptionClean },
  );
}

/** Stable identity for a job across sources. See dedupe.ts for the rationale. */
export function companyKey(company: string): string {
  return normalizeForIdentity(company);
}
