import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { reconcileWithAnalysis } from "../src/pipeline/score.js";
import { runScoring } from "../src/pipeline/rescore.js";
import { normalizeJob } from "../src/pipeline/normalize.js";
import { buildSystemPrompt } from "../src/analysis/prompt.js";
import { loadProfile, resetConfigCache, PROJECT_ROOT } from "../src/config/load.js";
import { memoryRepo, matchingIdentityHashes } from "./helpers/db.js";
import { sha256 } from "../src/lib/hash.js";
import type { Analysis, ScoreResult } from "../src/model/job.js";
import type { CareerProfile } from "../src/config/schema.js";
import type { SourceJob } from "../src/sources/types.js";

function score(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    fitScore: 96,
    lane: "ai_product",
    laneLabel: "AI-enabled Product Engineering",
    compensationScore: 58,
    compensationConfidence: "UNKNOWN",
    competitionScore: 40,
    applicationRoi: 85,
    positiveSignals: ["typescript", "agentic"],
    negativeSignals: [],
    combos: ["LLM product + TypeScript"],
    explanation: "Fit = 96",
    priority: "A",
    ...over,
  };
}

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    fitScore: 33,
    applicationRoi: 12,
    lane: "ai_product",
    recommendation: "skip",
    strengths: [],
    risks: [],
    missingRequirements: [],
    differentiation: "none identified",
    salaryClassification: "unknown",
    salaryReasoning: "",
    interviewProbability: 6,
    competitionEstimate: "very_high",
    outreachTargets: [],
    reasoningSummary: "Sr. Staff role requiring org-wide technical leadership; two levels above.",
    ...over,
  };
}

describe("reconcileWithAnalysis", () => {
  it("demotes a keyword-inflated job the analysis rejected", () => {
    // The real case this exists for: keyword engine said 96/Priority A,
    // the analysis read the seniority requirements and said skip.
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.priority).toBe("D");
    expect(out.fitScore).toBe(33);
    expect(out.applicationRoi).toBeLessThan(40);
  });

  it("maps each recommendation to the right priority", () => {
    const cases: [Analysis["recommendation"], string][] = [
      ["apply_and_outreach", "A"],
      ["apply", "B"],
      ["network_or_watch", "C"],
      ["skip", "D"],
    ];
    for (const [recommendation, expected] of cases) {
      expect(reconcileWithAnalysis(score(), analysis({ recommendation })).priority).toBe(expected);
    }
  });

  it("promotes a job the keyword engine underrated", () => {
    const out = reconcileWithAnalysis(
      score({ fitScore: 55, applicationRoi: 40, priority: "C" }),
      analysis({ fitScore: 88, applicationRoi: 76, recommendation: "apply_and_outreach" }),
    );
    expect(out.priority).toBe("A");
    expect(out.fitScore).toBe(88);
    expect(out.applicationRoi).toBeGreaterThan(60);
  });

  it("records the override in the explanation when the two disagree sharply", () => {
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.explanation).toMatch(/Analysis overrode the keyword engine/);
    expect(out.explanation).toMatch(/96 -> 33/);
  });

  it("notes agreement when the two are close", () => {
    const out = reconcileWithAnalysis(
      score({ fitScore: 80 }),
      analysis({ fitScore: 84, recommendation: "apply" }),
    );
    expect(out.explanation).toMatch(/Analysis agrees/);
  });

  it("blends ROI toward the analysis without discarding the deterministic signal", () => {
    // Deterministic ROI carries competition and recency data the model cannot see.
    const out = reconcileWithAnalysis(
      score({ applicationRoi: 100 }),
      analysis({ applicationRoi: 0, recommendation: "apply" }),
    );
    expect(out.applicationRoi).toBe(30); // 0*0.7 + 100*0.3
  });

  it("preserves lane and signals from the deterministic pass", () => {
    const out = reconcileWithAnalysis(score(), analysis());
    expect(out.combos).toEqual(["LLM product + TypeScript"]);
    expect(out.positiveSignals).toEqual(["typescript", "agentic"]);
  });
});

/**
 * JOB-51. `runScoring`'s reconciliation branch (`src/pipeline/rescore.ts`)
 * must not trust an attached `analysis_json` that no longer describes the
 * job it is attached to. These exercise the REAL gate - `runScoring` itself,
 * against the shipped `career-profile.yaml` - rather than `reconcileWithAnalysis`
 * in isolation, because the bug was in the caller deciding whether to call it,
 * not in the merge function above.
 */
