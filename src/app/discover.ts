import type { AppContext } from "./context.js";
import type { BoardDiscovery, SourcesWriter } from "../ports/io.js";
import { boardKey, configuredBoardKeys, type BoardEntry } from "../domain/config/sources.js";
import { ok, type UseCaseResult } from "../kernel/result.js";

export interface DiscoverDeps {
  /** Probe the public ATS endpoints for one company. */
  probe(company: string): Promise<BoardDiscovery>;
  /** Present only with `--add`: write new boards into sources.yaml. */
  writer: SourcesWriter | null;
}

export interface DiscoverLine {
  company: string;
  status: "found" | "have" | "added" | "none";
  board: string | null;
}

/**
 * Find each company's public ATS board and, with a writer, add the new ones
 * to sources.yaml. A board already configured (same provider, token compared
 * case-insensitively) is reported HAVE and never written twice. A company with
 * no public board is reported for the watchlist, which stays a human's call.
 * All additions go in one validated write: either every new board is added or
 * nothing is.
 */
export async function discover(ctx: AppContext, companies: readonly string[], deps: DiscoverDeps): Promise<UseCaseResult<DiscoverLine[]>> {
  const sources = ctx.config().sources;
  const have = configuredBoardKeys(sources);
  const lines: DiscoverLine[] = [];
  // One slot per company, in input order; an addition's slot is filled after the write.
  const pending: Array<{ entry: BoardEntry; jobCount: number; configLine: string; slot: number }> = [];
  const found: string[] = [];

  for (const company of companies) {
    const r = await deps.probe(company);
    const hit = r.hits[0];
    if (!hit) {
      lines.push({ company, status: "none", board: null });
      found.push(`--    ${company}: no public board (tried ${r.tried.join(", ")}); add it to the watchlist by hand`);
      continue;
    }
    const board = `${hit.ats}:${hit.token}`;
    const key = boardKey(hit.ats, hit.token);
    if (have.has(key)) {
      lines.push({ company, status: "have", board });
      found.push(`HAVE  ${company}: ${board} is already in sources.yaml`);
      continue;
    }
    if (!deps.writer) {
      lines.push({ company, status: "found", board });
      found.push(`FOUND ${company}: ${board} (${hit.jobCount} jobs)\n${hit.configLine}`);
      continue;
    }
    have.add(key);
    pending.push({ entry: { ats: hit.ats, token: hit.token, company }, jobCount: hit.jobCount, configLine: hit.configLine, slot: found.length });
    found.push(`FOUND ${company}: ${board} (${hit.jobCount} jobs)`);
    lines.push({ company, status: "added", board });
  }

  if (!deps.writer || !pending.length) return ok(lines, found);

  let result: { added: BoardEntry[]; file: string };
  try {
    result = deps.writer.addBoards(pending.map((p) => p.entry));
  } catch (err) {
    // The write was refused, so fall back to the paste step: every found board keeps its line.
    for (const l of lines) if (l.status === "added") l.status = "found";
    const notes = [...found];
    for (const p of pending) notes[p.slot] += `\n${p.configLine}`;
    return {
      outcome: "failed",
      value: lines,
      notes: [...notes, `Nothing was written to sources.yaml: ${(err as Error).message}`],
    };
  }
  const addedKeys = new Set(result.added.map((e) => boardKey(e.ats, e.token)));
  const notes = [...found];
  for (const p of pending) {
    const board = `${p.entry.ats}:${p.entry.token}`;
    if (!addedKeys.has(boardKey(p.entry.ats, p.entry.token))) {
      notes[p.slot] = `HAVE  ${p.entry.company}: ${board} is already in sources.yaml`;
      const line = lines.find((l) => l.company === p.entry.company && l.status === "added");
      if (line) line.status = "have";
      continue;
    }
    notes[p.slot] = `ADDED ${p.entry.company}: ${board} (${p.jobCount} jobs) to sources.${p.entry.ats}.boards in ${result.file}`;
    if (!sources.sources[p.entry.ats].enabled) {
      notes[p.slot] += `\n      note: sources.${p.entry.ats}.enabled is false, so this board will not be swept until it is enabled`;
    }
  }
  return ok(lines, notes);
}
