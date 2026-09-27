import Anthropic from "@anthropic-ai/sdk";
import type { CareerProfile } from "../config/schema.js";
import type { Analysis, AnalysisTier, EnrichedJob } from "../model/job.js";
import { analysisSchemaFor, isTriageOnly, triageSchemaFor, triageOnlyAnalysis, type TriageVerdict } from "../model/job.js";
import type { JobRepo } from "../db/repo.js";
import { buildAnalysisJsonSchema, buildTriageJsonSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { computeAnalysisIdentity, type AnalysisIdentity } from "./identity.js";
import { sha256 } from "../lib/hash.js";
import { log } from "../lib/log.js";

import { addUsage, emptyUsage, estimateCostUsd, PRICING, readUsage, type TokenUsage } from "../lib/cost.js";
import { classifyAnalysisFailure, countsAgainstJob } from "./failures.js";
import { deservesDossier, type DossierPolicy } from "./detail.js";

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * The model that writes the application pack.
 *
 * Cheaper than DEFAULT_MODEL on purpose. The pack is prose - a cover note,
 * drafted form answers, a positioning frame - and prose is where a Sonnet-tier
 * model is closest to an Opus-tier one. It is also the single largest output in
 * the tool (~6,000 tokens per job plus thinking), and output is where the money
 * goes, so this is the one call where the tier actually shows up on a bill.
 *
 * `resume tailor` deliberately stays on DEFAULT_MODEL: it decides which bullets
 * are true of this candidate for this posting, and being wrong there is a
 * correctness problem, not a style one.
 */
export const PACK_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";

export interface AnalyzeOptions {
  limit: number;
  /**
   * Optional absolute floor on the deterministic score.
   *
   * Undefined means no floor, which is the default: selection is by RANK.
   * See `JobRepo.needingAnalysis` for why an absolute gate was the wrong
   * shape. Set only by an explicit `--min-fit` on one pass.
   */
  minFit?: number | null;
  /** Override the configured attempt budget for this pass. */
  maxAttempts?: number | null;
  /** Override `analysis_detail.two_stage` for this pass. */
  twoStage?: boolean;
  /**
   * Cover the whole eligible slate rather than the top `limit` by rank.
   *
   * Implies two-stage: a dossier for every eligible posting is ~$58 against
   * ~$12.55 for triage, and the cost case for going wide only holds at the
   * triage price.
   */
  slate?: boolean;
  /**
   * Consider postings past `evergreen_days` as well.
   *
   * Off by default. An evergreen posting is excluded from recommendations, so
   * analyzing one buys a verdict nothing will act on.
   */
  includeEvergreen?: boolean;
  model: string;
  effort: string;
  dryRun: boolean;
  /**
   * Hard ceiling on estimated spend for this pass, in USD. The run stops before
   * the call that would cross it. Undefined means no ceiling, which is what the
   * tool did for its whole life until a $19.54 fortnight made the case for one.
   */
  maxSpendUsd?: number;
}

export interface AnalyzeSummary {
  considered: number;
  analyzed: number;
  fromCache: number;
  failed: number;
  /**
   * One envelope, the same shape every command that spends reports.
   *
   * This used to be four loose `inputTokens` / `cacheCreationTokens` / ...
   * fields while `resume tailor` and `apply` reported
   * `input` / `cacheWrite` / `cacheRead` / `output`. Dollar totals worked
   * because `estimatedCostUsd` was common, but no single query could total
   * TOKENS across the tool.
   */
  usage: TokenUsage;
  /** Calls that were billed but reported no usage. A data-quality count, not a failure. */
  usageMissing: number;
  /**
   * Which postings this pass actually paid for.
   *
   * `analyze` is a batch, so it carries a list where the single-job commands
   * carry one `jobId`. Both are what makes per-application attribution
   * possible - "what did this application cost me?" was unanswerable while the
   * run log recorded totals with nothing to attribute them to.
   */
  jobIds: string[];
  estimatedCostUsd: number;
  /** True when the pass ended on the spend ceiling rather than the job list. */
  stoppedOnBudget?: boolean;
  /** Failures this pass, by kind. Makes "how many were truncation?" answerable. */
  failureKinds: Record<string, number>;
  /** Jobs that reached the attempt limit in this pass and will not be re-offered. */
  parkedAfterFailure: number;
  /** Two-tier only: jobs that earned the full dossier. */
  dossiers: number;
  /** Two-tier only: jobs that got the cheap verdict and nothing more. */
  triageOnly: number;
}

/** Anthropic prompt-cache multipliers relative to the base input rate. */


/**
 * The triage LLM stage. NOT the only place that spends: `resume tailor` and
 * `apply` each cost more per job than this does, and for a long time they
 * reported nothing. Everything here is built around not spending twice:
 *
 *   - Deterministic prefilters run first; only jobs above `minFit` that passed
 *     hard filters are eligible.
 *   - Results are cached on a hash of (description, title, company, model,
 *     profile). An unchanged job is never re-analyzed.
 *   - The candidate profile lives in a prompt-cached system prefix, so the
 *     expensive, stable half of every request is billed at cache-read rates
 *     after the first call in a run.
 *   - Descriptions are truncated to a fixed budget.
 */
/**
 * The deterministic evidence handed to the analyst, in two halves.
 *
 * ONE FUNCTION RETURNING BOTH, because the note is built where the call is
 * made and the cache key is computed in the outer loop. Two copies would drift,
 * and a key that hashes different text than the model saw is worse than no key
 * at all - so the truncation here (`slice(0, 12)` / `slice(0, 8)`) is the same
 * truncation the model receives, not an approximation of it.
 *
 * `stable` deliberately EXCLUDES `fitScore` and `applicationRoi`. `project()`
 * rewrites exactly those two from the observed calibration on every scoring
 * run, and the calibration moves whenever a new analysis lands - so they churn
 * for every un-analyzed job, which is precisely the population the cache
 * serves. Hashing them would invalidate the cache continuously, which is worse
 * than the `profileVersion` this replaces.
 *
 * Hashing only the system prompt would be the opposite error: the signals and
 * the compensation band reach the model through the USER turn, so a change to
 * either would silently reuse an analysis computed under different evidence.
 */
export interface DeterministicNote {
  /** What the model is shown. */
  full: string;
  /** The calibration-stable half, for the cache key. */
  stable: string;
}

export function buildDeterministicNote(job: EnrichedJob): DeterministicNote {
  const comp = `Compensation band: ${job.compensationBand ?? "UNKNOWN"} - ${job.compensationNote ?? ""}`;
  const positive = job.positiveSignals.length ? `Matched signals: ${job.positiveSignals.slice(0, 12).join("; ")}` : "";
  const negative = job.negativeSignals.length ? `Concerns: ${job.negativeSignals.slice(0, 8).join("; ")}` : "";

  return {
    full: [
      `Fit score: ${job.fitScore ?? "n/a"} / Application ROI: ${job.applicationRoi ?? "n/a"} / Lane: ${job.lane ?? "n/a"}`,
      comp,
      positive,
      negative,
    ]
      .filter(Boolean)
      .join("\n"),
    stable: [`Lane: ${job.lane ?? "n/a"}`, comp, positive, negative].filter(Boolean).join("\n"),
  };
}

/**
 * What the analyst was shown, as one address.
 *
 * Replaces `profileVersion = sha256(JSON.stringify(profile))`, which
 * invalidated EVERY cached analysis on any edit to career-profile.yaml - and
 * that file is edited constantly. It hashes the system prompt and the
 * calibration-stable evidence instead: the things that, if they changed, would
 * genuinely have produced a different analysis.
 */
export function evidenceVersion(systemPrompt: string, job: EnrichedJob): string {
  return sha256(`${systemPrompt}\n---\n${buildDeterministicNote(job).stable}`).slice(0, 12);
}

/**
 * The best cached analysis that actually answers what this pass is asking for.
 *
 * Not a plain key lookup, because what the pass is asking for depends on a
 * verdict it has not computed yet:
 *
 * - A full dossier always satisfies a pass, in either mode. Take it.
 * - Single-stage mode wants a dossier and nothing less, so a triage stub is a
 *   miss even when one exists.
 * - Two-stage mode wants a dossier only for the jobs that earn one. A stored
 *   stub IS the verdict that decides that, so it can answer the question
 *   itself: a stub that does not earn a dossier is the complete and correct
 *   result, and this job is free. A stub that DOES earn one is not the answer
 *   - the dossier is - so it counts as a miss.
 *
 * Getting that last case wrong is how a stub becomes permanent: it would be
 * served forever to a pass that was trying to buy the dossier.
 */
export function cachedAnalysisFor(
  repo: JobRepo,
  job: EnrichedJob,
  model: string,
  systemPrompt: string,
  twoStage: boolean,
  dossierPolicy: DossierPolicy,
  identity: AnalysisIdentity,
): Analysis | null {
  const evidence = evidenceVersion(systemPrompt, job);
  const at = (tier: AnalysisTier): Analysis | null =>
    repo.getCachedAnalysis(repo.cacheKey(job.materialHash, job.title, job.company, model, evidence, tier, identity));

  const full = at("full");
  if (full) return full;
  if (!twoStage) return null;

  const stub = at("triage");
  if (!stub) return null;
  // A stored stub carries every field `deservesDossier` reads, so the routing
  // decision here is the one the live pass would make - for free.
  return deservesDossier(stub, dossierPolicy) ? null : stub;
}

/**
 * Buy the dossier for one posting, at the moment someone acts on it.
 *
 * The counterpart to running triage wide. `analyze` is a speculative batch
 * enrichment: of 329 analyzed jobs, 242 still sit at NEW and 54 closed before
 * anyone looked - 10% utilization - while 12 of 43 applications went to jobs
 * never analyzed at all, because the verdict was absent when it was needed.
 * Triage answers "is this worth a human's attention?" across the slate; the
 * dossier answers "apply, and with what angle?", which is only worth asking
 * once a human has decided to act.
 *
 * REQUESTS `tier: "full"` EXPLICITLY. Without it the cache returns the triage
 * stub written by the wide pass and the dossier is never fetched - the exact
 * collision JOB-40 separated the tiers to prevent.
 *
 * Returns null when there is nothing to do, so the caller can tell "already
 * had a dossier" from "bought one".
 */
export async function fetchDossier(
  repo: JobRepo,
  profile: CareerProfile,
  job: EnrichedJob,
  opts: { model: string; effort: string },
): Promise<{ analysis: Analysis; usage: TokenUsage; fromCache: boolean } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const systemPrompt = buildSystemPrompt(profile);
  const laneKeys = Object.keys(profile.lanes);
  const identity = computeAnalysisIdentity(job, profile);
  const evidence = evidenceVersion(systemPrompt, job);
  const key = repo.cacheKey(job.materialHash, job.title, job.company, opts.model, evidence, "full", identity);

  const cached = repo.getCachedAnalysis(key);
  if (cached) {
    repo.saveAnalysis(job.id, cached, opts.model, identity);
    return { analysis: cached, usage: emptyUsage(), fromCache: true };
  }

  const client = new Anthropic({ apiKey });
  const result = await analyzeOne(
    client,
    systemPrompt,
    job,
    { limit: 1, model: opts.model, effort: opts.effort, dryRun: false },
    laneKeys,
    "full",
  );

  repo.saveAnalysis(job.id, result.analysis, opts.model, identity);
  repo.putCachedAnalysis(
    key,
    job.materialHash,
    opts.model,
    result.analysis,
    { input: result.usage.input, output: result.usage.output },
    "full",
  );
  return { analysis: result.analysis, usage: result.usage, fromCache: false };
}

