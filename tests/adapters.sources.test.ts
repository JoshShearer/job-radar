import { describe, expect, it } from "vitest";
import { GreenhouseAdapter } from "../src/adapters/ats/greenhouse.js";
import { LeverAdapter } from "../src/adapters/ats/lever.js";
import { AshbyAdapter } from "../src/adapters/ats/ashby.js";
import { RemoteOkAdapter } from "../src/adapters/ats/remoteok.js";
import { WorkableAdapter } from "../src/adapters/ats/workable.js";
import { SmartRecruitersAdapter } from "../src/adapters/ats/smartrecruiters.js";
import { buildAdapters } from "../src/adapters/ats/registry.js";
import { sweep } from "../src/app/sweep.js";
import type { Transport } from "../src/ports/io.js";
import {
  ashbyPayload,
  greenhousePayload,
  leverPayload,
  remoteOkPayload,
  smartRecruitersDetailPayload,
  smartRecruitersListPayload,
  workableDetailPayload,
  workableListPayload,
} from "./helpers/payloads.js";
import { makeEnv, testConfig } from "./helpers/context.js";

/**
 * Pinned against observed payload shapes, so a provider renaming a field
 * fails here rather than producing silently empty sweeps. Adapters fetch ONE
 * board and THROW on failure; the sweep records the failure against that
 * board alone (see app.sweep tests).
 */
const serve = (payload: unknown): Transport => ({ getJson: async () => payload as never, status: async () => 200 });
const failing: Transport = { getJson: async () => { throw new Error("HTTP 404 Not Found"); }, status: async () => 404 };

describe("GreenhouseAdapter", () => {
  const a = new GreenhouseAdapter([{ token: "vercel", company: "Vercel" }]);
  const board = a.boards()[0]!;
  it("maps the live payload shape", async () => {
    const [j] = await a.fetchBoard(board, serve(greenhousePayload));
    expect(j).toMatchObject({
      provider: "greenhouse",
      boardId: "greenhouse:vercel",
      externalId: "vercel:6136160004",
      company: "Vercel",
      title: "Senior Software Engineer",
      locationRaw: "Remote - US",
      department: "Engineering",
      employmentTypeRaw: "Full-time",
    });
    expect(j!.datePosted).toMatch(/^2026-08-06/);
  });
  it("throws on a failed board instead of returning nothing", async () => {
    await expect(a.fetchBoard(board, failing)).rejects.toThrow(/404/);
  });
  it("throws on a payload with no jobs array (a renamed field must not look like an empty board)", async () => {
    await expect(a.fetchBoard(board, serve({ postings: [] }))).rejects.toThrow(/unexpected payload/);
  });
});

describe("LeverAdapter", () => {
  const a = new LeverAdapter([{ token: "ro", company: "Ro" }]);
  const board = a.boards()[0]!;
  it("maps the live payload, reassembling lists into the description", async () => {
    const [j] = await a.fetchBoard(board, serve(leverPayload));
    expect(j).toMatchObject({ externalId: "ro:abc-123", boardId: "lever:ro", workplaceType: "remote", employmentTypeRaw: "Full-time" });
    expect(j!.descriptionHtml).toContain("TypeScript");
    expect(j!.descriptionHtml).toContain("Requirements");
    expect(j!.datePosted).toMatch(/^2026-/);
  });
  it("rejects a non-array payload", async () => {
    await expect(a.fetchBoard(board, serve({}))).rejects.toThrow(/unexpected payload/);
  });
});

describe("AshbyAdapter", () => {
  const a = new AshbyAdapter([{ token: "ramp", company: "Ramp" }]);
  const board = a.boards()[0]!;
  it("extracts structured compensation, merges locations, skips unlisted", async () => {
    const jobs = await a.fetchBoard(board, serve(ashbyPayload));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.salary).toEqual({ min: 211400, max: 290600, currency: "USD", period: "year" });
    expect(jobs[0]!.locationRaw).toContain("Remote (US)");
    expect(jobs[0]!.boardId).toBe("ashby:ramp");
  });
  it("ignores equity-only compensation", async () => {
    const jobs = await a.fetchBoard(board, serve({ jobs: [{ id: "x", title: "Engineer", isListed: true, compensation: { summaryComponents: [{ compensationType: "EquityPercentage" }] } }] }));
    expect(jobs[0]!.salary).toBeNull();
  });
});

