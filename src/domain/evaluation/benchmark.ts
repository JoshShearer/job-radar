import type { EvaluationPolicy } from "../config/schema.js";
import { earnsDossier, type Dossier, type Triage } from "./assessment.js";

/**
 * Does the cheap triage verdict reach the same decision as the full dossier?
 *
 * Two questions, both measured on every run because the calls are the
 * expensive part; `mode` only decides which one is the GATE.
 *
 * `verdict` - can triage REPLACE the dossier? Agreement on apply-vs-not, the
 *   decision the tool drives. Measured at 81-89% against a 92% bar in the old
 *   tool: no.
 * `routing` - can triage DECIDE WHO GETS a dossier? A missed dossier silently
 *   demotes a role below a human's attention, and nothing later recovers it;
 *   an extra dossier only costs money. So any miss fails, and a 0-miss result
 *   counts only on enough baselines to mean something.
 *
 * A baseline whose dossier was bought BECAUSE a triage verdict earned it can
 * never show a missed dossier, so it is excluded from the routing question
 * (it still counts for the verdict question).
 */
export type BenchmarkMode = "verdict" | "routing";

/** Rule of three: 0 misses in n trials bounds the miss rate near 3/n. 40 bounds it near 7%. */
export const MIN_ROUTING_SAMPLE = 40;
export const VERDICT_BAR = 0.92;

export interface BenchmarkRow {
  opportunityId: string;
  company: string;
  title: string;
  baselineRecommendation: string;
  triageRecommendation: string;
  baselineFit: number;
  triageFit: number;
  agreesOnApply: boolean;
  /** The dossier was bought after (and because) a triage verdict routed it; not evidence about routing. */
  preRouted: boolean;
  baselineEarnsDossier: boolean;
  triageEarnsDossier: boolean;
}

export interface BenchmarkSummary {
  compared: number;
  agreeOnApply: number;
  agreementRate: number;
  meanAbsFitDelta: number;
  missedApplies: BenchmarkRow[];
  spuriousApplies: BenchmarkRow[];
  routingCompared: number;
  missedDossiers: BenchmarkRow[];
  extraDossiers: BenchmarkRow[];
}

export interface Gate {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reason: string;
}

const isApply = (r: string) => r === "apply" || r === "apply_and_outreach";

/** A dossier's verdict, read through the same rule that routes triage. */
function dossierEarns(d: Dossier, policy: EvaluationPolicy["assessment"]): boolean {
  return earnsDossier({ recommendation: d.recommendation, fitScore: d.fitScore } as Triage, policy);
}

export function benchmarkRow(
  subject: { opportunityId: string; company: string; title: string },
  baseline: Dossier,
  triage: Triage,
  preRouted: boolean,
  policy: EvaluationPolicy["assessment"],
): BenchmarkRow {
  return {
    ...subject,
    baselineRecommendation: baseline.recommendation,
    triageRecommendation: triage.recommendation,
    baselineFit: baseline.fitScore,
    triageFit: triage.fitScore,
    agreesOnApply: isApply(baseline.recommendation) === isApply(triage.recommendation),
    preRouted,
    baselineEarnsDossier: dossierEarns(baseline, policy),
    triageEarnsDossier: earnsDossier(triage, policy),
  };
}

export function summarizeBenchmark(rows: readonly BenchmarkRow[]): BenchmarkSummary {
  const agree = rows.filter((r) => r.agreesOnApply).length;
  const routing = rows.filter((r) => !r.preRouted);
  return {
    compared: rows.length,
    agreeOnApply: agree,
    agreementRate: rows.length ? agree / rows.length : 0,
    meanAbsFitDelta: rows.length ? rows.reduce((a, r) => a + Math.abs(r.baselineFit - r.triageFit), 0) / rows.length : 0,
    missedApplies: rows.filter((r) => isApply(r.baselineRecommendation) && !isApply(r.triageRecommendation)),
    spuriousApplies: rows.filter((r) => !isApply(r.baselineRecommendation) && isApply(r.triageRecommendation)),
    routingCompared: routing.length,
    missedDossiers: routing.filter((r) => r.baselineEarnsDossier && !r.triageEarnsDossier),
    extraDossiers: routing.filter((r) => !r.baselineEarnsDossier && r.triageEarnsDossier),
  };
}

export function verdictGate(s: BenchmarkSummary): Gate {
  const pct = `${(s.agreementRate * 100).toFixed(1)}%`;
  if (s.compared === 0) return { verdict: "INCONCLUSIVE", reason: "no baselines compared" };
  return s.agreementRate >= VERDICT_BAR
    ? { verdict: "PASS", reason: `${pct} apply-vs-not agreement, at or above the ${VERDICT_BAR * 100}% bar.` }
    : { verdict: "FAIL", reason: `${pct} apply-vs-not agreement, below the ${VERDICT_BAR * 100}% bar. Triage can route, not replace.` };
}

export function routingGate(s: BenchmarkSummary): Gate {
  if (s.missedDossiers.length > 0) {
    return { verdict: "FAIL", reason: `${s.missedDossiers.length} missed dossier(s). A missed dossier silently demotes a role below a human's attention.` };
  }
  if (s.routingCompared < MIN_ROUTING_SAMPLE) {
    return {
      verdict: "INCONCLUSIVE",
      reason: `0 missed dossiers, but only ${s.routingCompared} of the ${MIN_ROUTING_SAMPLE} independent baselines needed to bound the miss rate near 7%.`,
    };
  }
  return { verdict: "PASS", reason: `0 missed dossiers across ${s.routingCompared} independent baselines.` };
}

/**
 * Which baselines to spend on. `routing` puts dossier-earning, independent
 * baselines first (only they can be missed); `verdict` puts apply-class first
 * (a uniform sample is mostly skips and says nothing about the decision).
 */
export function orderBaselines<T extends { baseline: Dossier; preRouted: boolean }>(
  items: readonly T[],
  mode: BenchmarkMode,
  policy: EvaluationPolicy["assessment"],
): T[] {
  const weight = (x: T) =>
    mode === "routing"
      ? (x.preRouted ? 2 : 0) + (dossierEarns(x.baseline, policy) ? 0 : 1)
      : isApply(x.baseline.recommendation)
        ? 0
        : 1;
  return [...items].map((x, i) => ({ x, i })).sort((a, b) => weight(a.x) - weight(b.x) || a.i - b.i).map((p) => p.x);
}
