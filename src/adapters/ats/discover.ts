import type { Transport } from "../../ports/io.js";
import { normalizeForIdentity } from "../../domain/text/identity.js";

/** Find a company's public board token by probing the three documented ATS APIs. */
export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface DiscoveryHit {
  ats: AtsKind;
  token: string;
  jobCount: number;
  configLine: string;
}

const PROBES: Array<{ ats: AtsKind; url: (t: string) => string; count: (d: unknown) => number }> = [
  { ats: "greenhouse", url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=false`, count: (d) => (d as { jobs?: unknown[] })?.jobs?.length ?? 0 },
  { ats: "lever", url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`, count: (d) => (Array.isArray(d) ? d.length : 0) },
  { ats: "ashby", url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`, count: (d) => (d as { jobs?: unknown[] })?.jobs?.length ?? 0 },
];

export function candidateTokens(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];
  const base = normalizeForIdentity(raw);
  const domainLabel = raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]?.split(".")[0];
  const out: string[] = [];
  for (const c of [base.replace(/\s+/g, ""), base.replace(/\s+/g, "-"), base.split(" ")[0] ?? "", domainLabel, raw.toLowerCase().replace(/\s+/g, "")]) {
    const clean = (c ?? "").replace(/[^a-z0-9-]/g, "");
    if (clean.length >= 2 && !out.includes(clean)) out.push(clean);
  }
  return out;
}

export function configLine(token: string, company: string): string {
  const name = /[^A-Za-z0-9.]/.test(company) ? `"${company.replace(/"/g, '\\"')}"` : company;
  return `      - { token: ${token}, company: ${name} }`;
}

/** A board that exists but lists nothing counts as not found: it is useless as a source. */
export async function discoverCompany(company: string, transport: Transport): Promise<{ hits: DiscoveryHit[]; tried: string[] }> {
  const hits: DiscoveryHit[] = [];
  const tried: string[] = [];
  for (const token of candidateTokens(company)) {
    tried.push(token);
    for (const probe of PROBES) {
      try {
        const n = probe.count(await transport.getJson<unknown>(probe.url(token)));
        if (n > 0) {
          hits.push({ ats: probe.ats, token, jobCount: n, configLine: configLine(token, company) });
          break;
        }
      } catch {
        // Not on this ATS (usually a 404). Discovery is best-effort.
      }
    }
    if (hits.length) break;
  }
  return { hits, tried };
}
