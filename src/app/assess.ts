import type { AppContext } from "./context.js";
import { runSpend } from "./spend.js";
import type { RankingRecord } from "../ports/records.js";
import type { PostingSnapshot } from "../domain/catalog/posting.js";
import { earnsDossier, dossierReason, type Assessment } from "../domain/evaluation/assessment.js";
import { selectForAssessment, type CompanyHistory } from "../domain/evaluation/selection.js";
import { normalizeForIdentity } from "../domain/text/identity.js";
import { addressOf, BudgetRefusal, callModel, cached, ModelFailure, NoModelConfigured } from "./gateway.js";
import { assessmentRequests, candidateBrief, type AssessmentRequests } from "./assessment-requests.js";
import { evaluate } from "./evaluate.js";
import { degraded, ok, refused, type UseCaseResult } from "../kernel/result.js";

export interface AssessOptions {
  limit: number;
  /** Cover the whole eligible slate (implies two-stage). Spend still stops the pass. */
  slate?: boolean;
  twoStage?: boolean;
  includeEvergreen?: boolean;
  /** One-off absolute floor on the RAW keyword fit. Default: none (selection is by rank). */
  minFit?: number;
  maxSpendUsd?: number;
  dryRun?: boolean;
}

export interface AssessSummary {
  eligible: number;
  selected: number;
  fromCache: number;
  bought: number;
  dossiers: number;
  triageOnly: number;
  failed: number;
  failureKinds: Record<string, number>;
  spentUsd: number;
  stoppedOnBudget: string | null;
  wouldBuy: string[];
}

/**
 * The snapshot evaluation JUDGED for this opportunity (its chosen variant), so
 * every later step asks the model about exactly the posting that was ranked.
 */
export function snapshotFor(ctx: AppContext, opportunityId: string): PostingSnapshot | null {
  const aliases = ctx.store.aliasesFor(opportunityId);
  const v = ctx.store.rankingFor(opportunityId)?.detail.variant;
  const a = (v && aliases.find((x) => x.boardId === v.boardId && x.externalId === v.externalId)) ?? aliases[0];
  return a?.snapshotJson ? (JSON.parse(a.snapshotJson) as PostingSnapshot) : null;
}

export function requestsFor(ctx: AppContext, row: RankingRecord, brief: string, runId: number | null): AssessmentRequests | null {
  const snapshot = snapshotFor(ctx, row.opportunityId);
  if (!snapshot) return null;
  const note = {
    lane: row.detail.rawLane,
    compensationBand: row.compBand as never,
    compensationNote: row.detail.compensationNote,
    positiveSignals: row.detail.positiveSignals,
    negativeSignals: row.detail.negativeSignals,
  };
  return assessmentRequests(ctx, brief, snapshot, note, row.opportunityId, runId);
}

/**
 * Buy assessments for the best-ranked eligible postings. Spend is bounded
 * DIRECTLY: by `limit`, and by the gateway's per-call reservation against the
 * run, day and month budgets. There is no absolute keyword-score gate.
 * Re-evaluates at the end, so the ranking always reflects what was bought.
 */
