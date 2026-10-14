/**
 * Deterministic salary parsing. No LLM involved - this is arithmetic and
 * pattern matching, and it must be reproducible and testable.
 *
 * The hard part is not finding numbers, it is *not* finding the wrong ones.
 * Job descriptions are full of dollar figures that are not compensation:
 * "401(k)", "$50B in payments processed", "$500 wellness stipend",
 * "10,000 customers". The parser therefore requires either an explicit
 * period cue (per year / annually / /hr) or a compensation context word
 * near the number, and rejects anything outside a plausible band.
 */

export type Period = "year" | "month" | "week" | "day" | "hour";

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string;
  period: Period | null;
  /** "published" = stated in the posting; "none" = nothing usable found. */
  confidence: "published" | "none";
  /** The matched substring, for auditing why a number was chosen. */
  raw: string | null;
}

export const NO_SALARY: ParsedSalary = {
  min: null,
  max: null,
  currency: "USD",
  period: null,
  confidence: "none",
  raw: null,
};

const PLAUSIBLE: Record<Period, [number, number]> = {
  year: [30_000, 1_200_000],
  month: [2_500, 100_000],
  week: [600, 25_000],
  day: [120, 5_000],
  hour: [15, 600],
};

/** Hours per year used for contract <-> salary comparison. */
export const WORK_HOURS_PER_YEAR = 2080;

const PERIOD_PER_YEAR: Record<Period, number> = {
  year: 1,
  month: 12,
  week: 52,
  day: 260,
  hour: WORK_HOURS_PER_YEAR,
};

/** Convert any period amount to its annual equivalent. */
export function annualize(amount: number, period: Period): number {
  return Math.round(amount * PERIOD_PER_YEAR[period]);
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "C$": "CAD",
  "A$": "AUD",
};

// Words that, when near a number, mark it as compensation.
const COMP_CONTEXT_SRC =
  "salary|salaries|compensation|base pay|base salary|pay range|pay band|salary range|annual|annually|per year|per annum|yearly|/ ?yr|/ ?year|per hour|hourly|/ ?hr|/ ?hour|an hour|per month|monthly|otc|on-target earnings|total cash";

// Words that mark a number as definitely NOT compensation.
const COMP_ANTICONTEXT_SRC =
  "401 ?\\(?k\\)?|stipend|reimburse|budget|revenue|arr\\b|raised|funding|valuation|series [a-e]\\b|customers|users|employees|match up to|donation|equity value|market cap|in sales|in payments|per month for|credits?";

interface NumberMatch {
  value: number;
  index: number;
  length: number;
  hadK: boolean;
  currency: string;
}

// $160,000 / $160k / 160,000 / USD 160000 / 160K
const NUMBER_RE =
  /(?:(C\$|A\$|US\$|\$|£|€|₹)\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k\b|m\b)?/gi;

function scanNumbers(text: string): NumberMatch[] {
  const out: NumberMatch[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const [full, sym, digits, suffix] = m;
    if (!digits) continue;
    const base = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;

    const suf = suffix?.toLowerCase();
    // "$2M" style figures are never an individual contributor's salary.
    if (suf === "m") continue;
    const hadK = suf === "k";
    const value = hadK ? base * 1000 : base;

    out.push({
      value,
      index: m.index,
      length: full.length,
      hadK,
      currency: sym ? (CURRENCY_SYMBOLS[sym.replace(/^US/, "")] ?? "USD") : "USD",
    });
  }
  return out;
}

/**
 * Distance from `pos` to the nearest match of `re` within `window`.
 * Returns null when the pattern does not appear.
 *
 * Proximity, not mere presence, is what makes a cue relevant. A posting that
 * says "$170,000-$210,000 per year. Contractors are paid $90 per hour."
 * contains both an annual and an hourly cue; only distance tells you which one
 * belongs to which number.
 */
function nearestCueDistance(window: string, pos: number, source: string): number | null {
  const re = new RegExp(source, "gi");
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    // Distance to the closest edge of the match, not its start.
    const start = m.index;
    const end = m.index + m[0].length;
    const d = pos < start ? start - pos : pos > end ? pos - end : 0;
    if (best === null || d < best) best = d;
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  return best;
}

