import type { JobSource, SourceContext, SourceJob } from "./types.js";
import { toIsoDate } from "./types.js";
import { log } from "../lib/log.js";

/**
 * Remote OK public JSON feed.
 *
 * Endpoint: https://remoteok.com/api
 *
 * ATTRIBUTION IS A CONDITION OF USE. Remote OK's API terms (returned as the
 * first element of the feed itself) require any surface displaying these
 * listings to link back to https://remoteok.com with a followed link and to
 * name Remote OK as the source. The generated daily report does this; see
 * src/report/daily.ts. If you strip that attribution, disable this source in
 * config/sources.yaml rather than quietly violating the terms.
 *
 * The feed also injects an anti-scraping phrase into each description ("Please
 * mention the word X and tag Y when applying"). We strip it, because it is
 * their bot-detection instrumentation and not part of the job, and leaving it
 * in would pollute keyword scoring.
 */
interface RemoteOkEntry {
  legal?: string;
  id?: string | number;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  salary_min?: number;
  salary_max?: number;
}

const ANTI_SCRAPE_RE =
  /Please mention the word[\s\S]{0,400}?when applying to show you read the job post completely[\s\S]{0,200}?human\./gi;

export class RemoteOkSource implements JobSource {
  readonly name = "remoteok";

  async fetch(ctx: SourceContext): Promise<SourceJob[]> {
    const out: SourceJob[] = [];
    const url = "https://remoteok.com/api";

    try {
      const data = await ctx.fetcher.getJson<RemoteOkEntry[]>(url);
      const entries = Array.isArray(data) ? data : [];
      let skippedLegal = 0;

      for (const e of entries) {
        // The first element is the API terms notice, not a job.
        if (e.legal || !e.id || !e.position || !e.company) {
          skippedLegal++;
          continue;
        }

        out.push({
          source: this.name,
          board: this.name,
          ats: null,
          externalId: String(e.id),
          sourceUrl: e.url ?? `https://remoteok.com/remote-jobs/${e.slug ?? e.id}`,
          applicationUrl: e.apply_url ?? e.url ?? null,
          company: e.company.trim(),
          title: e.position.trim(),
          // Remote OK is a remote-only board; the `location` field is a
          // preference or timezone hint, not an onsite requirement.
          locationRaw: e.location?.trim() ? `Remote (${e.location.trim()})` : "Remote",
          isRemote: true,
          datePosted: toIsoDate(e.epoch ?? e.date),
          descriptionHtml: stripAntiScrape(e.description ?? ""),
          department: null,
          team: e.tags?.length ? e.tags.slice(0, 3).join(", ") : null,
          salary: normalizeSalary(e),
        });
      }

      log.debug(`remoteok -> ${out.length} jobs (${skippedLegal} non-job entries skipped)`);
      ctx.stats.bump("remoteok.jobs_fetched", out.length);
      ctx.stats.bump("remoteok.boards_ok");
      ctx.stats.sweep(this.name, this.name, true, out.length);
    } catch (err) {
      const detail = (err as Error).message;
      log.warn(`remoteok failed: ${detail}`);
      ctx.stats.fail("remoteok", detail);
      ctx.stats.bump("remoteok.boards_failed");
      ctx.stats.sweep(this.name, this.name, false, 0);
    }

    return out;
  }
}

function stripAntiScrape(html: string): string {
  return html.replace(ANTI_SCRAPE_RE, " ").replace(/\(#[A-Za-z0-9+/=]{8,}\)/g, " ");
}

/**
 * Remote OK reports salary as annual USD integers. Values are frequently
 * missing or nonsensical (0, or a placeholder), so apply the same plausibility
 * band the parser uses rather than trusting the field blindly.
 */
function normalizeSalary(e: RemoteOkEntry): SourceJob["salary"] {
  const min = typeof e.salary_min === "number" ? e.salary_min : null;
  const max = typeof e.salary_max === "number" ? e.salary_max : null;
  if (min == null && max == null) return null;
  const plausible = (v: number | null) => v == null || (v >= 30_000 && v <= 1_200_000);
  if (!plausible(min) || !plausible(max)) return null;
  if (min === 0 && max === 0) return null;
  return { min, max, currency: "USD", period: "year" };
}
