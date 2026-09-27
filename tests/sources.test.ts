import { describe, it, expect, vi } from "vitest";
import { GreenhouseSource } from "../src/sources/greenhouse.js";
import { LeverSource } from "../src/sources/lever.js";
import { AshbySource } from "../src/sources/ashby.js";
import { RemoteOkSource } from "../src/sources/remoteok.js";
import { RunStats } from "../src/lib/log.js";
import type { SourceContext } from "../src/sources/types.js";
import type { PoliteFetcher } from "../src/lib/http.js";

/**
 * External services are mocked. These tests pin the adapters against the
 * payload shapes actually observed on the live endpoints, so a provider
 * changing a field name surfaces here rather than as silently empty results.
 */
function ctx(payload: unknown, shouldThrow = false): SourceContext {
  const getJson = shouldThrow
    ? vi.fn().mockRejectedValue(new Error("HTTP 404 Not Found"))
    : vi.fn().mockResolvedValue(payload);
  return {
    fetcher: { getJson, getText: vi.fn() } as unknown as PoliteFetcher,
    stats: new RunStats(),
  };
}

describe("GreenhouseSource", () => {
  const payload = {
    jobs: [
      {
        id: 6136160004,
        title: "Senior Software Engineer",
        absolute_url: "https://job-boards.greenhouse.io/vercel/jobs/6136160004",
        updated_at: "2026-08-06T13:47:17-04:00",
        first_published: "2026-08-06T12:50:10-04:00",
        location: { name: "Remote - US" },
        company_name: "Vercel",
        departments: [{ name: "Engineering" }, { name: "Platform" }],
        content: "&amp;lt;p&amp;gt;Build with TypeScript.&amp;lt;/p&amp;gt;",
        metadata: [{ name: "Employment Type", value: "Full-time" }],
      },
    ],
  };

  it("maps the live payload shape", async () => {
    const c = ctx(payload);
    const jobs = await new GreenhouseSource([{ token: "vercel", company: "Vercel" }]).fetch(c);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.source).toBe("greenhouse");
    expect(j.board).toBe("greenhouse:vercel");
    expect(j.ats).toBe("greenhouse");
    expect(j.externalId).toBe("vercel:6136160004");
    expect(j.company).toBe("Vercel");
    expect(j.title).toBe("Senior Software Engineer");
    expect(j.locationRaw).toBe("Remote - US");
    expect(j.department).toBe("Engineering");
    expect(j.employmentTypeRaw).toBe("Full-time");
    expect(j.datePosted).toMatch(/^2026-08-06/);
  });

  it("records a successful sweep for the board, at board granularity", async () => {
    const c = ctx(payload);
    await new GreenhouseSource([{ token: "vercel", company: "Vercel" }]).fetch(c);
    expect(c.stats.sweeps).toEqual([
      { boardId: "greenhouse:vercel", provider: "greenhouse", ok: true, jobCount: 1 },
    ]);
  });

  it("keeps going when a board 404s", async () => {
    const c = ctx(null, true);
    const jobs = await new GreenhouseSource([{ token: "gone", company: "Gone" }]).fetch(c);
    expect(jobs).toEqual([]);
    expect(c.stats.failureCount).toBe(1);
    expect(c.stats.get("greenhouse.boards_failed")).toBe(1);
  });

  it("records a failed sweep for a board that errors, and never throws", async () => {
    const c = ctx(null, true);
    await new GreenhouseSource([{ token: "gone", company: "Gone" }]).fetch(c);
    expect(c.stats.sweeps).toEqual([{ boardId: "greenhouse:gone", provider: "greenhouse", ok: false, jobCount: 0 }]);
  });

  it("records failure for one board but still returns others", async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce(payload)
      .mockRejectedValueOnce(new Error("HTTP 500"));
    const c: SourceContext = {
      fetcher: { getJson, getText: vi.fn() } as unknown as PoliteFetcher,
      stats: new RunStats(),
    };
    const jobs = await new GreenhouseSource([
      { token: "vercel", company: "Vercel" },
      { token: "broken", company: "Broken" },
    ]).fetch(c);
    expect(jobs).toHaveLength(1);
    expect(c.stats.failureCount).toBe(1);
  });

  it("reports a mixed run as one ok sweep and one failed sweep, independently", async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce(payload)
      .mockRejectedValueOnce(new Error("HTTP 500"));
    const c: SourceContext = {
      fetcher: { getJson, getText: vi.fn() } as unknown as PoliteFetcher,
      stats: new RunStats(),
    };
    await new GreenhouseSource([
      { token: "vercel", company: "Vercel" },
      { token: "broken", company: "Broken" },
    ]).fetch(c);
    expect(c.stats.sweeps).toEqual([
      { boardId: "greenhouse:vercel", provider: "greenhouse", ok: true, jobCount: 1 },
      { boardId: "greenhouse:broken", provider: "greenhouse", ok: false, jobCount: 0 },
    ]);
  });
});

