import { log } from "./log.js";

/**
 * What a model call cost.
 *
 * This lived inside `src/analysis/analyzer.ts` under a comment reading "this is
 * the only place in the pipeline that costs money". That stopped being true the
 * moment `resume tailor` and `apply` started calling a model, and the comment
 * is probably why nobody wired those two up: `analyze` reported its spend down
 * to the cent while the two more expensive commands reported nothing at all.
 *
 * Measured on one real day: `analyze` logged $2.85 across 11 runs, while 61
 * `tailor` and `apply` runs logged no tokens and no cost whatsoever. The bill
 * was roughly $17. The invisible commands were the bill.
 *
 * So cost lives here, every command that spends uses it, and the number goes
 * into the run log where `stats` can find it later. A cost you cannot see is a
 * cost you cannot decide about.
 */

export interface TokenUsage {
  /** Uncached input tokens, billed at the full input rate. */
  input: number;
  /** Tokens written to the cache. Billed at a premium over plain input. */
  cacheWrite?: number;
  /** Tokens served from the cache. Billed at a large discount. */
  cacheRead?: number;
  /** Output tokens. Includes thinking tokens, which is why this dominates. */
  output: number;
}

/**
 * Published per-million-token rates. Unknown models fall back to Opus-tier so
 * an estimate errs high rather than low - a surprise under budget is fine, a
 * surprise over it is the thing being prevented.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cache writes cost more than plain input; cache reads cost far less. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** A usage envelope plus whether the provider actually reported one. */
export interface UsageReading {
  usage: TokenUsage;
  /**
   * True when the response carried no usable usage metadata.
   *
   * The call still happened and was still billed - this says the RECEIPT is
   * missing, not that the purchase was free.
   */
  missing: boolean;
}

/**
 * The one place a provider response is turned into a `TokenUsage`.
 *
 * Four call sites used to do this by hand, and three of them agreed on a
 * shape while `analyze` used a fourth - which is why no single query could
 * total tokens across the tool. That is the same shape of gap that let a $17
 * day record $0: a convention rather than a mechanism.
 *
 * IT DOES NOT THROW ON MISSING USAGE, and that restraint is load-bearing.
 * Throwing here would discard work already paid for and route into
 * `classifyAnalysisFailure`, where anything not classified `api` counts
 * against the job and consumes one of its two attempts. A provider reporting
 * quirk would then park a perfectly analysable job - inverting the purpose of
 * the attempt budget, which exists to stop re-buying DETERMINISTIC failures.
 *
 * So: keep the result, return zeros, and say so loudly.
 */
export function readUsage(response: unknown, where: string): UsageReading {
  const raw = (response as { usage?: Record<string, unknown> } | null)?.usage;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const input = num(raw?.["input_tokens"]);
  const output = num(raw?.["output_tokens"]);

  // Both absent means no receipt at all. One present is enough to record.
  if (input === null && output === null) {
    log.warn(
      `${where}: the response carried no usage metadata. The call was still billed; ` +
        `this run's token totals are short by one call.`,
    );
    return { usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, missing: true };
  }

  return {
    usage: {
      input: input ?? 0,
      cacheWrite: num(raw?.["cache_creation_input_tokens"]) ?? 0,
      cacheRead: num(raw?.["cache_read_input_tokens"]) ?? 0,
      output: output ?? 0,
    },
    missing: false,
  };
}

/** Add one usage envelope into a running total. */
export function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input: total.input + next.input,
    cacheWrite: (total.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    cacheRead: (total.cacheRead ?? 0) + (next.cacheRead ?? 0),
    output: total.output + next.output,
  };
}

/** A zeroed envelope, so an accumulator starts from one known shape. */
export function emptyUsage(): TokenUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

export function estimateCostUsd(usage: TokenUsage, model: string): number {
  const price = PRICING[model] ?? PRICING["claude-opus-5"]!;
  return (
    (usage.input / 1_000_000) * price.input +
    ((usage.cacheWrite ?? 0) / 1_000_000) * price.input * CACHE_WRITE_MULTIPLIER +
    ((usage.cacheRead ?? 0) / 1_000_000) * price.input * CACHE_READ_MULTIPLIER +
    (usage.output / 1_000_000) * price.output
  );
}

/**
 * One line a human can act on.
 *
 * Output is named separately because it is almost always the bill: an
 * application pack is ~6,000 tokens of generated document plus thinking, at
 * five times the input rate. Someone looking to spend less needs to see that
 * the lever is how much is generated, not how much is sent.
 */
export function describeSpend(usage: TokenUsage, model: string): string {
  const cost = estimateCostUsd(usage, model);
  const cached = usage.cacheRead ?? 0;
  return (
    `${usage.input} in${cached ? ` / ${cached} cached` : ""} / ${usage.output} out` +
    ` = ~$${cost.toFixed(3)} (${model})`
  );
}
