import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { detailOrFail, requireDescription, toIsoDate } from "./common.js";

/**
 * Workable public widget API. Two calls: the account list carries no
 * description, so every listed posting's detail is fetched as well (ADR-0003).
 * The detail path is `accounts/`, not `widget/accounts/` (that one is a 404).
 */
interface WorkableLocation {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  hidden?: boolean;
}

interface WorkableListJob {
  title?: string;
  shortcode?: string;
  employment_type?: string | null;
  telecommuting?: boolean | null;
  department?: string | null;
  url?: string | null;
  application_url?: string | null;
  published_on?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  locations?: WorkableLocation[];
}

interface WorkableDetail {
  shortcode?: string;
  title?: string;
  remote?: boolean | null;
  workplace?: string | null;
  location?: WorkableLocation | null;
  locations?: WorkableLocation[];
  published?: string | null;
  department?: string[] | string | null;
  description?: string | null;
  requirements?: string | null;
  benefits?: string | null;
}

export class WorkableAdapter implements SourceAdapter {
  readonly provider = "workable";
  constructor(private readonly config: ReadonlyArray<{ token: string; company: string }>) {}

  boards(): BoardRef[] {
    return this.config.map((b) => ({ provider: this.provider, boardId: `workable:${b.token}`, token: b.token, company: b.company }));
  }

  endpoint(board: BoardRef): string {
    return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board.token ?? "")}`;
  }

  detailUrl(board: BoardRef, shortcode: string): string {
    return `https://apply.workable.com/api/v1/accounts/${encodeURIComponent(board.token ?? "")}/jobs/${encodeURIComponent(shortcode)}`;
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const data = await transport.getJson<{ jobs?: WorkableListJob[] }>(this.endpoint(board));
    if (!data || !Array.isArray(data.jobs)) throw new Error("unexpected payload: no jobs array");
    const out: RawPosting[] = [];
    const seen = new Set<string>();
    // Sequential on purpose: one host, and the transport's floor is per host anyway.
    for (const job of data.jobs) {
      if (!job.shortcode || !job.title) continue;
      // The list repeats a multi-location posting once per location under one
      // shortcode; the detail carries every location, so fetch it once.
      if (seen.has(job.shortcode)) continue;
      seen.add(job.shortcode);
      const detail = await detailOrFail<WorkableDetail>(transport, this.detailUrl(board, job.shortcode), job.shortcode);
      out.push(mapWorkable(job, detail, board));
    }
    return out;
  }
}

export function mapWorkable(job: WorkableListJob, detail: WorkableDetail, board: BoardRef): RawPosting {
  const shortcode = job.shortcode!;
  const parts = [detail.description, detail.requirements, detail.benefits].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  const locations = (detail.locations?.length ? detail.locations : job.locations ?? []).filter((l) => !l.hidden);
  const locationRaw = locations.length
    ? locations.map(formatLocation).filter(Boolean).join(" | ")
    : formatLocation(detail.location ?? { city: job.city, region: job.state, country: job.country });
  const dept = Array.isArray(detail.department) ? detail.department[0] : detail.department;
  return {
    provider: "workable",
    boardId: board.boardId,
    externalId: `${board.token}:${shortcode}`,
    sourceUrl: job.url ?? `https://apply.workable.com/${board.token}/j/${shortcode}/`,
    applicationUrl: job.application_url ?? job.url ?? null,
    company: board.company,
    title: (detail.title ?? job.title!).trim(),
    locationRaw,
    workplaceType: detail.workplace ?? null,
    isRemote: detail.remote ?? job.telecommuting ?? null,
    employmentTypeRaw: job.employment_type ?? null,
    datePosted: toIsoDate(detail.published ?? job.published_on),
    descriptionHtml: requireDescription(parts.join("\n"), shortcode),
    department: job.department ?? dept ?? null,
    team: null,
    salary: null,
  };
}

function formatLocation(l: WorkableLocation): string {
  return [l.city, l.region, l.country].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(", ");
}