export async function runAnalysis(
  repo: JobRepo,
  profile: CareerProfile,
  opts: AnalyzeOptions,
): Promise<AnalyzeSummary> {
  const diversity = {
    perCompanyCap: profile.analysis_diversity.per_company_cap,
    backfillCap: profile.analysis_diversity.per_company_backfill_cap,
    coldAfter: profile.analysis_diversity.cold_after,
    unexploredBonus: profile.analysis_diversity.unexplored_bonus,
    coldPenalty: profile.analysis_diversity.cold_penalty,
    freshDays: profile.scoring.analysis_fresh_days,
    freshBonus: profile.scoring.analysis_fresh_bonus,
    // Do not pay to analyze a posting that will not be recommended.
    // `--include-evergreen` lifts both at once, deliberately: the two
    // decisions are the same decision.
    evergreenDays: opts.includeEvergreen ? null : profile.scoring.evergreen_days,
    maxAttempts: profile.scoring.analysis_max_attempts,
  };

  // TRIAGE ON THE SLATE, not on the top of it.
  //
  // `analyze` was a speculative batch enrichment of the top-K index: 10% of
  // what it bought was ever used, while 12 of 43 applications went to jobs it
  // had never reached. With triage at roughly a fifth of a dossier's price,
  // the useful question changes from "which few can we afford?" to "how much
  // of the slate can we cover?".
  //
  // Spend is still bounded DIRECTLY, by `--limit` and `max_spend_per_run_usd`,
  // never by a fit proxy - JOB-32 retired that and it is not coming back. So a
  // slate pass that cannot finish in one run simply stops on the ceiling and
  // resumes tomorrow, which is what makes the backfill a multi-run one.
  //
  // Computed once, up front, and reused for every eligibility check and cache
  // lookup below: `evidenceHash` depends only on the profile (JOB-51), not on
  // any one job, so there is exactly one "current" value for this whole pass.
  const systemPrompt = buildSystemPrompt(profile);
  const currentEvidenceHash = sha256(systemPrompt);
  const eligible = repo.eligibleForAnalysis(diversity, currentEvidenceHash, opts.minFit);
  const limit = opts.slate ? Math.max(opts.limit, eligible) : opts.limit;
  const candidates = repo.needingAnalysis(limit, diversity, currentEvidenceHash, opts.minFit);
  if (opts.slate) {
    log.info(`Slate pass: ${eligible} eligible, ${candidates.length} selected. Spend stops the pass, not the list.`);
  }
  const summary: AnalyzeSummary = {
    considered: candidates.length,
    analyzed: 0,
    fromCache: 0,
    failed: 0,
    usage: emptyUsage(),
    usageMissing: 0,
    jobIds: [],
    estimatedCostUsd: 0,
    failureKinds: {},
    parkedAfterFailure: 0,
    dossiers: 0,
    triageOnly: 0,
  };

  if (candidates.length === 0) {
    // With no floor there is only one honest reason to be here, and it is a
    // real one about the jobs rather than about a setting.
    if (opts.minFit == null) {
      log.info("Nothing to analyze: every job that passed filters has already been analyzed.");
      return summary;
    }
    // A floor was set explicitly for this pass, so say what it is holding back
    // rather than just that it held. Reporting only "nothing to analyze" made
    // an over-set threshold look like an exhausted index, and that misreading
    // cost a real afternoon of adding job boards that were never the
    // constraint.
    const below = repo.belowThreshold(opts.minFit);
    if (below.count > 0) {
      log.info(
        `Nothing above the \`--min-fit ${opts.minFit}\` you asked for, but ${below.count} unanalyzed ` +
          `job(s) sit below it` +
          (below.best !== null ? `, the best scoring ${Math.round(below.best)}` : "") +
          `. Drop the flag to analyze the highest-ranked jobs regardless of absolute score - ` +
          `that is the default, because the rank is reliable and the score is not.`,
      );
    } else {
      log.info("Nothing to analyze: every job that passed filters has already been analyzed.");
    }
    return summary;
  }

  // The lane set the analyst is allowed to choose from, straight from config.
  // It reaches the model through the system prompt, so it is inside
  // `evidenceVersion` and therefore inside the cache key: adding a lane
  // invalidates analyses that could not have known about it, which is right.
  const laneKeys = Object.keys(profile.lanes);
  // `--slate` implies two-stage. Going wide is only affordable at the triage
  // price, and the ticket's cost model assumes it.
  const twoStage = opts.slate || (opts.twoStage ?? profile.analysis_detail.two_stage);
  const dossierPolicy = {
    recommendations: profile.analysis_detail.dossier_for,
    minFit: profile.analysis_detail.dossier_min_fit,
  };

  // Serve everything we can from cache before touching the network at all.
  const needsCall: EnrichedJob[] = [];
  for (const job of candidates) {
    const identity = computeAnalysisIdentity(job, profile);
    const cached = cachedAnalysisFor(repo, job, opts.model, systemPrompt, twoStage, dossierPolicy, identity);
    if (cached) {
      repo.saveAnalysis(job.id, cached, opts.model, identity);
      summary.fromCache++;
    } else {
      needsCall.push(job);
    }
  }

  if (summary.fromCache) log.info(`Reused ${summary.fromCache} cached analyses`);

  if (needsCall.length === 0) return summary;

  if (opts.dryRun) {
    log.info(
      `Dry run: would analyze ${needsCall.length} job(s) with ${opts.model} at effort ${opts.effort}. ` +
        `No API calls made.`,
    );
    summary.considered = candidates.length;
    return summary;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, or run with --dry-run.",
    );
  }

  const client = new Anthropic({ apiKey });
  log.info(`Analyzing ${needsCall.length} job(s) with ${opts.model} (effort: ${opts.effort})`);

  for (const [i, job] of needsCall.entries()) {
    // Checked before each call, so a pass stops as soon as the budget is used
    // up rather than reporting an overrun once the money is gone. It can still
    // overshoot by one job's cost - see shouldStopForBudget.
    //
    // This exists because there was no ceiling at all. `--limit` bounded the
    // job count but nothing bounded the bill, so three routine passes in one
    // afternoon came to $4.30 and a fortnight came to $19.54 with the only
    // feedback arriving on a credit-card statement.
    if (shouldStopForBudget(summary.estimatedCostUsd, opts.maxSpendUsd)) {
      summary.stoppedOnBudget = true;
      log.warn(
        `Stopping at ${summary.analyzed} of ${needsCall.length}: spend ceiling of ` +
          `$${(opts.maxSpendUsd ?? 0).toFixed(2)} reached ($${summary.estimatedCostUsd.toFixed(4)}). ` +
          `Raise it with --max-spend, or run again to continue where this left off.`,
      );
      break;
    }
    try {
      // Two-tier: a cheap verdict for everything, a dossier only for the few
      // that earn one. 77% of analyses end in `skip`, and the dossier is about
      // three quarters of the output bytes on each.
      //
      // The dossier decision is deterministic (`deservesDossier`) rather than
      // asked of the model: it decides where money goes, so it has to be
      // reproducible and auditable.
      let result: OneResult;
      if (twoStage) {
        const triaged = await analyzeOne(client, systemPrompt, job, opts, laneKeys, "triage");
        result = triaged;
        const verdict = triaged.triage;
        if (verdict && deservesDossier(verdict, dossierPolicy)) {
          // The system prefix is prompt-cached, so this second call bills its
          // large invariant half at cache-read rates.
          const full = await analyzeOne(client, systemPrompt, job, opts, laneKeys, "full");
          result = {
            analysis: full.analysis,
            triage: verdict,
            usage: addUsage(triaged.usage, full.usage),
            usageMissing: triaged.usageMissing || full.usageMissing,
          };
          summary.dossiers++;
        } else {
          summary.triageOnly++;
        }
      } else {
        result = await analyzeOne(client, systemPrompt, job, opts, laneKeys);
      }
      const identity = computeAnalysisIdentity(job, profile);
      repo.saveAnalysis(job.id, result.analysis, opts.model, identity);
      // Stored under the tier actually produced. Writing a triage stub under
      // the dossier's key is defect 1 of JOB-40: every later read gets the stub.
      const producedTier: AnalysisTier = isTriageOnly(result.analysis) ? "triage" : "full";
      const key = repo.cacheKey(
        job.materialHash,
        job.title,
        job.company,
        opts.model,
        evidenceVersion(systemPrompt, job),
        producedTier,
        identity,
      );
      repo.putCachedAnalysis(
        key,
        job.materialHash,
        opts.model,
        result.analysis,
        { input: result.usage.input, output: result.usage.output },
        producedTier,
      );

      summary.analyzed++;
      summary.jobIds.push(job.id);
      summary.usage = addUsage(summary.usage, result.usage);
      if (result.usageMissing) summary.usageMissing++;
      summary.estimatedCostUsd = estimateCostUsd(summary.usage, opts.model);

      log.info(
        `  [${i + 1}/${needsCall.length}] ${job.company} - ${job.title} -> ` +
          `fit ${result.analysis.fitScore}, roi ${result.analysis.applicationRoi}, ${result.analysis.recommendation}`,
      );
    } catch (err) {
      summary.failed++;
      const message = (err as Error).message;
      const kind = classifyAnalysisFailure(message);

      // Recorded, not just logged. The console is not a database: ten failures
      // costing roughly $0.46 recurred precisely because the reason was gone
      // the moment the run ended.
      //
      // An API failure is about the network or the account, not this posting,
      // so it is stored for visibility but does not spend the job's attempts.
      // Otherwise two dropped connections would park a perfectly analysable job.
      const counted = countsAgainstJob(kind);
      let attempts = 0;
      try {
        attempts = repo.recordAnalysisFailure(job.id, kind, message, counted);
      } catch (recordErr) {
        log.warn(`  could not record the failure: ${(recordErr as Error).message}`);
      }
      const budget = opts.maxAttempts ?? profile.scoring.analysis_max_attempts;
      const parked = counted && attempts >= budget;

      summary.failureKinds[kind] = (summary.failureKinds[kind] ?? 0) + 1;
      if (parked) summary.parkedAfterFailure++;

      log.warn(
        `  analysis failed for ${job.company} - ${job.title} [${kind}]: ${message}` +
          (parked
            ? ` -- attempt ${attempts} of ${budget}; not offering this job again until its posting changes.`
            : counted
              ? ` -- attempt ${attempts} of ${budget}.`
              : ` -- not counted against the job; this is an API failure, not a posting problem.`),
      );
    }
  }

  summary.estimatedCostUsd = estimateCostUsd(summary.usage, opts.model);

  if (summary.analyzed > 1 && (summary.usage.cacheRead ?? 0) === 0) {
    // Caching is the mechanism that makes analysing a large slate affordable.
    // Silence here would hide a regression, so say it out loud.
    log.warn(
      "Prompt cache was never read across multiple calls. The system prefix may have become " +
        "non-deterministic - check that nothing job-specific leaked into buildSystemPrompt().",
    );
  }

  return summary;
}

