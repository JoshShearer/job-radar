import { describe, it, expect, vi } from "vitest";
import { candidateTokens, configLine, discoverCompany } from "../src/sources/discover.js";
import type { PoliteFetcher } from "../src/lib/http.js";

function fetcherReturning(map: Record<string, unknown>): PoliteFetcher {
  return {
    getJson: vi.fn(async (url: string) => {
      for (const [fragment, payload] of Object.entries(map)) {
        if (url.includes(fragment)) return payload;
      }
      throw new Error("HTTP 404 Not Found");
    }),
    getText: vi.fn(),
  } as unknown as PoliteFetcher;
}

describe("candidateTokens", () => {
  it("collapses a multi-word name", () => {
    expect(candidateTokens("Back Market")).toContain("backmarket");
  });

  it("offers a hyphenated variant", () => {
    expect(candidateTokens("Back Market")).toContain("back-market");
  });

  it("lowercases and strips punctuation", () => {
    const t = candidateTokens("Customer.io");
    expect(t).toContain("customerio");
  });

  it("drops corporate suffixes", () => {
    expect(candidateTokens("Acme, Inc.")).toContain("acme");
  });

  it("handles a domain or URL", () => {
    expect(candidateTokens("https://sanity.io/careers")).toContain("sanity");
    expect(candidateTokens("sanity.io")).toContain("sanity");
  });

  it("returns nothing for empty input", () => {
    expect(candidateTokens("   ")).toEqual([]);
  });

  it("does not emit duplicates", () => {
    const t = candidateTokens("Vercel");
    expect(new Set(t).size).toBe(t.length);
  });

  it("puts the most likely token first", () => {
    expect(candidateTokens("Back Market")[0]).toBe("backmarket");
  });
});

describe("configLine", () => {
  it("emits a pasteable entry", () => {
    expect(configLine("vercel", "Vercel")).toBe("      - { token: vercel, company: Vercel }");
  });

  it("quotes names containing spaces or punctuation", () => {
    expect(configLine("backmarket", "Back Market")).toContain('company: "Back Market"');
    expect(configLine("customerio", "Customer.io")).toBe(
      "      - { token: customerio, company: Customer.io }",
    );
  });
});

describe("discoverCompany", () => {
  it("finds a Greenhouse board", async () => {
    const f = fetcherReturning({ "greenhouse.io/v1/boards/vercel": { jobs: [{}, {}, {}] } });
    const r = await discoverCompany("Vercel", f);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ ats: "greenhouse", token: "vercel", jobCount: 3 });
  });

  it("finds a Lever board when Greenhouse misses", async () => {
    const f = fetcherReturning({ "api.lever.co/v0/postings/brightedge": [{}, {}] });
    const r = await discoverCompany("BrightEdge", f);
    expect(r.hits[0]).toMatchObject({ ats: "lever", token: "brightedge", jobCount: 2 });
  });

  it("finds an Ashby board", async () => {
    const f = fetcherReturning({ "ashbyhq.com/posting-api/job-board/sanity": { jobs: [{}] } });
    const r = await discoverCompany("Sanity", f);
    expect(r.hits[0]).toMatchObject({ ats: "ashby", token: "sanity" });
  });

  it("falls through to a hyphenated token when the collapsed one misses", async () => {
    const f = fetcherReturning({ "boards/back-market": { jobs: [{}] } });
    const r = await discoverCompany("Back Market", f);
    expect(r.hits[0]?.token).toBe("back-market");
    expect(r.tokensTried).toContain("backmarket");
  });

  it("returns no hits when nothing matches, without throwing", async () => {
    const f = fetcherReturning({});
    const r = await discoverCompany("Definitely Not A Company", f);
    expect(r.hits).toEqual([]);
    expect(r.tokensTried.length).toBeGreaterThan(0);
  });

  it("treats an empty job list as not found", async () => {
    // A board that exists but lists nothing is useless as a source.
    const f = fetcherReturning({ "boards/ghosttown": { jobs: [] } });
    const r = await discoverCompany("ghosttown", f);
    expect(r.hits).toEqual([]);
  });

  it("stops at the first hit by default", async () => {
    const f = fetcherReturning({
      "boards/acme": { jobs: [{}] },
      "postings/acme": [{}, {}],
    });
    const r = await discoverCompany("Acme", f);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.ats).toBe("greenhouse");
  });

  it("produces a config line ready to paste", async () => {
    const f = fetcherReturning({ "boards/backmarket": { jobs: [{}] } });
    const r = await discoverCompany("Back Market", f);
    expect(r.hits[0]?.configLine).toBe('      - { token: backmarket, company: "Back Market" }');
  });
});
