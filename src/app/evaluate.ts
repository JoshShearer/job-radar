import type { AppContext } from "./context.js";
import type { PostingSnapshot } from "../domain/catalog/posting.js";
import type { RankingRecord } from "../ports/records.js";
import { normalizePosting } from "../domain/catalog/normalize.js";
import type { RawPosting } from "../domain/catalog/posting.js";
import { deriveLifecycle, type PostingState } from "../domain/catalog/lifecycle.js";
import { assessEligibility, isEvergreen } from "../domain/evaluation/eligibility.js";
import { buildCompanyCounts, scorePosting, type DeterministicScore } from "../domain/evaluation/score.js";
import { calibrateWithLegacy, describeCalibration, type CalibrationPair } from "../domain/evaluation/calibration.js";
import { rankOne } from "../domain/evaluation/ranking.js";
import { foldPursuit, type PursuitState } from "../domain/pursuit/machines.js";
import { formatSalary } from "../domain/text/salary.js";
import { hashInput } from "../kernel/hash.js";
import { ok, type UseCaseResult } from "../kernel/result.js";
import { snapshotKey } from "./sweep.js";
import { assessmentRequests, candidateBrief, currentAssessment, DOSSIER_KIND, TRIAGE_KIND } from "./assessment-requests.js";
import type { Assessment } from "../domain/evaluation/assessment.js";

export interface EvaluationSummary {
  opportunities: number;
  eligible: number;
  assessed: number;
  staleAssessments: number;
  projected: number;
  byPriority: Record<string, number>;
  byPostingState: Record<string, number>;
  refusedBoards: Array<{ boardId: string; wouldClose: number; total: number }>;
  calibration: string;
  policyVersion: string;
}

export interface OpportunityView {
  id: string;
  /** The most recently seen alias's snapshot. */
  snapshot: PostingSnapshot;
  /** Every alias's snapshot, most recently seen first (one requisition, several cities). */
  variants: PostingSnapshot[];
  firstSeen: string;
  lastSeen: string;
  aliases: number;
}

/** Current snapshot per opportunity, from the alias memos (re-normalizing stale memos). */
export function currentOpportunities(ctx: AppContext): OpportunityView[] {
  const prefs = ctx.config().preferences;
  const memos: Array<{ boardId: string; externalId: string; key: string; json: string }> = [];
  const byOpp = new Map<string, { snapshot: PostingSnapshot; variants: Array<{ s: PostingSnapshot; seen: string }>; lastSeen: string; firstSeen: string; aliases: number }>();
  for (const a of ctx.store.allAliases()) {
    const key = snapshotKey(a.payloadHash, prefs);
    let snapshot: PostingSnapshot;
    if (a.snapshotKey === key && a.snapshotJson) snapshot = JSON.parse(a.snapshotJson) as PostingSnapshot;
    else {
      const body = ctx.store.blob(a.payloadHash);
      if (!body) continue;
      snapshot = normalizePosting(JSON.parse(body) as RawPosting, prefs);
      memos.push({ boardId: a.boardId, externalId: a.externalId, key, json: JSON.stringify(snapshot) });
    }
    const prior = byOpp.get(a.opportunityId);
    if (!prior) byOpp.set(a.opportunityId, { snapshot, variants: [{ s: snapshot, seen: a.lastSeen }], lastSeen: a.lastSeen, firstSeen: a.firstSeen, aliases: 1 });
    else {
      prior.aliases++;
      prior.variants.push({ s: snapshot, seen: a.lastSeen });
      if (a.firstSeen < prior.firstSeen) prior.firstSeen = a.firstSeen;
      if (a.lastSeen > prior.lastSeen) {
        prior.lastSeen = a.lastSeen;
        prior.snapshot = snapshot;
      }
    }
  }
  if (memos.length) ctx.store.saveSnapshotMemos(memos);
  return [...byOpp].map(([id, v]) => ({
    id,
    snapshot: v.snapshot,
    variants: v.variants.sort((a, b) => b.seen.localeCompare(a.seen)).map((x) => x.s),
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    aliases: v.aliases,
  }));
}