export interface OneResult {
  analysis: Analysis;
  /** Set only on a triage call, so the caller can apply the dossier policy. */
  triage: TriageVerdict | null;
  /** One envelope, the same shape every command that spends reports. */
  usage: TokenUsage;
  /** The call was billed but reported no receipt. Counted, never thrown on. */
  usageMissing: boolean;
}

/**
 * Should this pass stop before paying for the next job?
 *
 * Extracted for the same reason `statusAfterAutofill` is: the decision that
 * governs whether money leaves the account should live somewhere a test can
 * reach, not inside a loop body that nothing exercises.
 *
 * Checked before each call rather than at the end of the pass, so the run stops
 * as soon as the budget is used up instead of reporting an overrun once the
 * money is gone.
 *
 * This is a stop-when-reached ceiling, not a predictive one: the call that
 * carries spend past the ceiling has already been paid for when this returns
 * true, so a pass can overshoot by one job's cost. Bounding it tighter would
 * mean estimating the next job's price before making the call, and an estimate
 * that runs high would refuse jobs the budget could afford. Overshooting by one
 * job is the smaller error.
 *
 * `>=` not `>`: at exactly the ceiling the budget is used up. Spending one more
 * job's worth and calling it "not yet over" is how a ceiling becomes a
 * suggestion.
 */
