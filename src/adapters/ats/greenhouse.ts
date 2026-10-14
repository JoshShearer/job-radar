import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { toIsoDate } from "./common.js";

/**
 * Greenhouse public board API (documented, no auth).
 * `content` arrives entity-escaped twice; htmlToText decodes repeatedly.
 */
interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  content?: string;
  company_name?: string;
  location?: { name?: string } | null;
  offices?: { name?: string }[];
  departments?: { name?: string }[];
  metadata?: { name?: string; value?: unknown }[];
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly provider = "greenhouse";
  constructor(private readonly config: ReadonlyArray<{ token: string; company: string }>) {}

  boards(): BoardRef[] {
    return this.config.map((b) => ({ provider: this.provider, boardId: `greenhouse:${b.token}`, token: b.token, company: b.company }));
  }

  endpoint(board: BoardRef): string {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token ?? "")}/jobs?content=true`;
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const data = await transport.getJson<{ jobs?: GhJob[] }>(this.endpoint(board));
    if (!data || !Array.isArray(data.jobs)) throw new Error("unexpected payload: no jobs array");
    return mapGreenhouse(data.jobs, board);
  }
}

export function mapGreenhouse(jobs: GhJob[], board: BoardRef): RawPosting[] {
  const out: RawPosting[] = [];
  for (const j of jobs) {
    if (!j.id || !j.title) continue;
    out.push({
      provider: "greenhouse",
      boardId: board.boardId,
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
  return out;
}

function pickMetadata(metadata: { name?: string; value?: unknown }[] | undefined, names: string[]): string | null {
  for (const entry of metadata ?? []) {
    const n = (entry.name ?? "").toLowerCase();
    if (!names.some((w) => n.includes(w))) continue;
    const v = entry.value;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return null;
}
