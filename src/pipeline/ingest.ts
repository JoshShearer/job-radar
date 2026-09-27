import type { CareerProfile, SourcesConfig } from "../config/schema.js";
import type { NormalizedJob } from "../model/job.js";
import { buildSources } from "../sources/registry.js";
import { PoliteFetcher } from "../lib/http.js";
import { RunStats, log } from "../lib/log.js";
import { normalizeJob } from "./normalize.js";
import { dedupeBatch } from "./dedupe.js";
import { JobRepo } from "../db/repo.js";
import { planParking, newestByBoard } from "../model/freshness.js";
import { isAutoParkable } from "../model/status.js";

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
  /** Postings moved to CLOSED because their board stopped listing them. */
  parked: number;
  /** Boards where parking was refused as implausible. Never silent. */
  parkRefusals: Array<{ board: string; wouldPark: number; total: number }>;
  sourceFailures: number;
  stats: RunStats;
  /**
   * Run-level verdict computed from `stats.sweeps`:
   *  - "ok"       every attempted board succeeded
   *  - "degraded" some boards failed, some succeeded
   *  - "failed"   no board succeeded (including "nothing was attempted")
   *
   * `runIngest` never throws for this - it always returns normally, per the
   * failure-isolation invariant above. Callers (the `ingest` and `daily` CLI
   * actions) decide whether "failed" should fail the command.
   */
  outcome: "ok" | "degraded" | "failed";
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

  // RECORD BOARD SWEEPS: one row per board this run attempted, before parking
  // reads them. Housekeeping, so a failure here must not fail the run.
  for (const s of stats.sweeps) {
    try {
      repo.recordBoardSweep(s.boardId, s.provider, s.ok, s.jobCount);
    } catch (err) {
      log.warn(`recording sweep for ${s.boardId} failed: ${(err as Error).message}`);
    }
  }

  // PARK: postings the boards have stopped listing.
  //
  // After persist and after recordBoardSweep, so this run's own sightings and
  // its own board outcomes are already recorded and a posting seen moments
  // ago cannot look absent. Failures here must not fail the run - parking is
  // housekeeping, and the jobs it would have moved are still correct, just
  // noisier.
  let parked = 0;
  const parkRefusals: Array<{ board: string; wouldPark: number; total: number }> = [];
  try {
    const plan = planParking(repo.parkCandidates(), newestByBoard(repo.boardSweepSightings()), {
      afterDays: profile.parking.after_days,
      maxFractionPerSource: profile.parking.max_fraction_per_source,
      isParkable: isAutoParkable,
    });
    parked = repo.parkJobs(plan.park);
    parkRefusals.push(...plan.refusedSources);
    if (parked) log.info(`Parked ${parked} posting(s) their board no longer lists (status CLOSED).`);
    for (const r of parkRefusals) {
      log.warn(
        `Refused to park ${r.board}: ${r.wouldPark} of ${r.total} of its jobs would have gone at once. ` +
          `That reads as a truncated response from the board rather than a hiring freeze - check the board.`,
      );
    }
  } catch (err) {
    log.warn(`parking pass failed: ${(err as Error).message}`);
    stats.bump("parking.failed");
  }
  stats.bump("parking.parked", parked);

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
    parked,
    parkRefusals,
    sourceFailures: stats.failureCount,
    stats,
    outcome: computeOutcome(stats.sweeps),
  };
}

/**
 * "ok" when every attempted board succeeded, "failed" when none did
 * (including zero boards attempted - nothing was refreshed either way),
 * "degraded" in between. `runIngest` never throws for this; it is on the
 * caller (the `ingest` and `daily` CLI actions) to decide whether "failed"
 * should fail the command.
 */
export function computeOutcome(sweeps: ReadonlyArray<{ ok: boolean }>): "ok" | "degraded" | "failed" {
  if (sweeps.length === 0) return "failed";
  const succeeded = sweeps.filter((s) => s.ok).length;
  if (succeeded === sweeps.length) return "ok";
  if (succeeded === 0) return "failed";
  return "degraded";
}

/**
 * Append a contact address to the User-Agent when one is configured, so a
 * source operator who sees our traffic has a way to reach us.
 */
function buildUserAgent(base: string): string {
  const contact = process.env.JOB_RADAR_CONTACT?.trim();
  return contact ? `${base} contact:${contact}` : base;
}