export function shouldStopForBudget(spentUsd: number, ceilingUsd: number | undefined): boolean {
  if (ceilingUsd == null) return false;
  return spentUsd >= ceilingUsd;
}

/**
 * Whether a model accepts `output_config.effort`.
 *
 * Allow-listing the families known to reject it rather than the ones known to
 * accept it: an unknown model is far more likely to be a newer one that takes
 * the parameter than an older one that does not, and the failure mode of
 * guessing wrong in that direction is one 400 rather than silently dropping
 * the setting on every call.
 */
/**
 * Output ceiling for one analysis.
 *
 * Named so the truncation message can quote it. A response that hits this stops
 * mid-object and arrives as unparseable JSON, which is why `stop_reason` is
 * checked before the parse rather than after it.
 */
export const MAX_OUTPUT_TOKENS = 16000;

export function supportsEffort(model: string): boolean {
  return !/^claude-haiku/.test(model);
}

export async function analyzeOne(
  client: Anthropic,
  systemPrompt: string,
  job: EnrichedJob,
  opts: AnalyzeOptions,
  /**
   * Lanes this profile defines, in config order. Passed down rather than read
   * from a module constant so that adding a lane in YAML needs no TypeScript
   * edit - which is the whole point of JOB-29.
   */
  laneKeys: readonly string[],
  /**
   * "triage" asks for a verdict and one sentence; "full" asks for the dossier.
   * Both are validated strictly - the tier changes what is requested, never
   * whether the response is checked.
   */
  tier: "triage" | "full" = "full",
): Promise<OneResult> {
  const note = buildDeterministicNote(job);

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // The system prefix is identical for every job in the run, so caching it
    // makes the marginal cost of each additional job close to the description
    // itself. Verify with usage.cache_read_input_tokens > 0 after the first call.
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      // Not every model accepts `effort`. Haiku 4.5 rejects it with a 400
      // ("This model does not support the effort parameter"), so passing it
      // unconditionally made `analyze --model claude-haiku-4-5` fail on every
      // single job rather than fall back - found while benchmarking cheaper
      // models against Opus verdicts.
      ...(supportsEffort(opts.model) ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      format: {
        type: "json_schema",
        schema: (tier === "triage"
          ? buildTriageJsonSchema(laneKeys)
          : buildAnalysisJsonSchema(laneKeys)) as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: "user", content: buildUserPrompt(job, note.full) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model declined to analyze this posting.");
  }

  // Say "truncated" rather than letting it surface as a JSON parse error.
  //
  // A response cut off at max_tokens IS invalid JSON, so without this the two
  // are indistinguishable in the record - and they call for opposite responses.
  // Truncation is a setting to raise or an output schema to shrink; malformed
  // JSON from a constrained decode is a model problem. This was the leading
  // hypothesis for the recorded failures and nothing could confirm or refute
  // it, because no reason was ever stored.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Response hit max_tokens (${MAX_OUTPUT_TOKENS}) and was truncated mid-object. ` +
        `Raise the ceiling or shrink the output schema.`,
    );
  }

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("No text block in response.");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Response was not valid JSON: ${text.slice(0, 200)}`);
  }

  // Structured outputs constrain the shape, but we validate anyway: nothing
  // unvalidated is allowed into the database.
  const schema = tier === "triage" ? triageSchemaFor(laneKeys) : analysisSchemaFor(laneKeys);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Response failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  const reading = readUsage(response, `analyze ${job.id} (${tier})`);
  return {
    analysis:
      tier === "triage"
        ? triageOnlyAnalysis(parsed.data as TriageVerdict)
        : (parsed.data as Analysis),
    triage: tier === "triage" ? (parsed.data as TriageVerdict) : null,
    usage: reading.usage,
    usageMissing: reading.missing,
  };
}
