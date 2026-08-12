import type { Period } from "../lib/salary.js";
import type { PoliteFetcher } from "../lib/http.js";
import type { RunStats } from "../lib/log.js";

/**
 * What a source adapter emits. Adapters are deliberately dumb: they map a
 * provider payload onto these fields and do no classification. Everything
 * judgemental - remote status, seniority, salary inference - happens once, in
 * the normalization step, so all sources are treated identically.
 */
export interface SourceJob {
  source: string;
  ats: string | null;
  externalId: string;
  sourceUrl: string;
  applicationUrl: string | null;
  company: string;
  title: string;
  locationRaw: string;
  /** Structured hints from the provider, when it offers them. */
  workplaceType?: string | null;
  isRemote?: boolean | null;
  employmentTypeRaw?: string | null;
  datePosted: string | null;
  /** Description as provided. May be HTML, may be plain text. */
  descriptionHtml: string;
  /** Plain-text description when the provider supplies one directly. */
  descriptionPlain?: string | null;
  department?: string | null;
  team?: string | null;
  /** Structured compensation, when the provider publishes it. */
  salary?: {
    min?: number | null;
    max?: number | null;
    currency?: string;
    period?: Period | null;
  } | null;
}

export interface SourceContext {
  fetcher: PoliteFetcher;
  stats: RunStats;
}

export interface JobSource {
  readonly name: string;
  /**
   * Fetch all currently-listed jobs. Must not throw for a single bad board:
   * record the failure on ctx.stats and keep going, so one dead source cannot
   * take down the run.
   */
  fetch(ctx: SourceContext): Promise<SourceJob[]>;
}

/** Map provider interval strings ("1 YEAR", "HOURLY") onto our Period type. */
export function mapInterval(interval: string | null | undefined): Period | null {
  if (!interval) return null;
  const i = interval.toUpperCase();
  if (i.includes("YEAR") || i === "ANNUAL" || i === "ANNUALLY") return "year";
  if (i.includes("MONTH")) return "month";
  if (i.includes("WEEK")) return "week";
  if (i.includes("DAY")) return "day";
  if (i.includes("HOUR")) return "hour";
  return null;
}

/** Parse whatever date shape a provider gives us into ISO8601, or null. */
export function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    // Epoch seconds vs milliseconds: anything under ~1e11 is seconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