describe("RemoteOkAdapter", () => {
  const a = new RemoteOkAdapter();
  const board = a.boards()[0]!;
  it("skips the legal notice, strips anti-scraping text, rejects placeholder salaries", async () => {
    const jobs = await a.fetchBoard(board, serve(remoteOkPayload));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.boardId).toBe("remoteok");
    expect(jobs[0]!.descriptionHtml).toContain("Build things");
    expect(jobs[0]!.descriptionHtml).not.toContain("ADROITLY");
    expect(jobs[0]!.isRemote).toBe(true);
    expect(jobs[0]!.salary).toEqual({ min: 150000, max: 200000, currency: "USD", period: "year" });
    expect(jobs[1]!.salary).toBeNull();
  });
});

/** A transport that answers by exact URL and records every request, in order. */
function routed(routes: Record<string, unknown>): Transport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJson: async (url: string) => {
      calls.push(url);
      if (!(url in routes)) throw new Error(`HTTP 404 Not Found (${url})`);
      const v = routes[url];
      if (v instanceof Error) throw v;
      return v as never;
    },
    status: async (url: string) => (url in routes ? 200 : 404),
  };
}

const WK_LIST = "https://apply.workable.com/api/v1/widget/accounts/futurae";
const WK_DETAIL = (code: string) => `https://apply.workable.com/api/v1/accounts/futurae/jobs/${code}`;
const SR_PAGE = (offset: number) => `https://api.smartrecruiters.com/v1/companies/Vitol/postings?limit=100&offset=${offset}`;
const SR_DETAIL = (id: string) => `https://api.smartrecruiters.com/v1/companies/Vitol/postings/${id}`;

describe("WorkableAdapter", () => {
  const a = new WorkableAdapter([{ token: "futurae", company: "Futurae" }]);
  const board = a.boards()[0]!;

  it("lists the board, then fetches each posting's detail for the description (the list carries none)", async () => {
    const t = routed({ [WK_LIST]: workableListPayload, [WK_DETAIL("F4969C4153")]: workableDetailPayload });
    const jobs = await a.fetchBoard(board, t);
    expect(t.calls).toEqual([WK_LIST, WK_DETAIL("F4969C4153")]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      provider: "workable",
      boardId: "workable:futurae",
      externalId: "futurae:F4969C4153",
      company: "Futurae",
      title: "Senior Partnerships Manager (DACH)",
      sourceUrl: "https://apply.workable.com/j/F4969C4153",
      applicationUrl: "https://apply.workable.com/j/F4969C4153/apply",
      employmentTypeRaw: "Full-time",
      department: "Business",
      // Provider fields passed through untouched: normalize decides.
      workplaceType: "hybrid",
      isRemote: false,
      salary: null,
    });
    expect(jobs[0]!.locationRaw).toBe("Zürich, Zurich, Switzerland | Vienna, Vienna, Austria | Frankfurt am Main, Hessen, Germany");
    expect(jobs[0]!.datePosted).toMatch(/^2026-07-22/);
    expect(jobs[0]!.descriptionHtml).toContain("Alliances &amp; Partnerships");
    expect(jobs[0]!.descriptionHtml).toContain("Tasks &amp; Responsibilities");
    expect(jobs[0]!.descriptionHtml).toContain("international team");
  });

  it("fetches a multi-location posting once: the list repeats it per location under one shortcode", async () => {
    expect(workableListPayload.jobs.map((j) => j.shortcode)).toEqual(["F4969C4153", "F4969C4153", "F4969C4153"]);
    const t = routed({ [WK_LIST]: workableListPayload, [WK_DETAIL("F4969C4153")]: workableDetailPayload });
    expect((await a.fetchBoard(board, t)).map((j) => j.externalId)).toEqual(["futurae:F4969C4153"]);
    expect(t.calls).toEqual([WK_LIST, WK_DETAIL("F4969C4153")]);
  });

  it("falls back to the list's telecommuting flag when the detail has no remote field", async () => {
    const list = { ...workableListPayload, jobs: [{ ...workableListPayload.jobs[0]!, telecommuting: true, locations: [] }] };
    const { remote: _r, workplace: _w, ...detail } = workableDetailPayload;
    const jobs = await a.fetchBoard(board, routed({ [WK_LIST]: list, [WK_DETAIL("F4969C4153")]: detail }));
    expect(jobs[0]).toMatchObject({ isRemote: true, workplaceType: null });
  });

  it("an empty board is an empty board", async () => {
    const t = routed({ [WK_LIST]: { ...workableListPayload, jobs: [] } });
    expect(await a.fetchBoard(board, t)).toEqual([]);
    expect(t.calls).toEqual([WK_LIST]);
  });

  it("a missing account (HTTP 404) fails the board", async () => {
    await expect(a.fetchBoard(board, routed({}))).rejects.toThrow(/404/);
  });

  it("one failed detail fetch fails the whole board: a partial board must not look like a complete sweep", async () => {
    const list = { ...workableListPayload, jobs: [workableListPayload.jobs[0]!, { ...workableListPayload.jobs[0]!, shortcode: "B2" }] };
    const t = routed({ [WK_LIST]: list, [WK_DETAIL("F4969C4153")]: workableDetailPayload, [WK_DETAIL("B2")]: new Error("HTTP 500 Internal Server Error") });
    await expect(a.fetchBoard(board, t)).rejects.toThrow(/B2.*500/);
  });

  it("never emits a posting with an empty description", async () => {
    const detail = { ...workableDetailPayload, description: "", requirements: " ", benefits: null };
    await expect(a.fetchBoard(board, routed({ [WK_LIST]: workableListPayload, [WK_DETAIL("F4969C4153")]: detail }))).rejects.toThrow(/empty description/);
  });

  it("throws on a payload with no jobs array (a renamed field must not look like an empty board)", async () => {
    await expect(a.fetchBoard(board, routed({ [WK_LIST]: { name: "Futurae" } }))).rejects.toThrow(/unexpected payload/);
  });

  it("health-checks the list endpoint (a missing account is a 404 there)", () => {
    expect(a.endpoint(board)).toBe(WK_LIST);
  });
});

