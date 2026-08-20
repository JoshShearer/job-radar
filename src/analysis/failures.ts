/**
 * Why did an analysis attempt fail?
 *
 * The reasons used to exist only as a `log.warn` line, so ten failures costing
 * roughly $0.46 could not be told apart: nobody could say whether they were
 * one bug ten times or ten different postings each hitting something else.
 *
 * Classifying rather than storing the raw string alone is what makes the
 * question answerable in aggregate - "how many were truncation?" is a GROUP BY,
 * not a read-through of ten error strings.
 */
export type AnalysisFailureKind =
  /** The response hit max_tokens and stopped mid-object, so the JSON is cut off. */
  | "truncated"
  /** Parsed as JSON but did not match the schema. */
  | "schema"
  /** Not JSON at all. */
  | "invalid_json"
  /** The model declined. */
  | "refusal"
  /** Network, auth, rate limit, or anything else the SDK raised. */
  | "api"
  | "unknown";

/**
 * Map an error to a kind.
 *
 * Ordered most specific first. `truncated` is checked before `invalid_json`
 * because a truncated response IS invalid JSON - it is the interesting reason
 * for it, and the one that points at a fixable setting rather than at a flaky
 * model.
 */
export function classifyAnalysisFailure(message: string): AnalysisFailureKind {
  const m = message.toLowerCase();
  if (m.includes("truncated") || m.includes("max_tokens")) return "truncated";
  // "declined" as well as "refus": the message the analyzer actually throws is
  // "Model declined to analyze this posting.", and a classifier that only knew
  // the word "refusal" filed every real refusal under "unknown". Caught by a
  // test written against the thrown string rather than against the intent.
  if (m.includes("refus") || m.includes("declined")) return "refusal";
  if (m.includes("failed schema validation")) return "schema";
  if (m.includes("not valid json") || m.includes("no text block")) return "invalid_json";
  // Matched against what the SDK actually throws, not against what an API
  // failure sounds like. A bad model name arrives as
  //   `404 {"type":"error","error":{"type":"not_found_error",...}}`
  // which contains neither "status code" nor any of the friendly words - so an
  // earlier version of this filed it under "unknown" and spent one of the
  // job's two attempts on it. Two runs with a typo in --model would have
  // parked good jobs. Found by running it, not by reading it.
  if (
    /^\s*\d{3}\b/.test(message) ||
    m.includes("_error") ||
    m.includes("status code") ||
    m.includes("rate limit") ||
    m.includes("timeout") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("overloaded") ||
    m.includes("authentication")
  ) {
    return "api";
  }
  return "unknown";
}

/**
 * Should this failure count against the job's attempt budget?
 *
 * An API failure is about the network or the account, not about this posting.
 * Counting it would park a perfectly analysable job because the connection
 * dropped twice, which is the opposite of the intent: the budget exists to
 * stop re-buying a failure that is DETERMINISTIC for a given posting.
 */
export function countsAgainstJob(kind: AnalysisFailureKind): boolean {
  return kind !== "api";
}
