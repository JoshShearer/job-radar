import Anthropic from "@anthropic-ai/sdk";
import type { CareerProfile } from "../config/schema.js";
import type { Analysis, EnrichedJob } from "../model/job.js";
import { AnalysisSchema } from "../model/job.js";
import type { JobRepo } from "../db/repo.js";
import { ANALYSIS_JSON_SCHEMA } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { sha256 } from "../lib/hash.js";
import { log } from "../lib/log.js";

import { estimateCostUsd, PRICING } from "../lib/cost.js";

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
  minFit: number;
  model: string;
  effort: string;
  dryRun: boolean;
}

export interface AnalyzeSummary {
  considered: number;
  analyzed: number;
  fromCache: number;
  failed: number;
  /** Uncached input tokens, billed at full rate. */
  inputTokens: number;
  /** Tokens written to the prompt cache, billed at 1.25x. */
  cacheCreationTokens: number;
  /** Tokens served from the prompt cache, billed at 0.1x. */
  cacheReadTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
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
export async function runAnalysis(
  repo: JobRepo,
  profile: CareerProfile,
  opts: AnalyzeOptions,
): Promise<AnalyzeSummary> {
  const candidates = repo.needingAnalysis(opts.minFit, opts.limit, {
    perCompanyCap: profile.analysis_diversity.per_company_cap,
    backfillCap: profile.analysis_diversity.per_company_backfill_cap,
    coldAfter: profile.analysis_diversity.cold_after,
    unexploredBonus: profile.analysis_diversity.unexplored_bonus,
    coldPenalty: profile.analysis_diversity.cold_penalty,
  });
  const summary: AnalyzeSummary = {
    considered: candidates.length,
    analyzed: 0,
    fromCache: 0,
    failed: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  if (candidates.length === 0) {
    // Say what the gate is holding back, not just that it held. Reporting only
    // "nothing to analyze" made an over-set threshold look like an exhausted
    // index, and that misreading cost a real afternoon.
    const below = repo.belowThreshold(opts.minFit);
    if (below.count > 0) {
      log.info(
        `Nothing above the fit threshold of ${opts.minFit}, but ${below.count} unanalyzed job(s) sit below it` +
          (below.best !== null ? `, the best scoring ${Math.round(below.best)}` : "") +
          `. Lower the bar with \`--min-fit\` for this pass, or change \`analysis_threshold\` in ` +
          `config/career-profile.yaml if the gate is wrong rather than the jobs.`,
      );
    } else {
      log.info("Nothing to analyze: every job that passed filters has already been analyzed.");
    }
    return summary;
  }

  const profileVersion = sha256(JSON.stringify(profile)).slice(0, 12);
  const systemPrompt = buildSystemPrompt(profile);

  // Serve everything we can from cache before touching the network at all.
  const needsCall: EnrichedJob[] = [];
  for (const job of candidates) {
    const key = repo.cacheKey(job.descriptionHash, job.title, job.company, opts.model, profileVersion);
    const cached = repo.getCachedAnalysis(key);
    if (cached) {
      repo.saveAnalysis(job.id, cached, opts.model);
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
    try {
      const result = await analyzeOne(client, systemPrompt, job, opts);
      repo.saveAnalysis(job.id, result.analysis, opts.model);
      const key = repo.cacheKey(job.descriptionHash, job.title, job.company, opts.model, profileVersion);
      repo.putCachedAnalysis(key, job.descriptionHash, opts.model, result.analysis, {
        input: result.inputTokens,
        output: result.outputTokens,
      });

      summary.analyzed++;
      summary.inputTokens += result.inputTokens;
      summary.cacheCreationTokens += result.cacheCreationTokens;
      summary.cacheReadTokens += result.cacheReadTokens;
      summary.outputTokens += result.outputTokens;

      log.info(
        `  [${i + 1}/${needsCall.length}] ${job.company} - ${job.title} -> ` +
          `fit ${result.analysis.fitScore}, roi ${result.analysis.applicationRoi}, ${result.analysis.recommendation}`,
      );
    } catch (err) {
      summary.failed++;
      log.warn(`  analysis failed for ${job.company} - ${job.title}: ${(err as Error).message}`);
    }
  }

  summary.estimatedCostUsd = estimateCostUsd(
    {
      input: summary.inputTokens,
      cacheWrite: summary.cacheCreationTokens,
      cacheRead: summary.cacheReadTokens,
      output: summary.outputTokens,
    },
    opts.model,
  );

  if (summary.analyzed > 1 && summary.cacheReadTokens === 0) {
    // Caching is the mechanism that makes analysing a large slate affordable.
    // Silence here would hide a regression, so say it out loud.
    log.warn(
      "Prompt cache was never read across multiple calls. The system prefix may have become " +
        "non-deterministic - check that nothing job-specific leaked into buildSystemPrompt().",
    );
  }

  return summary;
}

interface OneResult {
  analysis: Analysis;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

async function analyzeOne(
  client: Anthropic,
  systemPrompt: string,
  job: EnrichedJob,
  opts: AnalyzeOptions,
): Promise<OneResult> {
  const deterministicNote = [
    `Fit score: ${job.fitScore ?? "n/a"} / Application ROI: ${job.applicationRoi ?? "n/a"} / Lane: ${job.lane ?? "n/a"}`,
    `Compensation band: ${job.compensationBand ?? "UNKNOWN"} - ${job.compensationNote ?? ""}`,
    job.positiveSignals.length ? `Matched signals: ${job.positiveSignals.slice(0, 12).join("; ")}` : "",
    job.negativeSignals.length ? `Concerns: ${job.negativeSignals.slice(0, 8).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 16000,
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
      effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max",
      format: {
        type: "json_schema",
        schema: ANALYSIS_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: "user", content: buildUserPrompt(job, deterministicNote) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Model declined to analyze this posting.");
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
  const parsed = AnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Response failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  return {
    analysis: parsed.data,
    inputTokens: response.usage.input_tokens,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    outputTokens: response.usage.output_tokens,
  };
}