export async function assess(ctx: AppContext, runId: number, opts: AssessOptions): Promise<UseCaseResult<AssessSummary>> {
  const config = ctx.config();
  const summary: AssessSummary = {
    eligible: 0,
    selected: 0,
    fromCache: 0,
    bought: 0,
    dossiers: 0,
    triageOnly: 0,
    failed: 0,
    failureKinds: {},
    spentUsd: 0,
    stoppedOnBudget: null,
    wouldBuy: [],
  };
  const brief = candidateBrief(ctx);
  if (!brief) return refused(summary, ["No evidence ledger. Run `jr evidence import <file>` or create config/candidate/evidence.yaml first."]);
  if (!opts.dryRun && !ctx.modelClient()) return refused(summary, [`${ctx.modelProvider().reason ?? "No model provider is configured."} Nothing was spent.`]);

  const twoStage = opts.slate || (opts.twoStage ?? config.policy.assessment.two_stage);
  const rows = ctx.store.ranking({
    eligible: true,
    pursuitStates: ["new", "reviewed", "shortlisted", "preparing"],
    postingStates: ["open", "unknown"],
    ...(opts.includeEvergreen ? {} : { includeEvergreen: false }),
  });

  // Needs a purchase: no current answer at the tier this pass is buying, and
  // attempts left at THIS input (a changed posting starts from zero).
  const needs: Array<{ row: RankingRecord; reqs: AssessmentRequests }> = [];
  for (const row of rows) {
    if (opts.minFit !== undefined && row.rawFit < opts.minFit) continue;
    const reqs = requestsFor(ctx, row, brief, runId);
    if (!reqs) continue;
    const have = cached(ctx, reqs.dossier) ?? (twoStage ? cached(ctx, reqs.triage) : null);
    if (have) continue;
    const failures = ctx.store.countedFailures(addressOf(twoStage ? reqs.triage : reqs.dossier));
    if (failures >= config.policy.assessment.max_attempts) continue;
    needs.push({ row, reqs });
  }
  summary.eligible = needs.length;

  const history = companyHistory(ctx.store.ranking({}));
  const limit = opts.slate ? Math.max(opts.limit, needs.length) : opts.limit;
  const picked = selectForAssessment(
    needs.map((n) => ({ opportunityId: n.row.opportunityId, company: normalizeForIdentity(n.row.company), roi: n.row.roi, fit: n.row.fit, datePosted: n.row.datePosted })),
    history,
    limit,
    config.policy.selection,
    ctx.clock.now(),
  );
  summary.selected = picked.length;
  const byId = new Map(needs.map((n) => [n.row.opportunityId, n]));

  if (opts.dryRun) {
    summary.wouldBuy = picked.map((p) => {
      const r = byId.get(p.opportunityId)!.row;
      return `${r.company} - ${r.title} (${p.opportunityId})`;
    });
    return ok(summary, [`Dry run: would assess ${picked.length} posting(s). Nothing was spent.`]);
  }

  for (const p of picked) {
    const { row, reqs } = byId.get(p.opportunityId)!;
    try {
      if (twoStage) {
        const t = await callModel(ctx, { ...reqs.triage, ...(opts.maxSpendUsd !== undefined ? { runCeilingUsd: opts.maxSpendUsd } : {}) });
        tally(summary, t);
        if (earnsDossier(t.value, config.policy.assessment)) {
          ctx.log(`  ${row.company} - ${row.title}: ${dossierReason(t.value, config.policy.assessment)}, buying the dossier`);
          const d = await callModel(ctx, { ...reqs.dossier, ...(opts.maxSpendUsd !== undefined ? { runCeilingUsd: opts.maxSpendUsd } : {}) });
          tally(summary, d);
          summary.dossiers++;
          ctx.log(`  -> fit ${d.value.fitScore}, ${d.value.recommendation}`);
        } else {
          summary.triageOnly++;
          ctx.log(`  ${row.company} - ${row.title}: ${dossierReason(t.value, config.policy.assessment)}`);
        }
      } else {
        const d = await callModel(ctx, { ...reqs.dossier, ...(opts.maxSpendUsd !== undefined ? { runCeilingUsd: opts.maxSpendUsd } : {}) });
        tally(summary, d);
        summary.dossiers++;
        ctx.log(`  ${row.company} - ${row.title} -> fit ${d.value.fitScore}, ${d.value.recommendation}`);
      }
    } catch (err) {
      if (err instanceof BudgetRefusal) {
        summary.stoppedOnBudget = err.message;
        ctx.log(`Stopped: ${err.message}`);
        break;
      }
      if (err instanceof NoModelConfigured) return refused(summary, [err.message]);
      if (err instanceof ModelFailure) {
        summary.failed++;
        summary.failureKinds[err.outcome] = (summary.failureKinds[err.outcome] ?? 0) + 1;
        ctx.store.recordAssessmentFailure(row.opportunityId, err.key, err.outcome, err.countsAgainstSubject, err.message, ctx.clock.now().toISOString());
        ctx.log(`  ${row.company} - ${row.title} failed [${err.outcome}]: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  evaluate(ctx, runId);
  // From the ledger, not a running sum of successes: a failed call is billed too.
  summary.spentUsd = runSpend(ctx, runId);
  const notes: string[] = [];
  if (summary.stoppedOnBudget) notes.push(summary.stoppedOnBudget);
  if (summary.failed) notes.push(`${summary.failed} assessment(s) failed; \`jr failures\` lists the reasons.`);
  return summary.stoppedOnBudget || summary.failed ? degraded(summary, notes) : ok(summary, notes);
}

function tally(s: AssessSummary, r: { fromCache: boolean }): void {
  if (r.fromCache) s.fromCache++;
  else {
    s.bought++;
  }
}

export function companyHistory(rows: readonly RankingRecord[]): Map<string, CompanyHistory> {
  const out = new Map<string, CompanyHistory>();
  for (const r of rows) {
    if (!r.analystRec) continue;
    const key = normalizeForIdentity(r.company);
    const h = out.get(key) ?? { assessed: 0, hits: 0 };
    h.assessed++;
    if (r.analystRec === "apply" || r.analystRec === "apply_and_outreach") h.hits++;
    out.set(key, h);
  }
  return out;
}

/**
 * Make sure a full dossier exists for one posting, buying it if needed. Called
 * at the moment the candidate acts on a posting (preparation), and only for an
 * endorsed one: buying a dossier for a posting the analyst said to skip is the
 * spend the endorsement gate exists to prevent.
 */
export async function ensureDossier(ctx: AppContext, runId: number, row: RankingRecord): Promise<{ assessment: Assessment | null; note: string }> {
  const brief = candidateBrief(ctx);
  if (!brief) return { assessment: null, note: "no evidence ledger" };
  const reqs = requestsFor(ctx, row, brief, runId);
  if (!reqs) return { assessment: null, note: "no snapshot for this posting" };
  const have = cached(ctx, reqs.dossier);
  if (have) return { assessment: { tier: "dossier", verdict: have.value }, note: "dossier already current" };
  try {
    const d = await callModel(ctx, reqs.dossier);
    return { assessment: { tier: "dossier", verdict: d.value }, note: d.fromCache ? "dossier from cache" : `dossier bought ($${d.costUsd.toFixed(4)})` };
  } catch (err) {
    if (err instanceof BudgetRefusal || err instanceof ModelFailure || err instanceof NoModelConfigured) {
      return { assessment: null, note: `could not fetch the dossier: ${err.message}` };
    }
    throw err;
  }
}