describe("runScoring excludes a stale attached analysis from reconciliation", () => {
  let profile: CareerProfile;

  beforeAll(() => {
    resetConfigCache();
    profile = loadProfile(resolve(PROJECT_ROOT, "config", "career-profile.yaml"));
  });

  /** A posting known to pass the shipped filters (see tests/pipeline.test.ts). */
  function sourceJob(over: Partial<SourceJob> = {}): SourceJob {
    return {
      source: "greenhouse",
      board: "greenhouse:acme",
      ats: "greenhouse",
      externalId: "test:1",
      sourceUrl: "https://example.com/job/1",
      applicationUrl: "https://example.com/job/1/apply",
      company: "Acme",
      title: "Senior Software Engineer",
      locationRaw: "Remote - US",
      datePosted: new Date().toISOString(),
      descriptionHtml: "<p>Build things with TypeScript and React.</p>",
      department: "Engineering",
      team: null,
      salary: null,
      ...over,
    };
  }

  /**
   * A full, schema-valid Analysis the reconciliation branch would trust.
   * `apply_and_outreach` -> priority A (`reconcileWithAnalysis`), which the
   * deterministic pass alone never reaches here - so a Priority-A row is
   * unambiguous proof reconciliation actually ran, not merely that nothing
   * downstream noticed.
   */
  function fullAnalysis(over: Partial<Analysis> = {}): Analysis {
    return {
      fitScore: 92,
      applicationRoi: 88,
      lane: "full_stack",
      recommendation: "apply_and_outreach",
      strengths: ["Exact stack match"],
      risks: [],
      missingRequirements: [],
      differentiation: "Unusually strong overlap.",
      salaryClassification: "unknown",
      salaryReasoning: "",
      interviewProbability: 70,
      competitionEstimate: "moderate",
      outreachTargets: ["Engineering Manager"],
      reasoningSummary: "Unusually strong match for this exact posting.",
      ...over,
    };
  }

  /**
   * Attach a FRESH analysis - identity snapshot matches the job's current
   * row exactly, AND the real evidence hash for `profile` (not the generic
   * `TEST_EVIDENCE_HASH` - this profile is the real career-profile.yaml, and
   * `runScoring` computes `evidenceHash` from it, not from a test fixture).
   */
  function attachFreshAnalysis(
    repo: ReturnType<typeof memoryRepo>["repo"],
    db: ReturnType<typeof memoryRepo>["db"],
    id: string,
    a: Analysis,
  ): void {
    const evidenceHash = sha256(buildSystemPrompt(profile));
    repo.saveAnalysis(id, a, "claude-opus-5", matchingIdentityHashes(db, id, evidenceHash));
  }

  // At least MIN_CALIBRATION_SAMPLE (8) analyzed pairs are needed for
  // calibration.usable, which is what makes the projection branch actually
  // fire for the stale job below rather than leaving it merely un-reconciled.
  function seedCalibrationDonors(
    repo: ReturnType<typeof memoryRepo>["repo"],
    db: ReturnType<typeof memoryRepo>["db"],
  ): void {
    for (let i = 0; i < 8; i += 1) {
      const job = normalizeJob(sourceJob({ externalId: `donor:${i}`, company: `Donor${i}` }), profile);
      repo.upsert(job, `donor-${i}`);
      attachFreshAnalysis(repo, db, job.id, fullAnalysis({ fitScore: 30 + i, applicationRoi: 25 + i }));
    }
  }

  it("reconciles normally when the attached analysis still matches the job", () => {
    const { repo, db } = memoryRepo();
    seedCalibrationDonors(repo, db);
    const job = normalizeJob(sourceJob({ externalId: "target", company: "TargetCo" }), profile);
    repo.upsert(job, "target-dedupe");
    attachFreshAnalysis(repo, db, job.id, fullAnalysis());

    const summary = runScoring(repo, profile, db);

    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    expect(summary.staleAnalysis).toBe(0);
    const row = db.prepare("SELECT score_confidence, priority FROM jobs WHERE id = ?").get(job.id) as {
      score_confidence: string;
      priority: string;
    };
    expect(row.score_confidence).toBe("analyzed");
    // Priority A only comes from `apply_and_outreach` via reconciliation -
    // the deterministic pass alone never reaches it here.
    expect(row.priority).toBe("A");
  });

  it("excludes a stale attached analysis and projects instead, once the title has moved", () => {
    const { repo, db } = memoryRepo();
    seedCalibrationDonors(repo, db);
    const job = normalizeJob(sourceJob({ externalId: "target", company: "TargetCo" }), profile);
    repo.upsert(job, "target-dedupe");
    attachFreshAnalysis(repo, db, job.id, fullAnalysis());

    // upsert()'s own bug: a re-title overwrites the column unconditionally,
    // with no invalidation, while the description (and material_hash) never
    // moves. Simulated directly here for the same reason
    // tests/analysis.selection.test.ts uses repo.upsert with a new title -
    // this IS that mechanism.
    repo.upsert(normalizeJob(sourceJob({ externalId: "target", company: "TargetCo", title: "Director of Engineering" }), profile), "target-dedupe");

    const summary = runScoring(repo, profile, db);

    expect(summary.staleAnalysis).toBe(1);
    const row = db.prepare("SELECT score_confidence, score_explanation, priority FROM jobs WHERE id = ?").get(
      job.id,
    ) as { score_confidence: string; score_explanation: string; priority: string };
    // Projected, not "analyzed" - the stale verdict was excluded, and with
    // calibration usable (8 donors above) the job falls into the SAME
    // projection branch a never-analyzed job would.
    expect(row.score_confidence).toBe("projected");
    expect(row.score_explanation).toMatch(/Not yet analyzed/);
    // Never A: a projected job cannot reach Priority A (src/pipeline/rescore.ts
    // `reprioritize`) - which the stale `apply_and_outreach` verdict would
    // have granted had it been (wrongly) trusted.
    expect(row.priority).not.toBe("A");
  });

  it("goes stale on a schema mismatch alone, with every identity input unchanged", () => {
    const { repo, db } = memoryRepo();
    seedCalibrationDonors(repo, db);
    const job = normalizeJob(sourceJob({ externalId: "target", company: "TargetCo" }), profile);
    repo.upsert(job, "target-dedupe");
    // `lane: "not_a_real_lane"` is not one of the profile's configured lanes
    // (nor "other"), so `analysisSchemaFor` rejects it on re-validation - even
    // though title/location/employment/compensation never moved.
    attachFreshAnalysis(repo, db, job.id, fullAnalysis({ lane: "not_a_real_lane" }));

    const summary = runScoring(repo, profile, db);

    expect(summary.staleAnalysis).toBe(1);
    // The 8 donors (unaffected) still reconcile normally - staleness is
    // per-job, not a run-wide switch.
    expect(summary.reconciled).toBe(8);
    const row = db.prepare("SELECT priority FROM jobs WHERE id = ?").get(job.id) as { priority: string };
    expect(row.priority).not.toBe("A");
  });
});
