import { describe, it, expect } from "vitest";
import { classifyAnalysisFailure, countsAgainstJob } from "../src/analysis/failures.js";
import { memoryRepo, seedJob } from "./helpers/db.js";
import type { AnalysisDiversity } from "../src/db/repo.js";
import type { NormalizedJob } from "../src/model/job.js";

const DIVERSITY: AnalysisDiversity = {
  perCompanyCap: 2, backfillCap: 3, coldAfter: 6, unexploredBonus: 8, coldPenalty: 15,
  freshDays: 21, freshBonus: 12, evergreenDays: null, maxAttempts: 2,
};

/**
 * JOB-34. A malformed response was refused correctly and then forgotten: the
 * job stayed eligible, was re-selected next pass, and was paid for again. The
 * reason existed only as a warn line in a console that had already scrolled.
 */
describe("classifyAnalysisFailure", () => {
  it("names truncation, which is otherwise indistinguishable from bad JSON", () => {
    // A response cut off at max_tokens IS invalid JSON. The two call for
    // opposite responses - raise a ceiling vs suspect the model - so they must
    // not land in the same bucket.
    expect(classifyAnalysisFailure("Response hit max_tokens (16000) and was truncated mid-object.")).toBe(
      "truncated",
    );
  });

  it("separates a schema failure from a parse failure", () => {
    expect(classifyAnalysisFailure("Response failed schema validation: lane: Invalid enum")).toBe("schema");
    expect(classifyAnalysisFailure('Response was not valid JSON: {"fit')).toBe("invalid_json");
    expect(classifyAnalysisFailure("No text block in response.")).toBe("invalid_json");
  });

  it("names a refusal", () => {
    expect(classifyAnalysisFailure("Model declined to analyze this posting.")).toBe("refusal");
  });

  it("names transport problems", () => {
    for (const m of [
      "429 status code (rate limit)",
      "Connection error: ECONNRESET",
      "Request timeout after 60s",
      "Overloaded",
      "authentication_error",
    ]) {
      expect(classifyAnalysisFailure(m)).toBe("api");
    }
  });

  it("recognises what the SDK actually throws, not what an API error sounds like", () => {
    // Verbatim from a real run with a mistyped --model. An earlier version of
    // this classifier filed it under "unknown", which SPENT one of the job's
    // two attempts - two such runs would have parked perfectly good jobs.
    const real =
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-does-not-exist-99"}}';
    expect(classifyAnalysisFailure(real)).toBe("api");
    expect(countsAgainstJob(classifyAnalysisFailure(real))).toBe(false);

    expect(classifyAnalysisFailure('529 {"type":"error","error":{"type":"overloaded_error"}}')).toBe("api");
    expect(classifyAnalysisFailure('400 {"type":"error","error":{"type":"invalid_request_error"}}')).toBe("api");
  });

  it("falls back to unknown rather than guessing", () => {
    expect(classifyAnalysisFailure("something nobody anticipated")).toBe("unknown");
  });
});

describe("countsAgainstJob", () => {
  it("does not spend a job's attempts on a network failure", () => {
    // The budget exists to stop re-buying a failure that is DETERMINISTIC for
    // a posting. Two dropped connections are not evidence about the posting,
    // and parking on them is the opposite of the intent.
    expect(countsAgainstJob("api")).toBe(false);
  });

  it("counts everything that is about the response itself", () => {
    for (const k of ["truncated", "schema", "invalid_json", "refusal", "unknown"] as const) {
      expect(countsAgainstJob(k)).toBe(true);
    }
  });
});

describe("recordAnalysisFailure", () => {
  it("increments and stores the reason", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { company: "Alpha" });
    expect(repo.recordAnalysisFailure(id, "truncated", "cut off")).toBe(1);
    expect(repo.recordAnalysisFailure(id, "schema", "bad lane")).toBe(2);
    const row = repo.analysisFailures()[0]!;
    expect(row.failures).toBe(2);
    expect(row.kind).toBe("schema");
    expect(row.reason).toBe("bad lane");
    expect(row.failedAt).toBeTruthy();
  });

  it("truncates a runaway reason rather than storing a whole response", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, {});
    repo.recordAnalysisFailure(id, "invalid_json", "x".repeat(5000));
    expect(repo.analysisFailures()[0]!.reason!.length).toBe(500);
  });

  it("lists nothing when nothing has failed", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, {});
    expect(repo.analysisFailures()).toEqual([]);
  });
});

describe("a job that keeps failing is not re-bought", () => {
  it("stops being offered once it reaches the attempt limit", () => {
    const { repo, db } = memoryRepo();
    const bad = seedJob(db, { id: "bad", company: "Alpha", applicationRoi: 99, fitScore: 99 });
    seedJob(db, { id: "good", company: "Beta", applicationRoi: 10, fitScore: 10 });

    repo.recordAnalysisFailure(bad, "schema", "first");
    // One failure: still eligible, because the rate is a steady few percent and
    // one retry is worth about five cents.
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).toContain("bad");

    repo.recordAnalysisFailure(bad, "schema", "second");
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).toEqual(["good"]);
  });

  it("keeps offering everything when the limit is off", () => {
    const { repo, db } = memoryRepo();
    const bad = seedJob(db, { id: "bad", applicationRoi: 99, fitScore: 99 });
    repo.recordAnalysisFailure(bad, "schema", "a");
    repo.recordAnalysisFailure(bad, "schema", "b");
    expect(repo.needingAnalysis(10, { ...DIVERSITY, maxAttempts: null })).toHaveLength(1);
  });
});

