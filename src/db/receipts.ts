import type { JobRepo } from "./repo.js";
import { emptyUsage, estimateCostUsd, readUsage, type TokenUsage } from "../lib/cost.js";
import { classifyAnalysisFailure } from "../analysis/failures.js";

/**
 * JOB-52. Persist a receipt for every paid model attempt AT THE REQUEST SEAM -
 * the instant `client.messages.create()` / `.stream().finalMessage()` returns
 * - before any semantic validation (refusal / truncation / JSON-parse /
 * schema-validation) can throw and discard the fact that a billed call
 * happened.
 *
 * The bug this closes: every call site validated the response and THEN
 * recorded usage, so a response that failed validation - the exact case that
 * costs money and produces nothing - left no record it had ever been billed.
 * A run that threw after the API call still owes for that call.
 *
 * Structured as caller-supplied `request`/`validate` closures rather than a
 * a single do-everything function so each call site's existing checks (same
 * order, same thrown messages) move here verbatim instead of being
 * reimplemented against a new taxonomy.
 */
export interface ReceiptMeta {
  runId: number | null;
  jobId: string | null;
  purpose: string;
  model: string;
  tier: "triage" | "full" | null;
}

/**
 * `classifyAnalysisFailure` returns `'api'`; the receipts column is named
 * `validation_outcome` and also has to hold the literal `'api_error'` written
 * for the case where `request()` itself throws (no response, so nothing to
 * classify against `classifyAnalysisFailure`'s response-shaped vocabulary).
 * Renaming the one overlapping case here keeps both paths writing the same
 * word for "this was about the network or the account, not the response" -
 * one taxonomy, not two.
 */
function toValidationOutcome(message: string): string {
  const kind = classifyAnalysisFailure(message);
  return kind === "api" ? "api_error" : kind;
}

export async function callModelWithReceipt<T>(
  repo: JobRepo,
  meta: ReceiptMeta,
  request: () => Promise<unknown>,
  validate: (response: unknown) => T,
): Promise<{ result: T; usage: TokenUsage; usageMissing: boolean }> {
  let response: unknown;
  try {
    response = await request();
  } catch (err) {
    // No response exists, so there is nothing more to capture: usage unknown,
    // no price to estimate. The call was still billed - that fact is the
    // entire point of this row - so it is recorded before the rethrow, not
    // after.
    repo.recordModelReceipt({
      ...meta,
      usageKnown: false,
      usage: emptyUsage(),
      validationOutcome: "api_error",
      estimatedPriceUsd: 0,
    });
    throw err;
  }

  // Usage is captured HERE, immediately, before `validate()` runs - so none of
  // the downstream throw points (refusal, truncation, invalid JSON, schema)
  // can discard it. This is the mechanism the whole ticket is about.
  const reading = readUsage(response, `${meta.purpose} ${meta.jobId ?? "(no job)"} (${meta.tier ?? "n/a"})`);
  const estimatedPriceUsd = estimateCostUsd(reading.usage, meta.model);

  try {
    const result = validate(response);
    repo.recordModelReceipt({
      ...meta,
      usageKnown: !reading.missing,
      usage: reading.usage,
      validationOutcome: "success",
      estimatedPriceUsd,
    });
    return { result, usage: reading.usage, usageMissing: reading.missing };
  } catch (err) {
    repo.recordModelReceipt({
      ...meta,
      usageKnown: !reading.missing,
      usage: reading.usage,
      validationOutcome: toValidationOutcome((err as Error).message),
      estimatedPriceUsd,
    });
    throw err;
  }
}
