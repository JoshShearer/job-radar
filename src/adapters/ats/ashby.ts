import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { mapInterval, toIsoDate } from "./common.js";

/** Ashby public posting API: plain-text description and structured compensation. */
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
    summaryComponents?: Array<{ compensationType?: string; interval?: string; currencyCode?: string | null; minValue?: number | null; maxValue?: number | null }>;
  } | null;
}

export class AshbyAdapter implements SourceAdapter {
  readonly provider = "ashby";
  constructor(private readonly config: ReadonlyArray<{ token: string; company: string }>) {}

  boards(): BoardRef[] {
    return this.config.map((b) => ({ provider: this.provider, boardId: `ashby:${b.token}`, token: b.token, company: b.company }));
  }

  endpoint(board: BoardRef): string {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token ?? "")}?includeCompensation=true`;
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const data = await transport.getJson<{ jobs?: AshbyJob[] }>(this.endpoint(board));
    if (!data || !Array.isArray(data.jobs)) throw new Error("unexpected payload: no jobs array");
    return mapAshby(data.jobs, board);
  }
}

export function mapAshby(jobs: AshbyJob[], board: BoardRef): RawPosting[] {
  const out: RawPosting[] = [];
  for (const j of jobs) {
    if (!j.id || !j.title || j.isListed === false) continue;
    const comp = (j.compensation?.summaryComponents ?? []).find((c) => (c.compensationType ?? "").toLowerCase() === "salary");
    out.push({
      provider: "ashby",
      boardId: board.boardId,
      externalId: `${board.token}:${j.id}`,
      sourceUrl: j.jobUrl ?? `https://jobs.ashbyhq.com/${board.token}/${j.id}`,
      applicationUrl: j.applyUrl ?? j.jobUrl ?? null,
      company: board.company,
      title: j.title.trim(),
      locationRaw: [j.location ?? "", ...(j.secondaryLocations ?? []).map((s) => s.location ?? "")].filter(Boolean).join(" | "),
      workplaceType: j.workplaceType ?? null,
      isRemote: j.isRemote ?? null,
      employmentTypeRaw: j.employmentType ?? null,
      datePosted: toIsoDate(j.publishedAt),
      descriptionHtml: j.descriptionHtml ?? "",
      descriptionPlain: j.descriptionPlain ?? null,
      department: j.department ?? null,
      team: j.team ?? null,
      salary:
        comp && (comp.minValue != null || comp.maxValue != null)
          ? { min: comp.minValue ?? null, max: comp.maxValue ?? null, currency: comp.currencyCode ?? "USD", period: mapInterval(comp.interval) ?? "year" }
          : null,
    });
  }
  return out;
}
