import type { AppContext } from "./context.js";
import { runSpend } from "./spend.js";
import { requestsFor } from "./assess.js";
import { addressOf, BudgetRefusal, cached, callModel, ModelFailure, NoModelConfigured } from "./gateway.js";
import { candidateBrief } from "./assessment-requests.js";
import type { Dossier } from "../domain/evaluation/assessment.js";
import {
  benchmarkRow,
  orderBaselines,
  routingGate,
  summarizeBenchmark,
  verdictGate,
  type BenchmarkMode,
  type BenchmarkRow,
  type BenchmarkSummary,
  type Gate,
} from "../domain/evaluation/benchmark.js";
import { degraded, ok, refused, type UseCaseResult } from "../kernel/result.js";

export interface BenchmarkOptions {
  limit: number;
  mode: BenchmarkMode;
  /** Without it, report the sample and the worst-case cost and spend nothing. */
  yes: boolean;
  maxSpendUsd?: number;
}

export interface BenchmarkResult {
  mode: BenchmarkMode;
  baselines: number;
  sampled: number;
  /** Triage answers that already existed (bought by an earlier two-stage assess): free. */
  fromCache: number;
  failed: number;
  rows: BenchmarkRow[];
  summary: BenchmarkSummary | null;
  gate: Gate | null;
  spentUsd: number;
  stoppedOnBudget: string | null;
}

/**
 * Re-ask postings that have a CURRENT dossier the cheap triage question, and
 * compare. Baselines are only current dossiers: an imported (legacy) verdict
 * was formed against inputs that cannot be reconstructed, so it cannot be
 * compared to an answer about today's posting.
 */
export async function benchmarkTriage(ctx: AppContext, runId: number, opts: BenchmarkOptions): Promise<UseCaseResult<BenchmarkResult>> {
  const policy = ctx.config().policy.assessment;
  const result: BenchmarkResult = {
    mode: opts.mode,
    baselines: 0,
    sampled: 0,
    fromCache: 0,
    failed: 0,
    rows: [],
    summary: null,
    gate: null,
    spentUsd: 0,
    stoppedOnBudget: null,
  };
  const brief = candidateBrief(ctx);
  if (!brief) return refused(result, ["No evidence ledger: nothing to benchmark against."]);

  const candidates: Array<{ row: ReturnType<typeof ctx.store.ranking>[number]; baseline: Dossier; preRouted: boolean; reqs: NonNullable<ReturnType<typeof requestsFor>> }> = [];
  for (const row of ctx.store.ranking({ eligible: true })) {
    const reqs = requestsFor(ctx, row, brief, runId);
    if (!reqs) continue;
    const d = cached(ctx, reqs.dossier);
    if (!d) continue;
    // Pre-routed: a triage answer to today's question existed BEFORE the
    // dossier, i.e. the dossier was bought because triage earned it.
    const tri = ctx.store.getDerivation(reqs.triage.kind, addressOf(reqs.triage));
    const dos = ctx.store.getDerivation(reqs.dossier.kind, d.key);
    const preRouted = !!tri && !!dos && tri.createdAt <= dos.createdAt;
    candidates.push({ row, baseline: d.value, preRouted, reqs: { ...reqs, triage: { ...reqs.triage, purpose: "benchmark" } } });
  }
  result.baselines = candidates.length;
  const sample = orderBaselines(candidates, opts.mode, policy).slice(0, opts.limit);
  result.sampled = sample.length;
  if (!sample.length) {
    return refused(result, ["No current dossiers to compare against. Buy some first: `jr assess --single-stage --limit n` (independent of triage routing)."]);
  }
  if (!opts.yes) {
    const toBuy = sample.filter((c) => !cached(ctx, c.reqs.triage)).length;
    return ok(result, [
      `Would compare ${sample.length} of ${candidates.length} dossier baseline(s) (${sample.filter((c) => !c.preRouted).length} independent of triage routing).`,
      `${sample.length - toBuy} triage answer(s) already exist and are free; ${toBuy} would be bought through the budgeted gateway.`,
      "Re-run with --yes to make the calls.",
    ]);
  }
  if (!ctx.modelClient()) return refused(result, ["ANTHROPIC_API_KEY is not set. Nothing was spent."]);

  for (const c of sample) {
    try {
      const t = await callModel(ctx, { ...c.reqs.triage, ...(opts.maxSpendUsd !== undefined ? { runCeilingUsd: opts.maxSpendUsd } : {}) });
      if (t.fromCache) result.fromCache++;
      result.rows.push(benchmarkRow({ opportunityId: c.row.opportunityId, company: c.row.company, title: c.row.title }, c.baseline, t.value, c.preRouted, policy));
    } catch (err) {
      if (err instanceof BudgetRefusal) {
        result.stoppedOnBudget = err.message;
        break;
      }
      if (err instanceof NoModelConfigured) return refused(result, [err.message]);
      if (err instanceof ModelFailure) {
        result.failed++;
        ctx.log(`  ${c.row.company} - ${c.row.title} failed [${err.outcome}]: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  result.summary = summarizeBenchmark(result.rows);
  result.gate = opts.mode === "routing" ? routingGate(result.summary) : verdictGate(result.summary);
  result.spentUsd = runSpend(ctx, runId);
  const notes: string[] = [];
  if (result.stoppedOnBudget) notes.push(result.stoppedOnBudget);
  if (result.failed) notes.push(`${result.failed} triage call(s) failed; \`jr failures\` lists them.`);
  return result.stoppedOnBudget || result.failed ? degraded(result, notes) : ok(result, notes);
}
