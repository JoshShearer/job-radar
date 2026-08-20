/**
 * Numeric parsing for CLI flags.
 *
 * Every other numeric option in `cli.ts` is written `Number(opts.x) || default`,
 * which quietly turns a typo into the default. That is survivable for `--limit`
 * and `--port`. It is not survivable for `--max-spend`, because the value it
 * guards is money and the failure is silent in the expensive direction:
 *
 *     --max-spend 1.5O        (letter O)   -> Number(...) is NaN
 *     shouldStopForBudget(0, NaN)          -> 0 >= NaN is false
 *     => the pass runs with no ceiling at all
 *
 * `NaN` fails every comparison, so a mistyped ceiling does not fall back to the
 * configured one - it removes the ceiling. Same class of defect as the config
 * coherence checks in `config/load.ts`: a typo that silently disables a limit is
 * worse than a crash, so this crashes.
 */

/**
 * Parse a required numeric flag, or throw naming the flag and what was passed.
 *
 * Returns `undefined` only when the flag was not supplied at all, so callers can
 * still fall back to a configured default with `??` - the distinction the
 * `||` idiom loses.
 */
export function parseNumericFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw == null) return undefined;
  // `Number("")` and `Number("  ")` are both 0, so an empty value would read as
  // a deliberate ceiling of zero rather than the mistake it is. Reject it
  // before the numeric conversion can launder it into a real number.
  if (raw.trim() === "") {
    throw new Error(`${flag} expects a number, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} expects a number, got "${raw}"`);
  }
  return value;
}

/**
 * As above, but also rejects negatives.
 *
 * A negative ceiling is not a smaller ceiling. `--max-spend -1` would stop the
 * pass before the first job while reading like a request to spend a little.
 */
export function parseNonNegativeFlag(raw: string | undefined, flag: string): number | undefined {
  const value = parseNumericFlag(raw, flag);
  if (value != null && value < 0) {
    throw new Error(`${flag} must not be negative, got "${raw}"`);
  }
  return value;
}
