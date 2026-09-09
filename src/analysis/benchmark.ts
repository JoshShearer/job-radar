import Anthropic from "@anthropic-ai/sdk";
import type { CareerProfile } from "../config/schema.js";
import type { JobRepo } from "../db/repo.js";
import type { Analysis } from "../model/job.js";
import { estimateCostUsd } from "../lib/cost.js";
import { log } from "../lib/log.js";
import { analyzeOne } from "./analyzer.js";
import { buildSystemPrompt } from "./prompt.js";
import { isApplyVerdict as isApply } from "./endorsement.js";
import { deservesDossier, type DossierPolicy } from "./detail.js";

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
  /** Did the baseline dossier earn itself, under the current policy? */
  baselineEarnsDossier: boolean;
  /** Would the triage verdict have routed this to a dossier? */
  triageEarnsDossier: boolean;
  /** Did both forms route this the same way? */
  agreesOnRouting: boolean;
}

/**
 * Which question the run is gated on.
 *
 * `verdict` - can triage REPLACE the dossier? That is the JOB-31 gate, and the
 * answer measured at 81% against a 92% bar was no. It stays the default so
 * that gate is untouched.
 *
 * `routing` - can triage DECIDE WHO GETS a dossier? That is what the code
 * actually uses it for, and it is a strictly easier question: a verdict that
 * moves `network_or_watch -> apply` is a disagreement under `verdict` and no
 * disagreement at all under `routing`, because `dossier_for` sends both to a
 * dossier.
 */
export type BenchmarkMode = "verdict" | "routing";

export interface TriageBenchmark {
  mode: BenchmarkMode;
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
  /** Share of jobs routed the same way by both forms. */
  routingAgreementRate: number;
  /**
   * Dossiers the triage form would have withheld. THE BLOCKING METRIC.
   *
   * Not symmetric with `extraDossiers`: a missed dossier silently demotes a
   * role below a human's attention and there is no later step that recovers
   * it. An extra dossier costs $0.046.
   */
  missedDossiers: TriageBenchmarkRow[];
  /** Dossiers the triage form would have bought unnecessarily. A cost line, not a failure. */
  extraDossiers: TriageBenchmarkRow[];
  /** The policy these routing numbers were measured against. */
  policy: DossierPolicy;
}

/**
 * How many dossier-routing baselines make a 0-miss result mean anything.
 *
 * Rule of three: an observed 0 misses in n trials bounds the true miss rate at
 * roughly 3/n. The recorded run's 12 apply-class baselines bounded it only at
 * ~25%, which is not evidence of anything. 40 bounds it near 7%.
 */
export const MIN_ROUTING_SAMPLE = 40;


export async function benchmarkTriage(
  repo: JobRepo,
  profile: CareerProfile,
  opts: { limit: number; model: string; effort: string; mode?: BenchmarkMode },
): Promise<TriageBenchmark> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const mode: BenchmarkMode = opts.mode ?? "verdict";
  const policy: DossierPolicy = {
    recommendations: profile.analysis_detail.dossier_for,
    minFit: profile.analysis_detail.dossier_min_fit,
  };
  // The sample follows the question. An apply-class sample cannot answer the
  // routing question - only 22 apply-class baselines exist, so a >=40 gate on
  // it would be unsatisfiable - and a dossier-routing sample is drawn by the
  // very function the gate measures.
  const sample =
    mode === "routing" ? repo.analyzedSample(opts.limit, { split: "dossier", policy }) : repo.analyzedSample(opts.limit);
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
      input += r.usage.input;
      cacheWrite += r.usage.cacheWrite ?? 0;
      cacheRead += r.usage.cacheRead ?? 0;
      output += r.usage.output;

      // BOTH metric families are computed on every run, whatever the mode.
      // The calls are the expensive part; having made them, refusing to answer
      // the other question would mean buying the same sample twice. `mode`
      // decides which number is the GATE, not which is measured.
      const baselineEarnsDossier = deservesDossier(baseline, policy);
      const triageEarnsDossier = deservesDossier(r.analysis, policy);
      rows.push({
        id: entry.job.id,
        company: entry.job.company,
        title: entry.job.title,
        baselineRecommendation: baseline.recommendation,
        triageRecommendation: r.analysis.recommendation,
        baselineFit: baseline.fitScore,
        triageFit: r.analysis.fitScore,
        agreesOnApply: isApply(baseline.recommendation) === isApply(r.analysis.recommendation),
        baselineEarnsDossier,
        triageEarnsDossier,
        agreesOnRouting: baselineEarnsDossier === triageEarnsDossier,
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
  const routingAgree = rows.filter((r) => r.agreesOnRouting).length;
  return {
    mode,
    policy,
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
    routingAgreementRate: rows.length ? routingAgree / rows.length : 0,
    missedDossiers: rows.filter((r) => r.baselineEarnsDossier && !r.triageEarnsDossier),
    extraDossiers: rows.filter((r) => !r.baselineEarnsDossier && r.triageEarnsDossier),
  };
}

/**
 * Does a routing benchmark clear the bar for switching `two_stage` on?
 *
 * Two conditions, and the sample-size one is not a formality. A 0-miss result
 * on 5 rows is not evidence; reporting it as a pass is how an unmeasured
 * change gets shipped wearing a measurement's clothes.
 */
export function routingGate(result: TriageBenchmark): {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reason: string;
} {
  if (result.missedDossiers.length > 0) {
    return {
      verdict: "FAIL",
      reason: `${result.missedDossiers.length} missed dossier(s). A missed dossier silently demotes a role below a human's attention.`,
    };
  }
  if (result.compared < MIN_ROUTING_SAMPLE) {
    return {
      verdict: "INCONCLUSIVE",
      reason: `0 missed dossiers, but only ${result.compared} of the ${MIN_ROUTING_SAMPLE} baselines needed to bound the miss rate near 7%.`,
    };
  }
  return {
    verdict: "PASS",
    reason: `0 missed dossiers across ${result.compared} dossier-routing baselines.`,
  };
}
