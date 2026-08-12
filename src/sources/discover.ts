import type { PoliteFetcher } from "../lib/http.js";
import { normalizeForIdentity } from "../lib/hash.js";

/**
 * ATS discovery.
 *
 * Adding companies is the highest-leverage tuning move available - the source
 * list determines everything downstream, and the first version of this project
 * proved that a list of famous companies produces a slate where none of the
 * candidate's differentiation counts. Yet finding a company's board token was
 * the most manual step in the whole system, done with a throwaway script.
 *
 * This turns it into a command. Given a company name it derives plausible
 * tokens, probes the three public ATS APIs, and prints a config line to paste.
 *
 * Only the same public, documented endpoints the adapters already use. No
 * scraping, no auth, no guessing at private URLs.
 */

export type AtsKind = "greenhouse" | "lever" | "ashby";

export interface DiscoveryHit {
  ats: AtsKind;
  token: string;
  company: string;
  jobCount: number;
  configLine: string;
}

export interface DiscoveryResult {
  query: string;
  hits: DiscoveryHit[];
  tokensTried: string[];
}

const PROBES: { ats: AtsKind; url: (t: string) => string; count: (d: unknown) => number }[] = [
  {
    ats: "greenhouse",
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=false`,
    count: (d) => (d as { jobs?: unknown[] })?.jobs?.length ?? 0,
  },
  {
    ats: "lever",
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    count: (d) => (Array.isArray(d) ? d.length : 0),
  },
  {
    ats: "ashby",
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    count: (d) => (d as { jobs?: unknown[] })?.jobs?.length ?? 0,
  },
];

/**
 * Derive candidate board tokens from a company name.
 *
 * Boards are usually the company name lowercased with punctuation removed
 * ("Back Market" -> backmarket), but hyphenated and suffix-stripped variants
 * are common enough to be worth trying. Ordered most to least likely so the
 * first hit is usually the first request.
 */
export function candidateTokens(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const base = normalizeForIdentity(raw); // lowercased, punctuation stripped, suffixes dropped
  const collapsed = base.replace(/\s+/g, "");
  const hyphenated = base.replace(/\s+/g, "-");
  const firstWord = base.split(" ")[0] ?? "";
  // Domain-style input ("sanity.io") - take the label before the TLD.
  const domainLabel = raw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.split(".")[0];

  const candidates = [collapsed, hyphenated, firstWord, domainLabel, raw.toLowerCase().replace(/\s+/g, "")];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const clean = c.replace(/[^a-z0-9-]/g, "");
    if (clean.length < 2 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/** Format a ready-to-paste sources.yaml entry. */
export function configLine(token: string, company: string): string {
  const needsQuotes = /[^A-Za-z0-9.]/.test(company);
  const name = needsQuotes ? `"${company.replace(/"/g, '\\"')}"` : company;
  return `      - { token: ${token}, company: ${name} }`;
}

/**
 * Probe every candidate token against every ATS.
 *
 * Stops at the first hit per token: a company is on one ATS, and continuing
 * would spend requests on endpoints that cannot match.
 */
export async function discoverCompany(
  company: string,
  fetcher: PoliteFetcher,
  opts: { allTokens?: boolean } = {},
): Promise<DiscoveryResult> {
  const tokens = candidateTokens(company);
  const hits: DiscoveryHit[] = [];
  const tried: string[] = [];

  for (const token of tokens) {
    tried.push(token);
    let found = false;

    for (const probe of PROBES) {
      try {
        const data = await fetcher.getJson<unknown>(probe.url(token));
        const jobCount = probe.count(data);
        if (jobCount > 0) {
          hits.push({
            ats: probe.ats,
            token,
            company,
            jobCount,
            configLine: configLine(token, company),
          });
          found = true;
          break;
        }
      } catch {
        // A 404 means "not this ATS", which is the expected case. Any other
        // failure is equally non-fatal here - discovery is best-effort.
      }
    }

    // One good token is the answer. Keep going only when explicitly asked,
    // which is useful for companies with several regional boards.
    if (found && !opts.allTokens) break;
  }

  return { query: company, hits, tokensTried: tried };
}
