import type { Operations } from "../config/schema.js";

/**
 * Spend committed in a window: settled actual cost plus every reservation not
 * yet settled (including reservations orphaned by a crash, counted at their
 * reserved worst case until reconciled).
 */
export interface Committed {
  run: number;
  day: number;
  month: number;
}

export type BudgetDecision = { ok: true } | { ok: false; window: "run" | "day" | "month"; ceiling: number; committed: number };

export function checkBudget(committed: Committed, reserve: number, budgets: Operations["budgets"], runCeiling?: number): BudgetDecision {
  const runLimit = runCeiling ?? budgets.per_run_usd;
  if (committed.run + reserve > runLimit) return { ok: false, window: "run", ceiling: runLimit, committed: committed.run };
  if (committed.day + reserve > budgets.per_day_usd) return { ok: false, window: "day", ceiling: budgets.per_day_usd, committed: committed.day };
  if (committed.month + reserve > budgets.per_month_usd) return { ok: false, window: "month", ceiling: budgets.per_month_usd, committed: committed.month };
  return { ok: true };
}

export function describeRefusal(d: Exclude<BudgetDecision, { ok: true }>, reserve: number): string {
  return (
    `Budget: the ${d.window} ceiling is $${d.ceiling.toFixed(2)}, $${d.committed.toFixed(4)} is already committed, ` +
    `and this call could cost up to $${reserve.toFixed(4)}. Nothing was spent.`
  );
}