export function pursuitStates(ctx: AppContext): Map<string, { state: PursuitState; since: string | null }> {
  const events = ctx.store.pursuitEvents();
  const voids = ctx.store.voids("pursuit_event").map((v) => ({ id: v.id, voids: v.targetId }));
  const byOpp = new Map<string, typeof events>();
  for (const e of events) byOpp.set(e.opportunityId, [...(byOpp.get(e.opportunityId) ?? []), e]);
  const out = new Map<string, { state: PursuitState; since: string | null }>();
  for (const [id, list] of byOpp) {
    const f = foldPursuit(list, voids);
    out.set(id, { state: f.state, since: f.since });
  }
  return out;
}

export function policyVersion(ctx: AppContext): string {
  const c = ctx.config();
  return hashInput({ strategy: c.strategy, preferences: c.preferences, policy: c.policy }).slice(0, 12);
}

/**
 * Evaluate every opportunity and rebuild the ranking read model in one
 * transaction. Cheap and deterministic except for the assessment LOOKUP,
 * which only reads the derivation store: nothing here spends money.
 */
export function evaluate(ctx: AppContext, runId: number | null): UseCaseResult<EvaluationSummary> {
  const config = ctx.config();
  const now = ctx.clock.now();
  const opportunities = currentOpportunities(ctx);
  const lifecycle = deriveLifecycle(
    ctx.store.allAliases().map((a) => ({ opportunityId: a.opportunityId, boardId: a.boardId, lastSeen: a.lastSeen })),
    ctx.store.boardCoverage(),
    { parkAfterDays: config.policy.lifecycle.park_after_days, maxFractionPerBoard: config.policy.lifecycle.max_fraction_per_board },
  );
  const pursuits = pursuitStates(ctx);
  const companyCounts = buildCompanyCounts(
    opportunities.filter((o) => lifecycle.states.get(o.id) !== "closed").map((o) => o.snapshot.company),
  );
  const brief = candidateBrief(ctx);
  const everAssessed = new Set([...ctx.store.subjectsWithDerivation(TRIAGE_KIND), ...ctx.store.subjectsWithDerivation(DOSSIER_KIND)]);

  // Pass 1: deterministic score and the current assessment, if any.
  const scored = opportunities.map((o0) => {
    // One requisition posted in several places is ONE opportunity, judged on
    // its best variant: a role acceptable in one of its locations must not be
    // rejected because the alias seen last happened to be elsewhere.
    let chosen = o0.snapshot;
    let eligibility = assessEligibility(chosen, config.strategy, config.preferences, config.policy, now);
    for (const v of o0.variants) {
      if (eligibility.passed) break;
      const e = assessEligibility(v, config.strategy, config.preferences, config.policy, now);
      if (e.passed) {
        chosen = v;
        eligibility = e;
      }
    }
    const o = { ...o0, snapshot: chosen };
    const score = scorePosting(o.snapshot, config, eligibility, { companyJobCounts: companyCounts, now });
    let assessment: Assessment | null = null;
    if (brief && eligibility.passed) {
      assessment = currentAssessment(ctx, assessmentRequests(ctx, brief, o.snapshot, score, o.id, runId));
    }
    return { o, eligibility, score, assessment };
  });

  const pairs: CalibrationPair[] = scored
    .filter((s) => s.assessment && s.eligibility.passed)
    .map((s) => ({
      detFit: s.score.fit,
      llmFit: s.assessment!.verdict.fitScore,
      detRoi: s.score.roi,
      llmRoi: s.assessment!.verdict.applicationRoi,
    }));
  const legacyPairs: CalibrationPair[] = [];
  if (pairs.length < config.policy.calibration.min_sample) {
    for (const s of scored) {
      if (s.assessment || !s.eligibility.passed) continue;
      const v = legacyVerdict(ctx, s.o.id);
      if (v) legacyPairs.push({ detFit: s.score.fit, llmFit: v.fitScore, detRoi: s.score.roi, llmRoi: v.applicationRoi });
    }
  }
  const calibration = calibrateWithLegacy(pairs, legacyPairs, config.policy.calibration);

  // Pass 2: rank.
  const at = now.toISOString();
  const rows: RankingRecord[] = scored.map(({ o, eligibility, score, assessment }) => {
    const postingState: PostingState = lifecycle.states.get(o.id) ?? "unknown";
    const evergreen = isEvergreen(o.snapshot.datePosted, config.policy.scoring.evergreen_days, now);
    const r = rankOne({ opportunityId: o.id, eligibility, score, assessment, calibration, postingState, evergreen, policy: config.policy });
    return toRecord(o, r, score, eligibility, assessment, pursuits.get(o.id)?.state ?? "new", !assessment && everAssessed.has(o.id), at);
  });

  const summary: EvaluationSummary = {
    opportunities: rows.length,
    eligible: rows.filter((r) => r.eligible).length,
    assessed: rows.filter((r) => r.confidence === "analyzed").length,
    staleAssessments: rows.filter((r) => r.staleAssessment && r.eligible).length,
    projected: rows.filter((r) => r.confidence === "projected").length,
    byPriority: count(rows.filter((r) => r.eligible).map((r) => r.priority)),
    byPostingState: count(rows.map((r) => r.postingState)),
    refusedBoards: lifecycle.refusedBoards,
    calibration: describeCalibration(calibration, config.policy.calibration.min_sample),
    policyVersion: policyVersion(ctx),
  };
  ctx.store.replaceRanking(rows, { runId, at, policyVersion: summary.policyVersion, calibration, summary });
  ctx.store.recordConfigVersion("policy", summary.policyVersion, { strategy: config.strategy, preferences: config.preferences, policy: config.policy }, at);
  return ok(summary, lifecycle.refusedBoards.map((b) => `Refused to infer closures on ${b.boardId}: ${b.wouldClose} of ${b.total} postings vanished at once.`));
}

