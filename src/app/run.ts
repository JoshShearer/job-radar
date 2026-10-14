import type { AppContext } from "./context.js";
import type { UseCaseResult } from "../kernel/result.js";

/**
 * Run a use case inside a run record. The record is finalized in `finally`,
 * whether the use case returned ok, degraded or refused, or threw (sync or
 * async), so the run log tells the truth about every command.
 */
export async function withRun<T>(
  ctx: AppContext,
  command: string,
  fn: (runId: number) => Promise<UseCaseResult<T>> | UseCaseResult<T>,
): Promise<UseCaseResult<T>> {
  const runId = ctx.store.startRun(command, ctx.clock.now().toISOString());
  let result: UseCaseResult<T> | null = null;
  let error: unknown = null;
  try {
    result = await fn(runId);
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    const at = ctx.clock.now().toISOString();
    if (result) ctx.store.finishRun(runId, result.outcome, summarize(result), null, at);
    else ctx.store.finishRun(runId, "failed", null, error instanceof Error ? error.message : String(error), at);
  }
}

function summarize<T>(r: UseCaseResult<T>): unknown {
  return { notes: r.notes, value: r.value };
}
