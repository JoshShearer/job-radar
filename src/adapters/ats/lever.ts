import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { mapInterval, toIsoDate } from "./common.js";

/**
 * Lever public postings API. The requirement bullets live in `lists[]`;
 * dropping them would throw away most of the keyword signal.
 */
interface LeverPosting {
  id: string;
  text: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  categories?: { commitment?: string; location?: string; team?: string; department?: string; allLocations?: string[] };
  description?: string;
  additional?: string;
  lists?: { text?: string; content?: string }[];
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null;
}

export class LeverAdapter implements SourceAdapter {
  readonly provider = "lever";
  constructor(private readonly config: ReadonlyArray<{ token: string; company: string }>) {}

  boards(): BoardRef[] {
    return this.config.map((b) => ({ provider: this.provider, boardId: `lever:${b.token}`, token: b.token, company: b.company }));
  }

  endpoint(board: BoardRef): string {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(board.token ?? "")}?mode=json`;
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const data = await transport.getJson<LeverPosting[]>(this.endpoint(board));
    if (!Array.isArray(data)) throw new Error("unexpected payload: not an array");
    return mapLever(data, board);
  }
}

export function mapLever(jobs: LeverPosting[], board: BoardRef): RawPosting[] {
  const out: RawPosting[] = [];
  for (const j of jobs) {
    if (!j.id || !j.text) continue;
    const cats = j.categories ?? {};
    out.push({
      provider: "lever",
      boardId: board.boardId,
      externalId: `${board.token}:${j.id}`,
      sourceUrl: j.hostedUrl ?? `https://jobs.lever.co/${board.token}/${j.id}`,
      applicationUrl: j.applyUrl ?? j.hostedUrl ?? null,
      company: board.company,
      title: j.text.trim(),
      locationRaw: cats.location ?? (cats.allLocations?.length ? cats.allLocations.join(", ") : ""),
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
  return out;
}

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