function toRecord(
  o: OpportunityView,
  r: ReturnType<typeof rankOne>,
  score: DeterministicScore,
  eligibility: ReturnType<typeof assessEligibility>,
  assessment: Assessment | null,
  pursuitState: PursuitState,
  stale: boolean,
  at: string,
): RankingRecord {
  const s = o.snapshot;
  return {
    opportunityId: o.id,
    company: s.company,
    title: s.title,
    location: s.location,
    remoteStatus: s.remoteStatus,
    datePosted: s.datePosted,
    lane: r.lane,
    eligible: r.eligible,
    evergreen: r.evergreen,
    postingState: r.postingState,
    pursuitState,
    rawFit: r.raw.fit,
    rawRoi: r.raw.roi,
    rawPriority: r.raw.priority,
    projFit: r.projected?.fit ?? null,
    projRoi: r.projected?.roi ?? null,
    analystFit: r.analyst?.fit ?? null,
    analystRoi: r.analyst?.roi ?? null,
    analystRec: r.analyst?.recommendation ?? null,
    analystTier: r.analyst?.tier ?? null,
    staleAssessment: stale,
    fit: r.fit,
    roi: r.roi,
    priority: r.priority,
    confidence: r.confidence,
    compBand: score.compensationBand,
    detail: {
      explanation: score.explanation,
      reasons: eligibility.reasons,
      warnings: eligibility.warnings,
      positiveSignals: score.positiveSignals,
      negativeSignals: score.negativeSignals,
      combos: score.combos,
      compensationNote: score.compensationNote,
      salary: formatSalary({
        min: s.salaryMin,
        max: s.salaryMax,
        currency: s.salaryCurrency,
        period: s.salaryPeriod,
        confidence: s.salaryMin != null ? "published" : "none",
        raw: null,
      }),
      url: s.sourceUrl,
      applicationUrl: s.applicationUrl,
      aliases: o.aliases,
      analystSummary: assessment?.verdict.reasoningSummary ?? null,
      rawLane: score.lane,
      variant: { boardId: s.boardId, externalId: s.externalId },
    },
    evaluatedAt: at,
  };
}

function count(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** The scores from an imported assessment, if this opportunity has one. Calibration input only. */
function legacyVerdict(ctx: AppContext, opportunityId: string): { fitScore: number; applicationRoi: number } | null {
  const d = ctx.store.getDerivation("assessment:legacy", `legacy:${opportunityId}`);
  const a = (d?.output as { analysis?: { fitScore?: unknown; applicationRoi?: unknown } } | undefined)?.analysis;
  if (!a || typeof a.fitScore !== "number" || typeof a.applicationRoi !== "number") return null;
  return { fitScore: a.fitScore, applicationRoi: a.applicationRoi };
}
