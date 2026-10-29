/**
 * Published per-million-token rates (USD). An unknown model is priced at the
 * most expensive known tier, so an estimate errs high: a surprise under budget
 * is fine, a surprise over it is what budgets exist to prevent.
 */
export const PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-5-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-5-5": { input: 1, output: 5 },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

export function priceFor(model: string): { input: number; output: number } {
  return PRICING[model] ?? { input: 5, output: 25 };
}

export function costUsd(u: TokenUsage, model: string): number {
  const p = priceFor(model);
  return (
    (u.input * p.input + u.cacheWrite * p.input * CACHE_WRITE_MULTIPLIER + u.cacheRead * p.input * CACHE_READ_MULTIPLIER + u.output * p.output) /
    1_000_000
  );
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output };
}

/**
 * The most a call can cost: every 3 input BYTES as an uncached token (a
 * deliberate overestimate for Latin text that still bounds CJK) plus the full output
 * ceiling. Reserved before the call so a ceiling is a ceiling, not a
 * stop-after-the-fact threshold.
 *
 * `turns` and `overheadInputTokens` are for a provider that may make several
 * API calls for one request (the claude CLI retries internally) and adds input
 * of its own to each. Omitted, the formula is the single-call one.
 */
export function worstCaseUsd(
  inputBytes: number,
  maxOutputTokens: number,
  model: string,
  multi: { turns?: number; overheadInputTokens?: number } = {},
): number {
  const inputTokens = Math.ceil(inputBytes / 3) + (multi.overheadInputTokens ?? 0);
  return (multi.turns ?? 1) * costUsd({ input: inputTokens, cacheWrite: 0, cacheRead: 0, output: maxOutputTokens }, model);
}

/** Read the provider's usage block. Missing usage is reported, never invented as zero. */
export function readUsage(response: unknown): { usage: TokenUsage; known: boolean } {
  const raw = (response as { usage?: Record<string, unknown> } | null)?.usage;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const input = num(raw?.input_tokens);
  const output = num(raw?.output_tokens);
  if (input === null || output === null) return { usage: EMPTY_USAGE, known: false };
  return {
    usage: {
      input,
      output,
      cacheWrite: num(raw?.cache_creation_input_tokens) ?? 0,
      cacheRead: num(raw?.cache_read_input_tokens) ?? 0,
    },
    known: true,
  };
}