const PERIOD_CUES: [Period, string][] = [
  ["hour", "per hour|hourly|/ ?hr\\b|/ ?hour|an hour|hourly rate"],
  ["day", "per day|daily|/ ?day|day rate"],
  ["week", "per week|weekly|/ ?wk|/ ?week"],
  ["month", "per month|monthly|/ ?mo\\b|/ ?month"],
  ["year", "per year|annually|annualized|per annum|yearly|/ ?yr\\b|/ ?year|annual"],
];

/**
 * Detect the pay period for the number at `pos` by picking the NEAREST period
 * cue, rather than by fixed precedence. Precedence order silently mislabels
 * every annual range that happens to mention an hourly contractor rate later
 * in the same paragraph.
 */
function detectPeriod(window: string, pos: number): Period | null {
  let best: { period: Period; distance: number } | null = null;
  for (const [period, source] of PERIOD_CUES) {
    const d = nearestCueDistance(window, pos, source);
    if (d == null) continue;
    if (best === null || d < best.distance) best = { period, distance: d };
  }
  return best?.period ?? null;
}

function inBand(value: number, period: Period): boolean {
  const band = PLAUSIBLE[period];
  return value >= band[0] && value <= band[1];
}

/**
 * Parse compensation out of free text.
 *
 * Strategy: find every number, then keep only those that sit inside a window
 * containing a compensation cue and no anti-cue, and whose magnitude is
 * plausible for the detected (or inferred) period.
 */
export function parseSalary(text: string | null | undefined): ParsedSalary {
  if (!text) return { ...NO_SALARY };
  const cleaned = text.replace(/\s+/g, " ");
  const numbers = scanNumbers(cleaned);
  if (numbers.length === 0) return { ...NO_SALARY };

  interface Candidate {
    value: number;
    period: Period;
    currency: string;
    index: number;
    raw: string;
  }
  const candidates: Candidate[] = [];

  for (const n of numbers) {
    const start = Math.max(0, n.index - 70);
    const end = Math.min(cleaned.length, n.index + n.length + 70);
    const window = cleaned.slice(start, end);
    const posInWindow = n.index - start;

    // Anti-context wins only when it is CLOSER than the compensation cue.
    // Testing for mere presence discards good numbers: "The salary range is
    // $165,000 to $195,000... We have over 3,000 employees" contains the
    // anti-cue "employees", but it is nowhere near the salary figure.
    const antiDistance = nearestCueDistance(window, posInWindow, COMP_ANTICONTEXT_SRC);
    const compDistance = nearestCueDistance(window, posInWindow, COMP_CONTEXT_SRC);
    if (antiDistance != null && (compDistance == null || antiDistance < compDistance)) continue;

    let period = detectPeriod(window, posInWindow);
    if (!period) {
      if (compDistance == null) continue;
      // No explicit period. Infer from magnitude: a "k" suffix or a
      // five-to-six-figure number next to salary language means annual;
      // a two-to-three-figure number means hourly.
      if (n.hadK || n.value >= 20_000) period = "year";
      else if (n.value >= 15 && n.value <= 600) period = "hour";
      else continue;
    }

    if (!inBand(n.value, period)) continue;

    candidates.push({
      value: n.value,
      period,
      currency: n.currency,
      index: n.index,
      raw: cleaned.slice(start, end).trim(),
    });
  }

  if (candidates.length === 0) return { ...NO_SALARY };

  // Prefer the dominant period among candidates (posts often mention an
  // hourly contractor rate in passing alongside an annual band).
  const periodCounts = new Map<Period, number>();
  for (const c of candidates) periodCounts.set(c.period, (periodCounts.get(c.period) ?? 0) + 1);
  let dominant: Period = candidates[0]!.period;
  let best = -1;
  for (const [p, count] of periodCounts) {
    // Tie-break toward annual, which is what we mostly care about.
    const weighted = count * (p === "year" ? 1.5 : 1);
    if (weighted > best) {
      best = weighted;
      dominant = p;
    }
  }

  const inPeriod = candidates.filter((c) => c.period === dominant);
  const values = inPeriod.map((c) => c.value).sort((a, b) => a - b);
  const min = values[0]!;
  const max = values[values.length - 1]!;

  return {
    min,
    max: max === min ? null : max,
    currency: inPeriod[0]!.currency,
    period: dominant,
    confidence: "published",
    raw: inPeriod[0]!.raw.slice(0, 220),
  };
}

