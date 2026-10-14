import type { Sources } from "./schema.js";

/** The ATS providers that `discover` probes and that hold a `boards` list in sources.yaml. */
export const ATS_KINDS = ["greenhouse", "lever", "ashby"] as const;
export type AtsKind = (typeof ATS_KINDS)[number];

export interface BoardEntry {
  ats: AtsKind;
  token: string;
  company: string;
}

/** The identity of a configured board. Tokens are case-insensitive on every provider. */
export function boardKey(ats: AtsKind, token: string): string {
  return `${ats}:${token.trim().toLowerCase()}`;
}

export function configuredBoardKeys(sources: Sources): Set<string> {
  const out = new Set<string>();
  for (const ats of ATS_KINDS) for (const b of sources.sources[ats].boards) out.add(boardKey(ats, b.token));
  return out;
}
