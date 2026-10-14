import type { AppContext } from "./context.js";
import type { RankingRecord, RunRecord, SweepRecord } from "../ports/records.js";
import type { Priority } from "../domain/evaluation/priority.js";
import { buildFunnel, type FunnelReport } from "../domain/pursuit/funnel.js";
import { nextAction, NUDGE_AFTER_DAYS } from "../domain/pursuit/machines.js";
import { silenceVerdict } from "../domain/outcomes/ghost.js";
import { DAY_MS, daysBetween } from "../kernel/clock.js";
import { applicationViews, type ApplicationView } from "./pursuit.js";
import { pursuitStates } from "./evaluate.js";
import { mailCoverageSpan } from "./mail.js";
import { spendSummary, type SpendSummary } from "./spend.js";

export interface HealthItem {
  level: "warn" | "info";
  text: string;
}

export interface Briefing {
  generatedAt: string;
  counts: { opportunities: number; eligible: number; assessed: number; open: number; closed: number };
  health: HealthItem[];
  slate: RankingRecord[];
  pursuing: Array<{ row: RankingRecord; state: string; days: number; action: string }>;
  applications: Array<ApplicationView & { days: number; action: string }>;
  silence: Array<{ app: ApplicationView; kind: "suggest_ghosted" | "unobserved"; days: number; why?: string }>;
  watchlist: Array<{ company: string; why: string }>;
  remoteOkAttribution: boolean;
  funnel: FunnelReport;
  spend: SpendSummary;
  calibration: string | null;
}

