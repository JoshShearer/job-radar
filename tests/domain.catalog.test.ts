import { describe, expect, it } from "vitest";
import { deriveLifecycle } from "../src/domain/catalog/lifecycle.js";
import { resolveBatch, type ResolutionIndex } from "../src/domain/catalog/resolve.js";
import { normalizePosting } from "../src/domain/catalog/normalize.js";
import type { RawPosting } from "../src/domain/catalog/posting.js";
import { testConfig } from "./helpers/context.js";

const policy = { parkAfterDays: 3, maxFractionPerBoard: 0.5 };
const cov = (boardId: string, startedAt: string, previousStartedAt: string | null = null) => ({
  boardId,
  startedAt,
  finishedAt: startedAt.replace("T00", "T00").replace(":00:00", ":05:00"),
  previousStartedAt,
});

describe("posting lifecycle (derived from complete sweeps only)", () => {
  it("a posting listed by its board's latest complete sweep is open", () => {
    const r = deriveLifecycle([{ opportunityId: "a", boardId: "gh:x", lastSeen: "2026-10-01T00:01:00Z" }], [cov("gh:x", "2026-10-01T00:00:00Z")], policy);
    expect(r.states.get("a")).toBe("open");
  });

  it("missing, then closed after park_after_days of complete sweeps", () => {
    const s = [{ opportunityId: "a", boardId: "gh:x", lastSeen: "2026-09-30T00:01:00Z" }];
    expect(deriveLifecycle(s, [cov("gh:x", "2026-10-01T00:00:00Z")], policy).states.get("a")).toBe("missing");
    expect(deriveLifecycle(s, [cov("gh:x", "2026-10-05T00:00:00Z")], policy).states.get("a")).toBe("closed");
  });

  it("a board with no complete sweep infers nothing (a failed board can never close its postings)", () => {
    const r = deriveLifecycle([{ opportunityId: "a", boardId: "gh:dead", lastSeen: "2026-01-01T00:00:00Z" }], [cov("gh:alive", "2026-10-01T00:00:00Z")], policy);
    expect(r.states.get("a")).toBe("unknown");
  });

  it("refuses a mass disappearance as a bad response, judged against the PREVIOUS sweep", () => {
    const s = ["a", "b", "c", "d"].map((id) => ({ opportunityId: id, boardId: "gh:x", lastSeen: "2026-09-25T00:01:00Z" }));
    s.push({ opportunityId: "e", boardId: "gh:x", lastSeen: "2026-10-01T00:01:00Z" });
    const r = deriveLifecycle(s, [cov("gh:x", "2026-10-01T00:00:00Z", "2026-09-25T00:00:00Z")], policy);
    expect(r.refusedBoards).toEqual([{ boardId: "gh:x", wouldClose: 4, total: 5 }]);
    expect(r.states.get("a")).toBe("unknown");
    expect(r.states.get("e")).toBe("open");
  });

  it("old closures do not poison the guard forever", () => {
    const s = Array.from({ length: 20 }, (_, i) => ({ opportunityId: `old${i}`, boardId: "gh:x", lastSeen: "2026-01-01T00:00:00Z" }));
    s.push({ opportunityId: "live", boardId: "gh:x", lastSeen: "2026-10-01T00:01:00Z" });
    const r = deriveLifecycle(s, [cov("gh:x", "2026-10-01T00:00:00Z", "2026-09-30T00:00:00Z")], policy);
    expect(r.refusedBoards).toEqual([]);
    expect(r.states.get("old0")).toBe("closed");
  });

  it("an opportunity is open if ANY alias is open", () => {
    const r = deriveLifecycle(
      [
        { opportunityId: "a", boardId: "gh:x", lastSeen: "2026-01-01T00:00:00Z" },
        { opportunityId: "a", boardId: "lv:y", lastSeen: "2026-10-01T00:01:00Z" },
      ],
      [cov("gh:x", "2026-10-01T00:00:00Z"), cov("lv:y", "2026-10-01T00:00:00Z")],
      policy,
    );
    expect(r.states.get("a")).toBe("open");
  });
});

