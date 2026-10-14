import type { RawPosting } from "../../domain/catalog/posting.js";
import type { BoardRef, SourceAdapter, Transport } from "../../ports/io.js";
import { toIsoDate } from "./common.js";

/**
 * Remote OK public feed. ATTRIBUTION IS A CONDITION OF USE: any surface showing
 * these listings must name Remote OK and link to it. The briefing does; if that
 * is ever removed, disable this source instead.
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

const ANTI_SCRAPE_RE = /Please mention the word[\s\S]{0,400}?when applying to show you read the job post completely[\s\S]{0,200}?human\./gi;

export const REMOTEOK_ATTRIBUTION = "Remote listings courtesy of [Remote OK](https://remoteok.com).";

export class RemoteOkAdapter implements SourceAdapter {
  readonly provider = "remoteok";

  boards(): BoardRef[] {
    return [{ provider: this.provider, boardId: "remoteok", token: null, company: "Remote OK" }];
  }

  endpoint(): string {
    return "https://remoteok.com/api";
  }

  async fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]> {
    const data = await transport.getJson<RemoteOkEntry[]>(this.endpoint());
    if (!Array.isArray(data)) throw new Error("unexpected payload: not an array");
    return mapRemoteOk(data, board);
  }
}

export function mapRemoteOk(entries: RemoteOkEntry[], board: BoardRef): RawPosting[] {
  const out: RawPosting[] = [];
  for (const e of entries) {
    if (e.legal || !e.id || !e.position || !e.company) continue;
    const min = typeof e.salary_min === "number" ? e.salary_min : null;
    const max = typeof e.salary_max === "number" ? e.salary_max : null;
    const plausible = (v: number | null) => v == null || (v >= 30_000 && v <= 1_200_000);
    out.push({
      provider: "remoteok",
      boardId: board.boardId,
      externalId: String(e.id),
      sourceUrl: e.url ?? `https://remoteok.com/remote-jobs/${e.slug ?? e.id}`,
      applicationUrl: e.apply_url ?? e.url ?? null,
      company: e.company.trim(),
      title: e.position.trim(),
      locationRaw: e.location?.trim() ? `Remote (${e.location.trim()})` : "Remote",
      isRemote: true,
      datePosted: toIsoDate(e.epoch ?? e.date),
      descriptionHtml: (e.description ?? "").replace(ANTI_SCRAPE_RE, " ").replace(/\(#[A-Za-z0-9+/=]{8,}\)/g, " "),
      department: null,
      team: e.tags?.length ? e.tags.slice(0, 3).join(", ") : null,
      salary: (min != null || max != null) && plausible(min) && plausible(max) && !(min === 0 && max === 0) ? { min, max, currency: "USD", period: "year" } : null,
    });
  }
  return out;
}
