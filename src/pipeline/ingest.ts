import type { CareerProfile, SourcesConfig } from "../config/schema.js";
import type { NormalizedJob } from "../model/job.js";
import { buildSources } from "../sources/registry.js";
import { PoliteFetcher } from "../lib/http.js";
import { RunStats, log } from "../lib/log.js";
import { normalizeJob } from "./normalize.js";
import { dedupeBatch } from "./dedupe.js";
import { JobRepo } from "../db/repo.js";

export interface IngestSummary {
  fetched: number;
  normalized: number;
  uniqueInBatch: number;
  duplicatesInBatch: number;
  inserted: number;
  updated: number;
  crossSourceDuplicates: number;
  descriptionChanges: number;
  salaryChanges: number;
  sourceFailures: number;
  stats: RunStats;
}

/**
 * DISCOVER -> NORMALIZE -> DEDUPE -> persist.
 *
 * Failure isolation is a hard requirement here: one source returning garbage,
 * timing out, or being taken offline must never abort the run. Each adapter
 * catches its own errors and records them on RunStats; this orchestrator only
 * fails if literally everything failed.
 */
export async function runIngest(
  repo: JobRepo,
  profile: CareerProfile,
  sourcesConfig: SourcesConfig,
  opts: { onlySources?: string[] } = {},
): Promise<IngestSummary> {
  const stats = new RunStats();
  const fetcher = new PoliteFetcher({
    delayMs: sourcesConfig.http.delay_ms,
    timeoutMs: sourcesConfig.http.timeout_ms,
    maxRetries: sourcesConfig.http.max_retries,
    userAgent: buildUserAgent(sourcesConfig.http.user_agent),
  });

  let sources = buildSources(sourcesConfig);
  if (opts.onlySources?.length) {
    const wanted = new Set(opts.onlySources.map((s) => s.toLowerCase()));
    sources = sources.filter((s) => wanted.has(s.name));
    if (sources.length === 0) {
      throw new Error(
        `No sources matched ${opts.onlySources.join(", ")}. Available: greenhouse, lever, ashby, remoteok.`,
      );
    }
  }

  if (sources.length === 0) {
    throw new Error("No sources are enabled. Check config/sources.yaml.");
  }

  log.info(`Ingesting from ${sources.length} source(s): ${sources.map((s) => s.name).join(", ")}`);

  // Sources run concurrently; PoliteFetcher still serializes and rate-limits
  // per host, so this parallelism does not increase load on any one provider.
  const results = await Promise.allSettled(sources.map((s) => s.fetch({ fetcher, stats })));

  const rawJobs = results.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const name = sources[i]?.name ?? "unknown";
    log.error(`source ${name} threw: ${r.reason}`);
    stats.fail(name, String(r.reason));
    return [];
  });

  stats.bump("total.fetched", rawJobs.length);
  log.info(`Fetched ${rawJobs.length} raw postings`);

  // NORMALIZE
  const normalized: NormalizedJob[] = [];
  for (const raw of rawJobs) {
    try {
      normalized.push(normalizeJob(raw, profile));
    } catch (err) {
      log.warn(`normalize failed for ${raw.source}:${raw.externalId}: ${(err as Error).message}`);
      stats.bump("normalize.failed");
    }
  }
  stats.bump("total.normalized", normalized.length);

  // DEDUPE (within this batch)
  const { unique, duplicates } = dedupeBatch(normalized);
  stats.bump("dedupe.unique", unique.length);
  stats.bump("dedupe.duplicates", duplicates.length);
  for (const d of duplicates) stats.bump(`dedupe.by_${d.how}`);
  log.info(`Deduped: ${unique.length} unique, ${duplicates.length} collapsed`);

  // PERSIST (dedupe continues across runs via dedupe_key in the repo)
  let inserted = 0;
  let updated = 0;
  let crossSourceDuplicates = 0;
  let descriptionChanges = 0;
  let salaryChanges = 0;

  for (const { job, key } of unique) {
    try {
      const outcome = repo.upsert(job, key);
      if (outcome.isNew) inserted++;
      else updated++;
      if (outcome.isDuplicate) crossSourceDuplicates++;
      if (outcome.descriptionChanged) descriptionChanges++;
      if (outcome.salaryChanged) salaryChanges++;
    } catch (err) {
      log.warn(`upsert failed for ${job.source}:${job.externalId}: ${(err as Error).message}`);
      stats.bump("persist.failed");
    }
  }

  stats.bump("persist.inserted", inserted);
  stats.bump("persist.updated", updated);
  stats.bump("persist.cross_source_dupes", crossSourceDuplicates);
  stats.bump("persist.description_changed", descriptionChanges);
  stats.bump("persist.salary_changed", salaryChanges);

  return {
    fetched: rawJobs.length,
    normalized: normalized.length,
    uniqueInBatch: unique.length,
    duplicatesInBatch: duplicates.length,
    inserted,
    updated,
    crossSourceDuplicates,
    descriptionChanges,
    salaryChanges,
    sourceFailures: stats.failureCount,
    stats,
  };
}

/**
 * Append a contact address to the User-Agent when one is configured, so a
 * source operator who sees our traffic has a way to reach us.
 */
function buildUserAgent(base: string): string {
  const contact = process.env.JOB_RADAR_CONTACT?.trim();
  return contact ? `${base} contact:${contact}` : base;
}