describe("resolution keeps every alias", () => {
  const prefs = testConfig().preferences;
  const raw = (boardId: string, externalId: string, title: string, desc = "x".repeat(300)): RawPosting => ({
    provider: boardId.split(":")[0]!,
    boardId,
    externalId,
    sourceUrl: `https://example.com/${externalId}`,
    applicationUrl: null,
    company: "Acme Inc.",
    title,
    locationRaw: "Remote - US",
    datePosted: null,
    descriptionHtml: "",
    descriptionPlain: desc,
  });
  const empty: ResolutionIndex = { byAlias: () => null, byDedupeKey: () => null, byContentKey: () => null, inGroup: () => [] };

  it("does not merge unrelated roles that share a template description", () => {
    const batch = [raw("greenhouse:acme", "1", "Senior Software Engineer"), raw("greenhouse:acme", "2", "Junior Designer")].map((r) => normalizePosting(r, prefs));
    const res = resolveBatch(batch, empty);
    expect(res[1]!.opportunityId).not.toBe(res[0]!.opportunityId);
  });

  it("does merge a repost under a lightly changed title with identical text", () => {
    const batch = [raw("greenhouse:acme", "1", "Senior Software Engineer, Platform"), raw("greenhouse:acme", "2", "Senior Platform Software Engineer (Backend)")].map((r) => normalizePosting(r, prefs));
    const res = resolveBatch(batch, empty);
    expect(res[1]).toMatchObject({ opportunityId: res[0]!.opportunityId, how: "content" });
  });

  it("collapses syndications in one batch, preserving level markers", () => {
    const batch = [
      raw("greenhouse:acme", "1", "Senior Engineer (Remote)"),
      raw("lever:acme", "9", "Senior Engineer"),
      raw("greenhouse:acme", "2", "Senior Engineer II", "y".repeat(300)),
    ].map((r) => normalizePosting(r, prefs));
    const res = resolveBatch(batch, empty);
    expect(res[1]!.opportunityId).toBe(res[0]!.opportunityId);
    expect(res[1]!.how).toBe("exact");
    expect(res[2]!.opportunityId).not.toBe(res[0]!.opportunityId);
  });

  it("an alias already known resolves to its opportunity", () => {
    const idx: ResolutionIndex = { ...empty, byAlias: (b, e) => (b === "greenhouse:acme" && e === "1" ? "opp-1" : null) };
    expect(resolveBatch([normalizePosting(raw("greenhouse:acme", "1", "Totally Renamed"), prefs)], idx)[0]).toMatchObject({ opportunityId: "opp-1", how: "alias" });
  });
});

describe("posting URLs from a board are untrusted", () => {
  // Found by a security review: a `javascript:` URL in a board payload became a live link in the
  // briefing (opened from disk, no CSP), and the URL `jr fill` navigates to.
  const prefs = testConfig().preferences;
  const base: RawPosting = {
    provider: "greenhouse",
    boardId: "greenhouse:acme",
    externalId: "1",
    sourceUrl: "https://example.com/1",
    applicationUrl: null,
    company: "Acme",
    title: "Senior Software Engineer",
    locationRaw: "Remote - US",
    datePosted: null,
    descriptionHtml: "",
    descriptionPlain: "x".repeat(300),
  };
  it("keeps only http(s) URLs", () => {
    const evil = normalizePosting({ ...base, applicationUrl: "javascript:alert(document.cookie)", sourceUrl: " JaVaScRiPt:alert(1)" }, prefs);
    expect(evil.applicationUrl).toBeNull();
    expect(evil.sourceUrl).toBe("");
    const data = normalizePosting({ ...base, applicationUrl: "data:text/html,<script>alert(1)</script>" }, prefs);
    expect(data.applicationUrl).toBeNull();
    const ok = normalizePosting({ ...base, applicationUrl: "https://boards.greenhouse.io/acme/jobs/1" }, prefs);
    expect(ok.applicationUrl).toBe("https://boards.greenhouse.io/acme/jobs/1");
  });
});
