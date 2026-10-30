import type { AppContext } from "./context.js";
import type { ModelCallRecord } from "../ports/records.js";

/**
 * What the tool has spent, from ONE ledger: the model_call table. Every paid
 * attempt is there, including failures; a call with no usage receipt counts
 * at its reserved worst case, never as zero.
 */
export interface SpendWindow {
  committed: number;
  calls: number;
  unknownUsage: number;
  failed: number;
  /** Of the above, calls on the claude-cli provider: subscription quota, priced at list-price equivalent. */
  subscriptionCalls: number;
  subscriptionUsd: number;
}

/** How a claude-cli dollar figure is labelled wherever it is shown. */
export const SUBSCRIPTION_LABEL = "subscription, list-price equivalent";

export interface SpendSummary {
  day: SpendWindow;
  month: SpendWindow;
  byPurpose: Array<{ purpose: string; calls: number; usd: number }>;
  budgets: { perRun: number; perDay: number; perMonth: number };
}

function amount(c: ModelCallRecord): number {
  return c.status === "settled" && c.usageKnown ? (c.actualUsd ?? 0) : c.reservedUsd;
}

function window(calls: readonly ModelCallRecord[]): SpendWindow {
  return {
    committed: calls.reduce((s, c) => s + amount(c), 0),
    calls: calls.length,
    unknownUsage: calls.filter((c) => c.status !== "settled" || !c.usageKnown).length,
    failed: calls.filter((c) => c.outcome && c.outcome !== "success").length,
    subscriptionCalls: calls.filter((c) => c.provider === "claude-cli").length,
    subscriptionUsd: calls.filter((c) => c.provider === "claude-cli").reduce((s, c) => s + amount(c), 0),
  };
}

/** What one run has committed, from the ledger: failed attempts included, unknown usage at its worst case. */
export function runSpend(ctx: AppContext, runId: number): number {
  return window(ctx.store.modelCalls({ runId })).committed;
}

export function spendSummary(ctx: AppContext, days = 30): SpendSummary {
  const now = ctx.clock.now().toISOString();
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const monthStart = `${now.slice(0, 7)}-01T00:00:00.000Z`;
  const since = new Date(ctx.clock.now().getTime() - days * 86_400_000).toISOString();
  const recent = ctx.store.modelCalls({ sinceIso: since < monthStart ? since : monthStart });
  const byPurpose = new Map<string, { calls: number; usd: number }>();
  for (const c of recent.filter((c) => c.at >= since)) {
    const p = byPurpose.get(c.purpose) ?? { calls: 0, usd: 0 };
    p.calls++;
    p.usd += amount(c);
    byPurpose.set(c.purpose, p);
  }
  const b = ctx.config().operations.budgets;
  return {
    day: window(recent.filter((c) => c.at >= dayStart)),
    month: window(recent.filter((c) => c.at >= monthStart)),
    byPurpose: [...byPurpose].map(([purpose, v]) => ({ purpose, ...v })).sort((a, b2) => b2.usd - a.usd),
    budgets: { perRun: b.per_run_usd, perDay: b.per_day_usd, perMonth: b.per_month_usd },
  };
}

/** Total spent on one opportunity, across every purpose. */
export function spendFor(ctx: AppContext, opportunityId: string): { usd: number; calls: number; subscriptionCalls: number } {
  const calls = ctx.store.modelCalls({ subjectId: opportunityId });
  return { usd: calls.reduce((s, c) => s + amount(c), 0), calls: calls.length, subscriptionCalls: calls.filter((c) => c.provider === "claude-cli").length };
}

/** " (subscription, list-price equivalent)" when every call counted is on claude-cli; a share when some are. */
export function basisNote(w: { calls: number; subscriptionCalls: number }): string {
  if (w.subscriptionCalls === 0) return "";
  return w.subscriptionCalls === w.calls ? ` (${SUBSCRIPTION_LABEL})` : ` (${w.subscriptionCalls} of ${w.calls} calls: ${SUBSCRIPTION_LABEL})`;
}
