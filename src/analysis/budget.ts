import type { CareerProfile } from "../config/schema.js";
import type { AnalyzeOptions } from "./analyzer.js";
import { parseNonNegativeFlag, parseNumericFlag } from "../lib/options.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "./analyzer.js";

/**
 * How one `analyze` pass is bounded: what it may look at, and what it may spend.
 *
 * This exists because the decision was written out twice, inline, in two
 * command bodies - and the two drifted. `analyze` resolved a spend ceiling from
 * the flag or the config; `daily --analyze` resolved none at all, so
 * `shouldStopForBudget` saw `undefined`, returned false on every check, and the
 * daily path ran UNCAPPED.
 *
 * That is the exact failure the ceiling was added for, in its worst form. The
 * ceiling exists because a fortnight came to $19.54 with the first feedback
 * arriving on a credit-card statement; the daily path is the one that runs
 * unattended on a timer, where nobody is watching at all.
 *
 * So it is one function, used by both, with tests. Which is the whole of
 * JOB-38: a decision about spending money does not belong in a command body,
 * because a command body is not somewhere a test can reach.
 */

export interface AnalyzeFlags {
  /** Raw `--limit`, or `--analyze-limit` on the daily path. */
  limit?: string;
  minFit?: string;
  model?: string;
  effort?: string;
  maxSpend?: string;
  includeEvergreen?: boolean;
  twoStage?: boolean;
  dryRun?: boolean;
}

export interface AnalyzeEnv {
  model?: string | undefined;
  effort?: string | undefined;
}

/**
 * Build the options for a pass.
 *
 * `defaultLimit` differs by entry point - 10 when a person typed `analyze`, 8
 * on the daily pass - so it is a parameter rather than a constant. Everything
 * else is identical by construction, which is the point.
 *
 * The spend ceiling ALWAYS resolves to a number. There is no code path here
 * that yields `undefined`, because `undefined` means "no ceiling" downstream
 * and no caller should be able to reach that state by omission. Removing the
 * ceiling deliberately is `--max-spend` with a very large number, which is a
 * thing someone had to type.
 */
export function resolveAnalyzeOptions(
  flags: AnalyzeFlags,
  profile: CareerProfile,
  env: AnalyzeEnv = {},
  defaultLimit = 10,
): AnalyzeOptions {
  return {
    limit: Number(flags.limit) || defaultLimit,
    // No config default. Selection is by rank; an absolute floor is an
    // explicit per-pass choice, not a standing setting nobody re-derives.
    minFit: parseNumericFlag(flags.minFit, "--min-fit"),
    model: flags.model ?? env.model ?? DEFAULT_MODEL,
    effort: flags.effort ?? env.effort ?? DEFAULT_EFFORT,
    // Parsed strictly, not with `|| default`. `Number("1.5O")` is NaN, NaN
    // fails every comparison, and `spent >= NaN` is false - so a mistyped
    // ceiling would remove the ceiling. See src/lib/options.ts.
    maxSpendUsd: parseNonNegativeFlag(flags.maxSpend, "--max-spend") ?? profile.scoring.max_spend_per_run_usd,
    includeEvergreen: flags.includeEvergreen ?? false,
    twoStage: flags.twoStage || undefined,
    dryRun: flags.dryRun ?? false,
  };
}
