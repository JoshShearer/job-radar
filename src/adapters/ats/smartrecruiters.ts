import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { detailOrFail, requireDescription, toIsoDate } from "./common.js";

/**
 * SmartRecruiters public Posting API. The list is paged and carries no
 * description, so every listed posting's detail is fetched as well
 * (ADR-0003). An unknown company answers 200 with `totalFound: 0`, which is
 * indistinguishable from a company with no openings: it maps to an empty board.
 */
const PAGE_SIZE = 100;

interface SrLabel {
  id?: string | number;
  label?: string | null;
}

interface SrListPosting {
  id?: string;
  name?: string;
  releasedDate?: string | null;
  location?: SrLocation | null;
  department?: SrLabel | null;
  typeOfEmployment?: SrLabel | null;
}

interface SrLocation {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  fullLocation?: string | null;
  remote?: boolean | null;
  hybrid?: boolean | null;
}

interface SrSection {
  title?: string | null;
  text?: string | null;
}

interface SrDetail extends SrListPosting {
  postingUrl?: string | null;
  applyUrl?: string | null;
  active?: boolean;
  jobAd?: { sections?: Record<string, SrSection | undefined> | null } | null;
}

interface SrPage {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: SrListPosting[];
}

/** The job ad sections, in the order the provider renders them. */
const SECTIONS = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"] as const;

export class SmartRecruitersAdapter implements SourceAdapter {
  readonly provider = "smartrecruiters";
  constructor(private readonly config: ReadonlyArray<{ token: string; company: string }>) {}

  boards(): BoardRef[] {
    return this.config.map((b) => ({ provider: this.provider, boardId: `smartrecruiters:${b.token}`, token: b.token, company: b.company }));
  }

  private base(board: BoardRef): string {
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.token ?? "")}/postings`;
  }

  /** The first list page. Note an unknown company is a 200 here too, so a health check cannot catch a typo'd identifier. */
  endpoint(board: BoardRef): string {
    return this.pageUrl(board, 0);
  }

  pageUrl(board: BoardRef, offset: number): string {
    return `${this.base(board)}?limit=${PAGE_SIZE}&offset=${offset}`;
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const listed = await this.listAll(board, transport);
    const out: RawPosting[] = [];
    for (const p of listed) {
      const detail = await detailOrFail<SrDetail>(transport, `${this.base(board)}/${encodeURIComponent(p.id!)}`, p.id!);
      if (detail.active === false) continue;
      out.push(mapSmartRecruiters(p, detail, board));
    }
    return out;
  }

  /** Every listed posting, paging until `totalFound`. An incomplete listing throws: absence from a complete sweep means closure. */
  private async listAll(board: BoardRef, transport: Transport): Promise<SrListPosting[]> {
    const seen = new Map<string, SrListPosting>();
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const page = await transport.getJson<SrPage>(this.pageUrl(board, offset));
      if (!page || !Array.isArray(page.content) || typeof page.totalFound !== "number") {
        throw new Error("unexpected payload: no content array or totalFound");
      }
      total = page.totalFound;
      if (page.content.length === 0) {
        if (offset < total) throw new Error(`incomplete listing: empty page at offset ${offset} of ${total}`);
        break;
      }
      for (const p of page.content) if (p.id && p.name && !seen.has(p.id)) seen.set(p.id, p);
      offset += page.content.length;
    }
    return [...seen.values()];
  }
}

export function mapSmartRecruiters(listed: SrListPosting, detail: SrDetail, board: BoardRef): RawPosting {
  const id = listed.id!;
  const sections = detail.jobAd?.sections ?? {};
  const body = SECTIONS.map((k) => sections[k])
    .filter((s): s is SrSection => !!s && typeof s.text === "string" && s.text.trim() !== "")
    .map((s) => (s.title ? `<h3>${s.title}</h3>\n${s.text}` : s.text!))
    .join("\n");
  const loc = detail.location ?? listed.location ?? {};
  const locationRaw = loc.fullLocation ?? [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
  return {
    provider: "smartrecruiters",
    boardId: board.boardId,
    externalId: `${board.token}:${id}`,
    sourceUrl: detail.postingUrl ?? `https://jobs.smartrecruiters.com/${board.token}/${id}`,
    applicationUrl: detail.applyUrl ?? detail.postingUrl ?? null,
    company: board.company,
    title: (detail.name ?? listed.name!).trim(),
    locationRaw,
    workplaceType: loc.hybrid === true ? "hybrid" : null,
    isRemote: loc.remote ?? null,
    employmentTypeRaw: (detail.typeOfEmployment ?? listed.typeOfEmployment)?.label ?? null,
    datePosted: toIsoDate(detail.releasedDate ?? listed.releasedDate),
    descriptionHtml: requireDescription(body, id),
    department: (detail.department ?? listed.department)?.label ?? null,
    team: null,
    salary: null,
  };
}
