import { describe, expect, it } from "vitest";
import { GreenhouseAdapter } from "../src/adapters/ats/greenhouse.js";
import { LeverAdapter } from "../src/adapters/ats/lever.js";
import { AshbyAdapter } from "../src/adapters/ats/ashby.js";
import { RemoteOkAdapter } from "../src/adapters/ats/remoteok.js";
import type { Transport } from "../src/ports/io.js";
import { ashbyPayload, greenhousePayload, leverPayload, remoteOkPayload } from "./helpers/payloads.js";

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
