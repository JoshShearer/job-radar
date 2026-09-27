import type { JobSource, SourceContext, SourceJob } from "./types.js";
import { mapInterval, toIsoDate } from "./types.js";
import { log } from "../lib/log.js";

/**
 * Ashby public job-board API.
 *
 * Endpoint: https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
 * Ashby's documented public posting API - no key required.
 *
 * Ashby is the best-structured of the three ATS sources: it gives us a plain
 * text description, an explicit remote flag, a workplace type, and real
 * compensation components. Where it publishes salary we use it directly and
 * never fall back to regex-parsing the prose.
 */
export interface AshbyBoard {
  token: string;
  company: string;
}

interface AshbyCompensationComponent {
  compensationType?: string;
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyJob {
  id: string;
  title: string;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null;
  location?: string | null;
  secondaryLocations?: { location?: string }[];
  publishedAt?: string | null;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string | null;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    summaryComponents?: AshbyCompensationComponent[];
    scrapeableCompensationSalarySummary?: string | null;
  } | null;
}

export class AshbySource implements JobSource {
  readonly name = "ashby";

  constructor(private readonly boards: AshbyBoard[]) {}

  async fetch(ctx: SourceContext): Promise<SourceJob[]> {
    const out: SourceJob[] = [];

    for (const board of this.boards) {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
        board.token,
      )}?includeCompensation=true`;
      try {
        const data = await ctx.fetcher.getJson<{ jobs?: AshbyJob[] }>(url);
        const jobs = data.jobs ?? [];
        log.debug(`ashby:${board.token} -> ${jobs.length} jobs`);
        ctx.stats.bump("ashby.boards_ok");
        ctx.stats.bump("ashby.jobs_fetched", jobs.length);
        ctx.stats.sweep(`${this.name}:${board.token}`, this.name, true, jobs.length);

        for (const j of jobs) {
          if (!j.id || !j.title) continue;
          if (j.isListed === false) continue;

          out.push({
            source: this.name,
            board: `${this.name}:${board.token}`,
            ats: "ashby",
            externalId: `${board.token}:${j.id}`,
            sourceUrl: j.jobUrl ?? `https://jobs.ashbyhq.com/${board.token}/${j.id}`,
            applicationUrl: j.applyUrl ?? j.jobUrl ?? null,
            company: board.company,
            title: j.title.trim(),
            locationRaw: buildLocation(j),
            workplaceType: j.workplaceType ?? null,
            isRemote: j.isRemote ?? null,
            employmentTypeRaw: j.employmentType ?? null,
            datePosted: toIsoDate(j.publishedAt),
            descriptionHtml: j.descriptionHtml ?? "",
            descriptionPlain: j.descriptionPlain ?? null,
            department: j.department ?? null,
            team: j.team ?? null,
            salary: extractSalary(j),
          });
        }
      } catch (err) {
        const detail = (err as Error).message;
        log.warn(`ashby:${board.token} failed: ${detail}`);
        ctx.stats.fail(`ashby:${board.token}`, detail);
        ctx.stats.bump("ashby.boards_failed");
        ctx.stats.sweep(`${this.name}:${board.token}`, this.name, false, 0);
      }
    }

    return out;
  }
}

/**
 * Combine primary and secondary locations. A job listed at "New York, NY (HQ)"
 * with a "Remote (US)" secondary location is genuinely remote-eligible, and
 * reading only the primary field would wrongly reject it.
 */
function buildLocation(j: AshbyJob): string {
  const parts = [j.location ?? ""];
  for (const s of j.secondaryLocations ?? []) {
    if (s.location) parts.push(s.location);
  }
  return parts.filter(Boolean).join(" | ");
}

/** Pull the Salary component out of Ashby's structured compensation block. */
function extractSalary(j: AshbyJob): SourceJob["salary"] {
  const components = j.compensation?.summaryComponents ?? [];
  const salary = components.find((c) => (c.compensationType ?? "").toLowerCase() === "salary");
  if (!salary || (salary.minValue == null && salary.maxValue == null)) return null;
  return {
    min: salary.minValue ?? null,
    max: salary.maxValue ?? null,
    currency: salary.currencyCode ?? "USD",
    period: mapInterval(salary.interval) ?? "year",
  };
}