describe("LeverSource", () => {
  const payload = [
    {
      id: "abc-123",
      text: "Senior Full Stack Engineer",
      hostedUrl: "https://jobs.lever.co/ro/abc-123",
      applyUrl: "https://jobs.lever.co/ro/abc-123/apply",
      createdAt: 1786400108000,
      workplaceType: "remote",
      categories: { commitment: "Full-time", location: "Remote", team: "Engineering" },
      description: "<p>Intro paragraph.</p>",
      lists: [{ text: "Requirements", content: "<li>TypeScript</li><li>React</li>" }],
      additional: "<p>Benefits.</p>",
    },
  ];

  it("maps the live payload shape", async () => {
    const c = ctx(payload);
    const jobs = await new LeverSource([{ token: "ro", company: "Ro" }]).fetch(c);
    const j = jobs[0]!;
    expect(j.externalId).toBe("ro:abc-123");
    expect(j.board).toBe("lever:ro");
    expect(j.title).toBe("Senior Full Stack Engineer");
    expect(j.workplaceType).toBe("remote");
    expect(j.employmentTypeRaw).toBe("Full-time");
  });

  it("records a successful sweep for the board", async () => {
    const c = ctx(payload);
    await new LeverSource([{ token: "ro", company: "Ro" }]).fetch(c);
    expect(c.stats.sweeps).toEqual([{ boardId: "lever:ro", provider: "lever", ok: true, jobCount: 1 }]);
  });

  it("records a failed sweep for a board that errors, and never throws", async () => {
    const c = ctx(null, true);
    const jobs = await new LeverSource([{ token: "gone", company: "Gone" }]).fetch(c);
    expect(jobs).toEqual([]);
    expect(c.stats.sweeps).toEqual([{ boardId: "lever:gone", provider: "lever", ok: false, jobCount: 0 }]);
  });

  it("reassembles the description from lists, not just the intro", async () => {
    // Lever puts the technology keywords in `lists`. Reading only
    // `description` would score every Lever job far too low.
    const c = ctx(payload);
    const jobs = await new LeverSource([{ token: "ro", company: "Ro" }]).fetch(c);
    expect(jobs[0]!.descriptionHtml).toContain("TypeScript");
    expect(jobs[0]!.descriptionHtml).toContain("React");
    expect(jobs[0]!.descriptionHtml).toContain("Requirements");
  });

  it("converts epoch-millisecond timestamps", async () => {
    const c = ctx(payload);
    const jobs = await new LeverSource([{ token: "ro", company: "Ro" }]).fetch(c);
    expect(jobs[0]!.datePosted).toMatch(/^2026-/);
  });
});