describe("SmartRecruitersAdapter", () => {
  const a = new SmartRecruitersAdapter([{ token: "Vitol", company: "Vitol" }]);
  const board = a.boards()[0]!;
  const posting = smartRecruitersListPayload.content[0]!;

  it("lists, then fetches each posting's detail and assembles the job ad sections", async () => {
    const t = routed({ [SR_PAGE(0)]: smartRecruitersListPayload, [SR_DETAIL(posting.id)]: smartRecruitersDetailPayload });
    const jobs = await a.fetchBoard(board, t);
    expect(t.calls).toEqual([SR_PAGE(0), SR_DETAIL(posting.id)]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      provider: "smartrecruiters",
      boardId: "smartrecruiters:Vitol",
      externalId: "Vitol:744000155316183",
      company: "Vitol",
      title: "Physical Operator – US West Coast Pipeline Operations",
      sourceUrl: smartRecruitersDetailPayload.postingUrl,
      applicationUrl: smartRecruitersDetailPayload.applyUrl,
      locationRaw: "Houston, TX, United States",
      employmentTypeRaw: "Full-time",
      department: "Operations",
      isRemote: false,
      workplaceType: null,
      salary: null,
    });
    expect(jobs[0]!.datePosted).toMatch(/^2026-10-13/);
    const d = jobs[0]!.descriptionHtml;
    for (const part of ["leader in energy", "Physical Operator is responsible", "pipeline scheduling", "Primarily office-based"]) expect(d).toContain(part);
    expect(d.indexOf("Job Description")).toBeLessThan(d.indexOf("Qualifications"));
  });

  it("passes the provider's remote and hybrid booleans through, hybrid only when true", async () => {
    const detail = { ...smartRecruitersDetailPayload, location: { ...smartRecruitersDetailPayload.location, remote: true, hybrid: true } };
    const jobs = await a.fetchBoard(board, routed({ [SR_PAGE(0)]: smartRecruitersListPayload, [SR_DETAIL(posting.id)]: detail }));
    expect(jobs[0]).toMatchObject({ isRemote: true, workplaceType: "hybrid" });
  });

  it("pages with limit=100 and offset until totalFound", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `p${i}`);
    const page = (offset: number) => ({ offset, limit: 100, totalFound: 150, content: ids.slice(offset, offset + 100).map((id) => ({ ...posting, id })) });
    const routes: Record<string, unknown> = { [SR_PAGE(0)]: page(0), [SR_PAGE(100)]: page(100) };
    for (const id of ids) routes[SR_DETAIL(id)] = { ...smartRecruitersDetailPayload, id };
    const t = routed(routes);
    const jobs = await a.fetchBoard(board, t);
    expect(jobs.map((j) => j.externalId)).toEqual(ids.map((id) => `Vitol:${id}`));
    expect(t.calls.filter((u) => u.includes("?"))).toEqual([SR_PAGE(0), SR_PAGE(100)]);
    expect(t.calls).toHaveLength(152);
  });

  it("a 200 with totalFound 0 is an empty board, not an error, and fetches no details", async () => {
    const t = routed({ [SR_PAGE(0)]: { offset: 0, limit: 100, totalFound: 0, content: [] } });
    expect(await a.fetchBoard(board, t)).toEqual([]);
    expect(t.calls).toEqual([SR_PAGE(0)]);
  });

  it("an empty page before totalFound is reached fails the board instead of reading as closures", async () => {
    const t = routed({ [SR_PAGE(0)]: { ...smartRecruitersListPayload, totalFound: 150 }, [SR_PAGE(1)]: { offset: 1, limit: 100, totalFound: 150, content: [] } });
    await expect(a.fetchBoard(board, t)).rejects.toThrow(/incomplete/);
  });

  it("one failed detail fetch fails the whole board", async () => {
    const t = routed({ [SR_PAGE(0)]: smartRecruitersListPayload, [SR_DETAIL(posting.id)]: new Error("HTTP 503 Service Unavailable") });
    await expect(a.fetchBoard(board, t)).rejects.toThrow(/744000155316183.*503/);
  });

  it("never emits a posting with an empty description", async () => {
    const detail = { ...smartRecruitersDetailPayload, jobAd: { sections: {} } };
    await expect(a.fetchBoard(board, routed({ [SR_PAGE(0)]: smartRecruitersListPayload, [SR_DETAIL(posting.id)]: detail }))).rejects.toThrow(/empty description/);
  });

  it("throws on a list payload with no content array", async () => {
    await expect(a.fetchBoard(board, routed({ [SR_PAGE(0)]: { totalFound: 3 } }))).rejects.toThrow(/unexpected payload/);
  });
});

