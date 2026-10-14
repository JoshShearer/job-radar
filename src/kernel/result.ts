/**
 * What every use case returns. A refusal is not a failure and a degraded run is
 * not a success; the run log records which one happened.
 */
export type Outcome = "ok" | "degraded" | "refused" | "failed";

export interface UseCaseResult<T> {
  outcome: Outcome;
  value: T;
  /** Human-readable lines explaining a refusal or degradation. */
  notes: string[];
}

export function ok<T>(value: T, notes: string[] = []): UseCaseResult<T> {
  return { outcome: "ok", value, notes };
}

export function degraded<T>(value: T, notes: string[]): UseCaseResult<T> {
  return { outcome: "degraded", value, notes };
}

export function refused<T>(value: T, notes: string[]): UseCaseResult<T> {
  return { outcome: "refused", value, notes };
}

/** Thrown when a caller asks for something that does not exist or is malformed. */
export class UserError extends Error {
  override name = "UserError";
}
