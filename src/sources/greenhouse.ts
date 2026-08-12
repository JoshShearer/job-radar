import type { JobSource, SourceContext, SourceJob } from "./types.js";
import { toIsoDate } from "./types.js";
import { log } from "../lib/log.js";

/**
 * Greenhouse public job-board API.
 *
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * This is Greenhouse's documented public board endpoint - no key, no auth, and
 * it is the same data the company's own careers page renders.
 *
 * Quirk verified against live payloads: `content` is HTML that has been
 * entity-escaped twice ("&amp;lt;p&amp;gt;"), which is why htmlToText decodes
 * repeatedly before stripping tags.
 */
export interface GreenhouseBoard {
  token: string;
  company: string;
}

interface GhJob {
  id: number;
  internal_job_id?: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  content?: string;
  company_name?: string;
  location?: { name?: string } | null;
  offices?: { name?: string; location?: string }[];
  departments?: { name?: string }[];
  metadata?: { name?: string; value?: unknown }[];
}

export class GreenhouseSource implements JobSource {
  readonly name = "greenhouse";

  constructor(private readonly boards: GreenhouseBoard[]) {}

  async fetch(ctx: SourceContext): Promise<SourceJob[]> {
    const out: SourceJob[] = [];

    for (const board of this.boards) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`;
      try {
        const data = await ctx.fetcher.getJson<{ jobs?: GhJob[] }>(url);
        const jobs = data.jobs ?? [];
        log.debug(`greenhouse:${board.token} -> ${jobs.length} jobs`);
        ctx.stats.bump("greenhouse.boards_ok");
        ctx.stats.bump("greenhouse.jobs_fetched", jobs.length);

        for (const j of jobs) {
          if (!j.id || !j.title) continue;
          out.push({
            source: this.name,
            ats: "greenhouse",
            externalId: `${board.token}:${j.id}`,
            sourceUrl: j.absolute_url,
            applicationUrl: j.absolute_url,
            company: j.company_name?.trim() || board.company,
            title: j.title.trim(),
            locationRaw: j.location?.name ?? j.offices?.[0]?.name ?? "",
            employmentTypeRaw: pickMetadata(j.metadata, ["employment type", "job type"]),
            datePosted: toIsoDate(j.first_published ?? j.updated_at),
            descriptionHtml: j.content ?? "",
            department: j.departments?.[0]?.name ?? null,
            team: j.departments?.[1]?.name ?? null,
            salary: null,
          });
        }
      } catch (err) {
        const detail = (err as Error).message;
        log.warn(`greenhouse:${board.token} failed: ${detail}`);
        ctx.stats.fail(`greenhouse:${board.token}`, detail);
        ctx.stats.bump("greenhouse.boards_failed");
      }
    }

    return out;
  }
}

/** Greenhouse boards expose arbitrary key/value metadata; pull a named field. */
function pickMetadata(
  metadata: { name?: string; value?: unknown }[] | undefined,
  names: string[],
): string | null {
  if (!metadata) return null;
  for (const entry of metadata) {
    const n = (entry.name ?? "").toLowerCase();
    if (names.some((want) => n.includes(want))) {
      const v = entry.value;
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    }
  }
  return null;
}
