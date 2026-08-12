import type { JobSource, SourceContext, SourceJob } from "./types.js";
import { mapInterval, toIsoDate } from "./types.js";
import { log } from "../lib/log.js";

/**
 * Lever public postings API.
 *
 * Endpoint: https://api.lever.co/v0/postings/{token}?mode=json
 * Documented public endpoint backing Lever-hosted careers pages.
 *
 * Shape verified live: `text` is the title, location/commitment/team live under
 * `categories`, `createdAt` is epoch milliseconds, and the body is split across
 * `descriptionPlain` (intro) and `lists[]` (the requirement bullets) - dropping
 * `lists` would throw away most of the keyword signal, so we reassemble both.
 */
export interface LeverBoard {
  token: string;
  company: string;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: {
    commitment?: string;
    location?: string;
    team?: string;
    department?: string;
    allLocations?: string[];
  };
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  lists?: { text?: string; content?: string }[];
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  } | null;
}

export class LeverSource implements JobSource {
  readonly name = "lever";

  constructor(private readonly boards: LeverBoard[]) {}

  async fetch(ctx: SourceContext): Promise<SourceJob[]> {
    const out: SourceJob[] = [];

    for (const board of this.boards) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`;
      try {
        const data = await ctx.fetcher.getJson<LeverPosting[]>(url);
        const jobs = Array.isArray(data) ? data : [];
        log.debug(`lever:${board.token} -> ${jobs.length} jobs`);
        ctx.stats.bump("lever.boards_ok");
        ctx.stats.bump("lever.jobs_fetched", jobs.length);

        for (const j of jobs) {
          if (!j.id || !j.text) continue;
          const cats = j.categories ?? {};
          const location =
            cats.location ?? (cats.allLocations?.length ? cats.allLocations.join(", ") : "") ?? "";

          out.push({
            source: this.name,
            ats: "lever",
            externalId: `${board.token}:${j.id}`,
            sourceUrl: j.hostedUrl ?? `https://jobs.lever.co/${board.token}/${j.id}`,
            applicationUrl: j.applyUrl ?? j.hostedUrl ?? null,
            company: board.company,
            title: j.text.trim(),
            locationRaw: location,
            workplaceType: j.workplaceType ?? null,
            employmentTypeRaw: cats.commitment ?? null,
            datePosted: toIsoDate(j.createdAt),
            descriptionHtml: assembleBody(j),
            department: cats.department ?? cats.team ?? null,
            team: cats.team ?? null,
            salary: j.salaryRange
              ? {
                  min: j.salaryRange.min ?? null,
                  max: j.salaryRange.max ?? null,
                  currency: j.salaryRange.currency ?? "USD",
                  period: mapInterval(j.salaryRange.interval) ?? "year",
                }
              : null,
          });
        }
      } catch (err) {
        const detail = (err as Error).message;
        log.warn(`lever:${board.token} failed: ${detail}`);
        ctx.stats.fail(`lever:${board.token}`, detail);
        ctx.stats.bump("lever.boards_failed");
      }
    }

    return out;
  }
}

/**
 * Lever splits a posting across several fields. The requirement bullets that
 * carry the technology keywords live in `lists`, so a naive read of
 * `description` alone scores every Lever job far too low.
 */
function assembleBody(j: LeverPosting): string {
  const parts: string[] = [];
  if (j.description) parts.push(j.description);
  for (const list of j.lists ?? []) {
    if (list.text) parts.push(`<h3>${list.text}</h3>`);
    if (list.content) parts.push(`<ul>${list.content}</ul>`);
  }
  if (j.additional) parts.push(j.additional);
  return parts.join("\n");
}