/**
 * Merge structured salary fields provided directly by an ATS with anything
 * parsed from the description. Structured data always wins.
 */
export function mergeSalary(structured: Partial<ParsedSalary>, parsed: ParsedSalary): ParsedSalary {
  if (structured.min != null || structured.max != null) {
    const period = structured.period ?? "year";
    const min = structured.min ?? null;
    const max = structured.max ?? null;
    // Reject structured values that are implausible for their stated period -
    // some boards put equity or bonus numbers in the salary field.
    const okMin = min == null || inBand(min, period);
    const okMax = max == null || inBand(max, period);
    if (okMin && okMax) {
      return {
        min,
        max,
        currency: structured.currency ?? "USD",
        period,
        confidence: "published",
        raw: structured.raw ?? null,
      };
    }
  }
  return parsed;
}

export type CompBand = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

export interface CompAssessment {
  band: CompBand;
  /** Annualized figures used for the comparison, for auditability. */
  annualMin: number | null;
  annualMax: number | null;
  reason: string;
}

export interface CompTargets {
  targetMin: number;
  targetMax: number;
  acceptableMin: number;
  rejectBelowMax: number;
  stretchMin: number;
}

/**
 * Classify compensation against the career profile.
 *
 * UNKNOWN is a first-class outcome, never a rejection: most of the best small
 * companies do not publish a range, and a role can still be worth pursuing.
 */
export function assessCompensation(salary: ParsedSalary, t: CompTargets): CompAssessment {
  if (salary.confidence === "none" || salary.period == null || salary.min == null) {
    return {
      band: "UNKNOWN",
      annualMin: null,
      annualMax: null,
      reason: "No compensation published. Estimate from company stage and level; ask for their range first.",
    };
  }

  const period = salary.period;
  const annualMin = annualize(salary.min, period);
  const annualMax = salary.max != null ? annualize(salary.max, period) : null;
  const top = annualMax ?? annualMin;
  const note =
    period === "hour"
      ? ` (${fmtMoney(salary.min)}${salary.max ? `-${fmtMoney(salary.max)}` : ""}/hr annualized at ${WORK_HOURS_PER_YEAR}h)`
      : "";

  if (top >= t.stretchMin) {
    return {
      band: "GREEN",
      annualMin,
      annualMax,
      reason: `Top of range ${fmtMoney(top)} reaches the stretch band${note}.`,
    };
  }
  if (top >= t.targetMin) {
    return {
      band: "GREEN",
      annualMin,
      annualMax,
      reason: `Range top ${fmtMoney(top)} meets the ${fmtMoney(t.targetMin)}-${fmtMoney(t.targetMax)} target${note}.`,
    };
  }
  if (top >= t.acceptableMin) {
    return {
      band: "YELLOW",
      annualMin,
      annualMax,
      reason: `Range top ${fmtMoney(top)} lands between acceptable (${fmtMoney(t.acceptableMin)}) and target (${fmtMoney(t.targetMin)})${note}. Total package or equity could close the gap.`,
    };
  }
  if (top >= t.rejectBelowMax) {
    return {
      band: "YELLOW",
      annualMin,
      annualMax,
      reason: `Range top ${fmtMoney(top)} is below the acceptable floor of ${fmtMoney(t.acceptableMin)}${note}. Only worth it for exceptional role quality.`,
    };
  }
  return {
    band: "RED",
    annualMin,
    annualMax,
    reason: `Range top ${fmtMoney(top)} is below the hard floor of ${fmtMoney(t.rejectBelowMax)}${note}.`,
  };
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "n/a";
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}

export function formatSalary(s: ParsedSalary): string {
  if (s.confidence === "none" || s.min == null) return "not published";
  const unit = s.period === "hour" ? "/hr" : s.period === "year" ? "" : `/${s.period}`;
  const lo = s.period === "hour" ? `$${s.min}` : fmtMoney(s.min);
  if (s.max == null) return `${lo}${unit}`;
  const hi = s.period === "hour" ? `$${s.max}` : fmtMoney(s.max);
  return `${lo}-${hi}${unit}`;
}