describe("a changed posting earns fresh attempts", () => {
  /** A minimal NormalizedJob, so this exercises repo.upsert rather than hand-written SQL. */
  function normalized(over: Partial<NormalizedJob> = {}): NormalizedJob {
    const now = new Date().toISOString();
    return {
      id: "j1", externalId: "ext-1", source: "greenhouse", ats: "greenhouse",
      sourceUrl: "https://example.test/j1", applicationUrl: null,
      company: "Alpha", title: "Senior Engineer", location: "Remote",
      remoteStatus: "remote", employmentType: "full_time", seniority: "senior",
      datePosted: now, dateDiscovered: now,
      salaryMin: null, salaryMax: null, salaryCurrency: "USD", salaryPeriod: null,
      descriptionRaw: "original", descriptionClean: "original", descriptionHash: "hash-a",
      department: null, team: null, companySizeEstimate: null, companyStage: null, industry: null,
      ...over,
    } as NormalizedJob;
  }

  it("clears the failure record when the description changes", () => {
    // A posting whose description changed is a different input. Whatever made
    // the model choke on the old text may simply be gone, so keeping the count
    // would park a job for a reason that no longer exists.
    const { repo, db } = memoryRepo();
    const job = normalized();
    repo.upsert(job, "dedupe-j1");
    // Scoring outputs, set directly: needingAnalysis gates on them and they are
    // not what this test is about.
    db.prepare("UPDATE jobs SET filter_passed = 1, fit_score = 70, application_roi = 70 WHERE id = ?").run(job.id);

    repo.recordAnalysisFailure(job.id, "truncated", "cut off");
    repo.recordAnalysisFailure(job.id, "truncated", "cut off again");
    expect(repo.analysisFailures()[0]!.failures).toBe(2);
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).not.toContain("j1");

    // Same posting, new text. This is the real upsert path, not a hand-written
    // UPDATE - a test that fakes the mechanism it claims to check is worse than
    // no test.
    const outcome = repo.upsert(normalized({ descriptionClean: "rewritten", descriptionHash: "hash-b" }), "dedupe-j1");
    expect(outcome.descriptionChanged).toBe(true);

    expect(repo.analysisFailures()).toEqual([]);
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).toContain("j1");
  });

  it("leaves the failure record alone when the posting is merely re-seen", () => {
    // Only a CHANGED description earns fresh attempts. An unchanged re-sighting
    // must not quietly reset the counter, or a job would be re-bought on every
    // sweep and the limit would mean nothing.
    const { repo, db } = memoryRepo();
    const job = normalized();
    repo.upsert(job, "dedupe-j1");
    db.prepare("UPDATE jobs SET filter_passed = 1, fit_score = 70, application_roi = 70 WHERE id = ?").run(job.id);
    repo.recordAnalysisFailure(job.id, "schema", "bad");
    repo.recordAnalysisFailure(job.id, "schema", "bad again");

    repo.upsert(normalized(), "dedupe-j1");

    expect(repo.analysisFailures()[0]!.failures).toBe(2);
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).not.toContain("j1");
  });
});

describe("an API failure is visible but does not spend an attempt", () => {
  it("records the reason without moving the counter", () => {
    // The bug this pins: with a single counter, the log said "not counted
    // against the job" while needingAnalysis counted it anyway. A couple of
    // dropped connections would have parked a perfectly analysable job while
    // insisting it had not.
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { id: "j1", company: "Alpha", applicationRoi: 90, fitScore: 90 });

    expect(repo.recordAnalysisFailure(id, "api", "404 not_found_error", false)).toBe(0);
    expect(repo.recordAnalysisFailure(id, "api", "529 overloaded_error", false)).toBe(0);
    expect(repo.recordAnalysisFailure(id, "api", "timeout", false)).toBe(0);

    // Three API failures, still fully eligible.
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).toContain("j1");

    // ...and still visible, which is the other half of the point.
    const row = repo.analysisFailures()[0]!;
    expect(row.kind).toBe("api");
    expect(row.failures).toBe(0);
  });

  it("mixes counted and uncounted correctly", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { id: "j1", applicationRoi: 90, fitScore: 90 });
    repo.recordAnalysisFailure(id, "api", "timeout", false);
    expect(repo.recordAnalysisFailure(id, "truncated", "cut off", true)).toBe(1);
    repo.recordAnalysisFailure(id, "api", "timeout again", false);
    expect(repo.recordAnalysisFailure(id, "schema", "bad", true)).toBe(2);
    expect(repo.needingAnalysis(10, DIVERSITY).map((j) => j.id)).not.toContain("j1");
  });
});