describe("AshbySource", () => {
  const payload = {
    jobs: [
      {
        id: "34413f8d",
        title: "Senior Product Engineer",
        department: "Engineering",
        team: "Backend",
        employmentType: "FullTime",
        location: "New York, NY (HQ)",
        secondaryLocations: [{ location: "Remote (US)" }],
        publishedAt: "2026-04-07T17:12:35.753+00:00",
        isListed: true,
        isRemote: true,
        workplaceType: "Hybrid",
        jobUrl: "https://jobs.ashbyhq.com/ramp/34413f8d",
        applyUrl: "https://jobs.ashbyhq.com/ramp/34413f8d/application",
        descriptionHtml: "<p>About Ramp</p>",
        descriptionPlain: "About Ramp",
        compensation: {
          summaryComponents: [
            {
              compensationType: "Salary",
              interval: "1 YEAR",
              currencyCode: "USD",
              minValue: 211400,
              maxValue: 290600,
            },
            { compensationType: "EquityPercentage", interval: "NONE", currencyCode: null },
          ],
        },
      },
      { id: "hidden", title: "Unlisted role", isListed: false },
    ],
  };

  it("extracts structured compensation", async () => {
    const c = ctx(payload);
    const jobs = await new AshbySource([{ token: "ramp", company: "Ramp" }]).fetch(c);
    expect(jobs[0]!.salary).toEqual({ min: 211400, max: 290600, currency: "USD", period: "year" });
  });

  it("carries the board identity", async () => {
    const c = ctx(payload);
    const jobs = await new AshbySource([{ token: "ramp", company: "Ramp" }]).fetch(c);
    expect(jobs[0]!.board).toBe("ashby:ramp");
  });

  it("records a successful sweep for the board", async () => {
    const c = ctx(payload);
    await new AshbySource([{ token: "ramp", company: "Ramp" }]).fetch(c);
    // Two entries in the payload, one filtered by isListed:false - the sweep
    // count reflects what the board returned, not what survived filtering.
    expect(c.stats.sweeps).toEqual([{ boardId: "ashby:ramp", provider: "ashby", ok: true, jobCount: 2 }]);
  });

  it("records a failed sweep for a board that errors, and never throws", async () => {
    const c = ctx(null, true);
    const jobs = await new AshbySource([{ token: "gone", company: "Gone" }]).fetch(c);
    expect(jobs).toEqual([]);
    expect(c.stats.sweeps).toEqual([{ boardId: "ashby:gone", provider: "ashby", ok: false, jobCount: 0 }]);
  });

  it("merges secondary locations so remote eligibility is not lost", async () => {
    const c = ctx(payload);
    const jobs = await new AshbySource([{ token: "ramp", company: "Ramp" }]).fetch(c);
    expect(jobs[0]!.locationRaw).toContain("Remote (US)");
  });

  it("skips unlisted jobs", async () => {
    const c = ctx(payload);
    const jobs = await new AshbySource([{ token: "ramp", company: "Ramp" }]).fetch(c);
    expect(jobs).toHaveLength(1);
  });

  it("ignores equity-only compensation components", async () => {
    const equityOnly = {
      jobs: [
        {
          id: "x",
          title: "Engineer",
          isListed: true,
          compensation: {
            summaryComponents: [{ compensationType: "EquityPercentage", interval: "NONE", currencyCode: null }],
          },
        },
      ],
    };
    const c = ctx(equityOnly);
    const jobs = await new AshbySource([{ token: "t", company: "T" }]).fetch(c);
    expect(jobs[0]!.salary).toBeNull();
  });
});

describe("RemoteOkSource", () => {
  const payload = [
    { legal: "API Terms of Service: Please link back..." },
    {
      slug: "senior-engineer-acme",
      id: "1136375",
      epoch: 1786400108,
      company: "Acme",
      position: "Senior Engineer",
      tags: ["typescript", "react"],
      description:
        "<strong>Build things.</strong> Please mention the word **ADROITLY** and tag RMTM2 when applying to show you read the job post completely (#RMTM2). This is a beta feature to avoid spam applicants. Companies can search these words to find applicants that read this and see they're human.",
      location: "Worldwide",
      apply_url: "https://remoteok.com/remote-jobs/senior-engineer-acme",
      salary_min: 150000,
      salary_max: 200000,
    },
    { id: "0", company: "Bad", position: "Engineer", salary_min: 0, salary_max: 0 },
  ];

  it("skips the legal-notice entry", async () => {
    const c = ctx(payload);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs.every((j) => j.company !== undefined)).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it("uses the bare provider name as its board - a single feed, no per-employer token", async () => {
    const c = ctx(payload);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs[0]!.board).toBe("remoteok");
  });

  it("records a successful sweep under the bare provider name", async () => {
    const c = ctx(payload);
    await new RemoteOkSource().fetch(c);
    expect(c.stats.sweeps).toEqual([{ boardId: "remoteok", provider: "remoteok", ok: true, jobCount: 2 }]);
  });

  it("records a failed sweep when the feed errors, and never throws", async () => {
    const c = ctx(null, true);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs).toEqual([]);
    expect(c.stats.sweeps).toEqual([{ boardId: "remoteok", provider: "remoteok", ok: false, jobCount: 0 }]);
  });

  it("strips the anti-scraping instrumentation from descriptions", async () => {
    const c = ctx(payload);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs[0]!.descriptionHtml).toContain("Build things");
    expect(jobs[0]!.descriptionHtml).not.toContain("ADROITLY");
    expect(jobs[0]!.descriptionHtml).not.toMatch(/beta feature to avoid spam/);
  });

  it("marks everything remote", async () => {
    const c = ctx(payload);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs[0]!.isRemote).toBe(true);
    expect(jobs[0]!.locationRaw).toContain("Remote");
  });

  it("accepts plausible salary and rejects placeholder zeros", async () => {
    const c = ctx(payload);
    const jobs = await new RemoteOkSource().fetch(c);
    expect(jobs[0]!.salary).toEqual({ min: 150000, max: 200000, currency: "USD", period: "year" });
    expect(jobs[1]!.salary).toBeNull();
  });
});
