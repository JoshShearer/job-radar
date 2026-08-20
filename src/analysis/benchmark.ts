import Anthropic from "@anthropic-ai/sdk";
import type { CareerProfile } from "../config/schema.js";
import type { JobRepo } from "../db/repo.js";
import type { Analysis } from "../model/job.js";
import { estimateCostUsd } from "../lib/cost.js";
import { log } from "../lib/log.js";
import { analyzeOne } from "./analyzer.js";
import { buildSystemPrompt } from "./prompt.js";

/**
 * Does the cheap triage form reach the same VERDICT as the full dossier form?
 *
 * The gate JOB-31 requires before two-tier analysis can become the default.
 *
 * The worry it exists to test is specific and plausible: the dossier's forced
 * strengths / risks / missingRequirements fields may be acting as reasoning
 * scaffolding. A model made to justify a verdict may reach a better one, in
 * which case a cheaper analysis would be quietly worse - and with no outcome
 * data yet (JOB-26) that regression would be invisible for months.
 *
 * Agreement is measured on APPLY-VS-NOT, not on the exact recommendation.
 * That is the decision the tool actually drives: `skip` versus
 * `network_or_watch` changes nothing about what a person does today, while
 * apply versus not-apply changes everything.
 */
export interface TriageBenchmarkRow {
  id: string;
  company: string;
  title: string;
  baselineRecommendation: string;
  triageRecommendation: string;
  baselineFit: number;
  triageFit: number;
  /** Did both forms agree on whether this is worth applying to? */
  agreesOnApply: boolean;
}

export interface TriageBenchmark {
  rows: TriageBenchmarkRow[];
  compared: number;
  failed: number;
  agreeOnApply: number;
  agreementRate: number;
  meanAbsFitDelta: number;
  estimatedCostUsd: number;
  /** Baseline apply-recommendations the triage form missed. The expensive kind of miss. */
  missedApplies: TriageBenchmarkRow[];
  /** Applies the triage form invented. Wastes a person's time rather than hiding a role. */
  spuriousApplies: TriageBenchmarkRow[];
}

const APPLY_VERDICTS = new Set(["apply", "apply_and_outreach"]);
const isApply = (r: string): boolean => APPLY_VERDICTS.has(r);

export async function benchmarkTriage(
  repo: JobRepo,
  profile: CareerProfile,
  opts: { limit: number; model: string; effort: string },
): Promise<TriageBenchmark> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const sample = repo.analyzedSample(opts.limit);
  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(profile);
  const laneKeys = Object.keys(profile.lanes);

  const rows: TriageBenchmarkRow[] = [];
  let failed = 0;
  let input = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let output = 0;

  for (const [i, entry] of sample.entries()) {
    const baseline: Analysis = entry.analysis;
    try {
      const r = await analyzeOne(
        client,
        systemPrompt,
        entry.job,
        { limit: 1, model: opts.model, effort: opts.effort, dryRun: false },
        laneKeys,
        "triage",
      );
      input += r.inputTokens;
      cacheWrite += r.cacheCreationTokens;
      cacheRead += r.cacheReadTokens;
      output += r.outputTokens;

      rows.push({
        id: entry.job.id,
        company: entry.job.company,
        title: entry.job.title,
        baselineRecommendation: baseline.recommendation,
        triageRecommendation: r.analysis.recommendation,
        baselineFit: baseline.fitScore,
        triageFit: r.analysis.fitScore,
        agreesOnApply: isApply(baseline.recommendation) === isApply(r.analysis.recommendation),
      });
      log.info(
        `  [${i + 1}/${sample.length}] ${entry.job.company}: ` +
          `${baseline.recommendation} -> ${r.analysis.recommendation} ` +
          `(fit ${baseline.fitScore} -> ${r.analysis.fitScore})`,
      );
    } catch (err) {
      failed++;
      log.warn(`  [${i + 1}/${sample.length}] ${entry.job.company}: ${(err as Error).message}`);
    }
  }

  const agree = rows.filter((r) => r.agreesOnApply).length;
  return {
    rows,
    compared: rows.length,
    failed,
    agreeOnApply: agree,
    agreementRate: rows.length ? agree / rows.length : 0,
    meanAbsFitDelta: rows.length
      ? rows.reduce((a, r) => a + Math.abs(r.baselineFit - r.triageFit), 0) / rows.length
      : 0,
    estimatedCostUsd: estimateCostUsd({ input, cacheWrite, cacheRead, output }, opts.model),
    missedApplies: rows.filter((r) => isApply(r.baselineRecommendation) && !isApply(r.triageRecommendation)),
    spuriousApplies: rows.filter((r) => !isApply(r.baselineRecommendation) && isApply(r.triageRecommendation)),
  };
}