export function buildBriefing(ctx: AppContext): Briefing {
  const config = ctx.config();
  const now = ctx.clock.now();
  const all = ctx.store.ranking({});
  const eligible = all.filter((r) => r.eligible);
  const health: HealthItem[] = [];

  // --- observation health: silence must never pass for a quiet market -----
  const lastSweep = ctx.store.lastCompleteSweepAt();
  const sweepAge = lastSweep ? daysBetween(lastSweep, now) : null;
  if (sweepAge === null) health.push({ level: "warn", text: "No board has ever been swept completely. Run `jr sweep`." });
  else if (sweepAge > config.operations.sweep.stale_after_days) {
    health.push({ level: "warn", text: `Last complete sweep was ${Math.round(sweepAge)} days ago. Everything below is chosen from a stale index.` });
  }
  const failedBoards = ctx.store.latestSweeps().filter((s: SweepRecord) => s.status === "failed");
  if (failedBoards.length) {
    health.push({ level: "warn", text: `${failedBoards.length} board(s) failed their latest sweep: ${failedBoards.slice(0, 6).map((b) => b.boardId).join(", ")}${failedBoards.length > 6 ? ", ..." : ""}. Their postings are left as they were.` });
  }
  const failedRuns = ctx.store.recentRuns(new Date(now.getTime() - 3 * DAY_MS).toISOString()).filter((r: RunRecord) => r.outcome === "failed");
  for (const r of failedRuns.slice(0, 5)) health.push({ level: "warn", text: `\`${r.command}\` failed ${r.startedAt.slice(0, 16)}: ${r.error ?? "unknown error"}` });
  const evaluation = ctx.store.lastEvaluation();
  const summary = (evaluation?.summary ?? null) as { refusedBoards?: Array<{ boardId: string; wouldClose: number; total: number }>; staleAssessments?: number; calibration?: string } | null;
  for (const b of summary?.refusedBoards ?? []) {
    health.push({ level: "warn", text: `${b.boardId}: ${b.wouldClose} of ${b.total} postings vanished at once; treated as a bad response, not closures.` });
  }
  if (summary?.staleAssessments) {
    health.push({ level: "info", text: `${summary.staleAssessments} eligible posting(s) have an assessment formed against inputs that have since changed; they rank as unassessed until re-assessed.` });
  }

  const apps = applicationViews(ctx);
  const coverage = mailCoverageSpan(ctx);
  const activeApps = apps.filter((a) => !["rejected", "withdrawn", "offer"].includes(a.state));
  if (activeApps.length) {
    const lag = coverage ? daysBetween(coverage.to, now) : null;
    if (lag === null) health.push({ level: "warn", text: "Application mail has never been scanned, so the funnel below is UNOBSERVED, not silent. Run `jr mail scan`." });
    else if (lag > config.operations.mail.coverage_max_age_days) {
      health.push({ level: "warn", text: `Application mail was last scanned completely ${Math.round(lag)} days ago; recent outcomes may be missing.` });
    }
  }
  const spend = spendSummary(ctx);
  if (spend.month.committed > config.operations.budgets.per_month_usd * 0.8) {
    health.push({ level: "warn", text: `Model spend this month is $${spend.month.committed.toFixed(2)} of the $${config.operations.budgets.per_month_usd.toFixed(2)} budget.` });
  }

  // --- the slate -----------------------------------------------------------
  const caps: Record<Priority, number> = {
    A: config.policy.report.max_priority_a,
    B: config.policy.report.max_priority_b,
    C: config.policy.report.max_priority_c,
    D: 0,
  };
  const taken: Record<Priority, number> = { A: 0, B: 0, C: 0, D: 0 };
  const slate: RankingRecord[] = [];
  for (const r of eligible) {
    if (slate.length >= config.policy.report.max_total) break;
    if (r.pursuitState !== "new" && r.pursuitState !== "reviewed") continue;
    if (r.postingState === "closed" || r.postingState === "missing") continue;
    if (r.evergreen || r.fit < config.policy.scoring.report_threshold) continue;
    if (taken[r.priority] >= caps[r.priority]) continue;
    taken[r.priority]++;
    slate.push(r);
  }

  const pursuits = pursuitStates(ctx);
  const byId = new Map(all.map((r) => [r.opportunityId, r]));
  const pursuing = [...pursuits]
    .filter(([, p]) => p.state === "shortlisted" || p.state === "preparing")
    .map(([id, p]) => {
      const row = byId.get(id);
      const days = p.since ? Math.floor(daysBetween(p.since, now) ?? 0) : 0;
      return row ? { row, state: p.state, days, action: nextAction(p.state, days) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.days - a.days);

  const applications = activeApps
    .map((a) => {
      const days = Math.floor(daysBetween(a.since, now) ?? 0);
      return { ...a, days, action: nextAction(a.state, days) };
    })
    .sort((a, b) => b.days - a.days);

  const silence: Briefing["silence"] = [];
  for (const a of activeApps) {
    const v = silenceVerdict(
      { applicationId: a.id, company: a.company, title: a.title, state: a.state, lastContactAt: a.lastContactAt },
      coverage,
      { afterDays: config.operations.mail.ghost_after_days, maxCoverageAgeDays: config.operations.mail.coverage_max_age_days, now },
    );
    if (v.kind === "suggest_ghosted") silence.push({ app: a, kind: v.kind, days: v.days });
    else if (v.kind === "unobserved") silence.push({ app: a, kind: v.kind, days: v.days, why: v.why });
  }

  const funnel = buildFunnel({ discovered: all.length, eligible: eligible.length, furthest: apps.map((a) => a.furthest) });

  return {
    generatedAt: now.toISOString(),
    counts: {
      opportunities: all.length,
      eligible: eligible.length,
      assessed: all.filter((r) => r.confidence === "analyzed").length,
      open: all.filter((r) => r.postingState === "open").length,
      closed: all.filter((r) => r.postingState === "closed").length,
    },
    health,
    slate,
    pursuing,
    applications,
    silence,
    watchlist: config.sources.watchlist,
    remoteOkAttribution: config.sources.sources.remoteok.enabled,
    funnel,
    spend,
    calibration: summary?.calibration ?? null,
  };
}

export { NUDGE_AFTER_DAYS };
