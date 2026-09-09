import { describe, it, expect } from "vitest";
import {
  dedupeKey,
  dedupeBatch,
  normalizeTitleForDedupe,
  tokenSetSimilarity,
  locationBucket,
} from "../src/pipeline/dedupe.js";
import type { NormalizedJob } from "../src/model/job.js";
import { sha256 } from "../src/lib/hash.js";

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
  const description = over.descriptionClean ?? "We are hiring a senior engineer to build things.";
  return {
    id: over.id ?? Math.random().toString(36).slice(2, 14),
    externalId: over.externalId ?? "ext-1",
    source: over.source ?? "greenhouse",
    ats: over.ats ?? "greenhouse",
    sourceUrl: over.sourceUrl ?? "https://example.com/job/1",
    applicationUrl: null,
    company: over.company ?? "Acme Inc",
    title: over.title ?? "Senior Software Engineer",
    location: over.location ?? "Remote - US",
    remoteStatus: over.remoteStatus ?? "remote",
    employmentType: "full_time",
    seniority: "senior",
    datePosted: null,
    dateDiscovered: new Date().toISOString(),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "USD",
    salaryPeriod: null,
    descriptionClean: description,
    descriptionHash: over.descriptionHash ?? sha256(description),
    department: null,
    team: null,
    companySizeEstimate: null,
    companyStage: null,
    industry: null,
    ...over,
  };
}

describe("normalizeTitleForDedupe", () => {
  it("strips remote/location noise", () => {
    expect(normalizeTitleForDedupe("Senior Software Engineer (Remote)")).toBe("senior software engineer");
    expect(normalizeTitleForDedupe("Senior Software Engineer - Remote, US")).toBe("senior software engineer");
  });

  it("strips requisition numbers", () => {
    expect(normalizeTitleForDedupe("Senior Engineer Req #12345")).toBe("senior engineer");
  });

  it("preserves level markers, which are real distinctions", () => {
    expect(normalizeTitleForDedupe("Software Engineer II")).not.toBe(
      normalizeTitleForDedupe("Software Engineer III"),
    );
  });

  it("drops corporate suffixes in company names", () => {
    expect(dedupeKey(job({ company: "Acme, Inc." }))).toBe(dedupeKey(job({ company: "Acme" })));
  });
});

describe("locationBucket", () => {
  it("collapses all remote phrasings to one bucket", () => {
    expect(locationBucket({ remoteStatus: "remote", location: "Remote - US" })).toBe("remote");
    expect(locationBucket({ remoteStatus: "remote", location: "Remote (Worldwide)" })).toBe("remote");
  });

  it("keeps distinct cities distinct", () => {
    expect(locationBucket({ remoteStatus: "onsite", location: "Austin, TX" })).not.toBe(
      locationBucket({ remoteStatus: "onsite", location: "Seattle, WA" }),
    );
  });
});

describe("tokenSetSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(tokenSetSimilarity("Senior Engineer", "Senior Engineer")).toBe(1);
  });
  it("scores near-identical titles high", () => {
    expect(tokenSetSimilarity("Senior Software Engineer", "Senior Software Engineer")).toBeGreaterThan(0.9);
  });
  it("scores unrelated titles low", () => {
    expect(tokenSetSimilarity("Senior Software Engineer", "Account Executive")).toBeLessThan(0.2);
  });
});

describe("dedupeBatch", () => {
  it("collapses the same job syndicated across two sources", () => {
    const a = job({ id: "a", source: "greenhouse", title: "Senior Software Engineer" });
    const b = job({ id: "b", source: "remoteok", title: "Senior Software Engineer (Remote)" });
    const { unique, duplicates } = dedupeBatch([a, b]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.mergedIntoId).toBe("a");
  });

  it("keeps genuinely different roles at the same company", () => {
    const a = job({ id: "a", title: "Senior Software Engineer" });
    const b = job({ id: "b", title: "Senior Growth Engineer" });
    const { unique } = dedupeBatch([a, b]);
    expect(unique).toHaveLength(2);
  });

  it("keeps the same title at different companies", () => {
    const a = job({ id: "a", company: "Acme" });
    const b = job({ id: "b", company: "Globex" });
    expect(dedupeBatch([a, b]).unique).toHaveLength(2);
  });

  it("collapses by identical description hash even when titles differ", () => {
    const shared = "x".repeat(400);
    const a = job({ id: "a", title: "Senior Engineer", descriptionClean: shared, descriptionHash: sha256(shared) });
    const b = job({
      id: "b",
      title: "Sr. Engineer, Platform",
      descriptionClean: shared,
      descriptionHash: sha256(shared),
    });
    const { unique, duplicates } = dedupeBatch([a, b]);
    expect(unique).toHaveLength(1);
    expect(duplicates[0]!.how).toBe("content");
  });

  it("does not collapse short descriptions that happen to match", () => {
    // Short boilerplate descriptions collide easily; requiring length prevents
    // two real roles being merged because both say "Come join us!".
    const short = "Come join us!";
    const a = job({ id: "a", title: "Senior Engineer", descriptionClean: short, descriptionHash: sha256(short) });
    const b = job({ id: "b", title: "Staff Designer", descriptionClean: short, descriptionHash: sha256(short) });
    expect(dedupeBatch([a, b]).unique).toHaveLength(2);
  });

  it("keeps different levels of the same role separate", () => {
    const a = job({ id: "a", title: "Software Engineer II" });
    const b = job({ id: "b", title: "Software Engineer III" });
    expect(dedupeBatch([a, b]).unique).toHaveLength(2);
  });

  it("is stable: running twice on the same input gives the same result", () => {
    const jobs = [job({ id: "a" }), job({ id: "b", title: "Growth Engineer" }), job({ id: "c" })];
    const first = dedupeBatch(jobs);
    const second = dedupeBatch(jobs);
    expect(first.unique.map((u) => u.job.id)).toEqual(second.unique.map((u) => u.job.id));
  });
});