describe("sweep over the two-call providers", () => {
  it("records both providers' boards; a board whose detail fetch fails is isolated and leaves the run intact", async () => {
    const config = testConfig((c) => {
      c.sources.sources.greenhouse.boards = [];
      c.sources.sources.workable.boards = [{ token: "futurae", company: "Futurae" }];
      c.sources.sources.smartrecruiters.boards = [
        { token: "Vitol", company: "Vitol" },
        { token: "Broken", company: "Broken" },
      ];
    });
    expect(buildAdapters(config.sources).map((x) => x.provider)).toEqual(["workable", "smartrecruiters"]);
    const env = makeEnv({
      config,
      routes: {
        [WK_LIST]: workableListPayload,
        [WK_DETAIL("F4969C4153")]: workableDetailPayload,
        [SR_PAGE(0)]: smartRecruitersListPayload,
        [SR_DETAIL("744000155316183")]: smartRecruitersDetailPayload,
        "companies/Broken/postings?limit=100&offset=0": smartRecruitersListPayload,
        "companies/Broken/postings/744000155316183": new Error("HTTP 500 Internal Server Error"),
      },
    });
    const r = await sweep(env.ctx, env.ctx.store.startRun("sweep", "2026-10-01T12:00:00.000Z"));
    expect(r.outcome).toBe("degraded");
    expect(r.value.boardsComplete).toBe(2);
    expect(r.value.failures.map((f) => f.boardId)).toEqual(["smartrecruiters:Broken"]);
    expect(r.value.postingsSeen).toBe(2);
    expect(env.ctx.store.postingVersions("workable:futurae", "futurae:F4969C4153")).toHaveLength(1);
    expect(env.ctx.store.postingVersions("smartrecruiters:Vitol", "Vitol:744000155316183")).toHaveLength(1);
    expect(env.ctx.store.postingVersions("smartrecruiters:Broken", "Broken:744000155316183")).toHaveLength(0);
  });
});
