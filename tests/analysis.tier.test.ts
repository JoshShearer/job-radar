import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { memoryRepo, saveAnalysisFresh } from "./helpers/db.js";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { applyColumnMigrations } from "../src/db/index.js";
import { JobRepo } from "../src/db/repo.js";
import { triageOnlyAnalysis, type Analysis, type TriageVerdict } from "../src/model/job.js";
import { describePriorAnalysis } from "../src/analysis/prepare.js";
import { cachedAnalysisFor, evidenceVersion } from "../src/analysis/analyzer.js";
import type { AnalysisIdentity } from "../src/analysis/identity.js";
import { buildDailyReport } from "../src/report/daily.js";
import { seedJob } from "./helpers/db.js";
import type { CareerProfile, SourcesConfig } from "../src/config/schema.js";
import type { EnrichedJob } from "../src/model/job.js";

/** A fixed identity for tests that only care about tier/material/evidence separation. */
const IDENTITY: AnalysisIdentity = {
  titleHash: "title-1",
  locationHash: "loc-1",
  employmentHash: "emp-1",
  compensationHash: "comp-1",
  evidenceHash: "evidence-1",
};

/**
 * The three defects in JOB-40 are all latent until `two_stage` is switched on,
 * so nothing in the existing suite exercised them. These tests make the
 * two-stage path fail loudly rather than quietly, before it is enabled.
 */

function verdict(over: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    fitScore: 60,
    applicationRoi: 50,
    lane: "frontend",
    recommendation: "network_or_watch",
    salaryClassification: "yellow",
    reasoningSummary: "A sentence.",
    ...over,
  };
}

function fullAnalysis(over: Partial<Analysis> = {}): Analysis {
  return {
    ...triageOnlyAnalysis(verdict()),
    strengths: ["Ships React at scale"],
    risks: ["Backend depth"],
    missingRequirements: ["Kubernetes"],
    differentiation: "Built the design system.",
    salaryReasoning: "Series C, band is plausible.",
    interviewProbability: 45,
    competitionEstimate: "high",
    outreachTargets: ["Head of Engineering"],
    ...over,
  };
}

describe("the cache key separates the two tiers", () => {
  const { repo } = memoryRepo();
  const args = ["material-hash", "Staff Engineer", "Acme", "claude-opus-5"] as const;

  it("gives a triage stub and a dossier different addresses", () => {
    // Defect 1: they used to collide, so the stub was returned to every later
    // read forever - including one that was trying to buy the dossier.
    const triage = repo.cacheKey(...args, "evidence-v1", "triage", IDENTITY);
    const full = repo.cacheKey(...args, "evidence-v1", "full", IDENTITY);
    expect(triage).not.toBe(full);
  });

  it("still separates on every other input", () => {
    const base = repo.cacheKey(...args, "evidence-v1", "full", IDENTITY);
    expect(
      repo.cacheKey("other-hash", "Staff Engineer", "Acme", "claude-opus-5", "evidence-v1", "full", IDENTITY),
    ).not.toBe(base);
    expect(repo.cacheKey(...args, "evidence-v2", "full", IDENTITY)).not.toBe(base);
  });

  it("separates on location/employment/compensation too (JOB-51)", () => {
    // Without this, a job made re-eligible by the widened `needingAnalysis`
    // (title/location/employment/compensation moved) would still be served
    // the OLD cache row on re-analysis, keyed on the OLD values - the fix to
    // eligibility would be undone by the cache the moment a paid call landed.
    const base = repo.cacheKey(...args, "evidence-v1", "full", IDENTITY);
    expect(repo.cacheKey(...args, "evidence-v1", "full", { ...IDENTITY, locationHash: "loc-2" })).not.toBe(base);
    expect(repo.cacheKey(...args, "evidence-v1", "full", { ...IDENTITY, employmentHash: "emp-2" })).not.toBe(base);
    expect(repo.cacheKey(...args, "evidence-v1", "full", { ...IDENTITY, compensationHash: "comp-2" })).not.toBe(
      base,
    );
  });

  it("stores and returns each tier independently", () => {
    const { repo: r } = memoryRepo();
    const stub = triageOnlyAnalysis(verdict());
    const dossier = fullAnalysis();
    const kTriage = r.cacheKey(...args, "p", "triage", IDENTITY);
    const kFull = r.cacheKey(...args, "p", "full", IDENTITY);

    r.putCachedAnalysis(kTriage, "material-hash", "claude-opus-5", stub, {}, "triage");
    r.putCachedAnalysis(kFull, "material-hash", "claude-opus-5", dossier, {}, "full");

    expect(r.getCachedAnalysis(kTriage)!.strengths).toEqual([]);
    expect(r.getCachedAnalysis(kFull)!.strengths).toEqual(["Ships React at scale"]);
  });
});

describe("the tier column", () => {
  it("reads back as full for a row written before the column existed", () => {
    // Provable rather than assumed: every pre-existing row predates the
    // two-stage flag, and lifetime SUM(stats_json.triageOnly) over `runs` is 0.
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    // Simulate the old schema by dropping the column, then migrating forward.
    db.exec("ALTER TABLE analysis_cache DROP COLUMN tier");
    db.prepare(
      `INSERT INTO analysis_cache (cache_key, description_hash, model, analysis_json, created_at)
       VALUES ('k', 'd', 'm', '{}', '2026-08-01T00:00:00Z')`,
    ).run();

    applyColumnMigrations(db);

    const row = db.prepare("SELECT tier FROM analysis_cache WHERE cache_key = 'k'").get() as { tier: string };
    expect(row.tier).toBe("full");
    new JobRepo(db);
  });
});

describe("what the application pack prompt is told about the analysis", () => {
  it("says it has no dossier instead of asserting empty strengths", () => {
    // Defect 3: the two-way form read the empty dossier fields out as fact,
    // telling the model "Strengths:" with nothing after it - in the prompt that
    // writes a document a human sends.
    const text = describePriorAnalysis(triageOnlyAnalysis(verdict()));
    expect(text).toContain("No dossier yet - triage only");
    expect(text).not.toContain("Strengths:");
    expect(text).not.toContain("Risks:");
    expect(text).not.toContain("Missing:");
    // The verdict it DOES have is still passed through.
    expect(text).toContain("network_or_watch");
  });

  it("passes the dossier through when there is one", () => {
    const text = describePriorAnalysis(fullAnalysis());
    expect(text).toContain("Ships React at scale");
    expect(text).toContain("Risks: Backend depth");
    expect(text).not.toContain("No dossier yet");
  });

  it("says there is no analysis at all when there is none", () => {
    expect(describePriorAnalysis(null)).toContain("No prior analysis");
  });
});

describe("cachedAnalysisFor decides what a cached row is allowed to answer", () => {
  // A real EnrichedJob always carries these arrays; the cache key is derived
  // from the same evidence the model is shown, so the fixture has to be honest
  // about that rather than casting a half-built object.
  const job = {
    materialHash: "m1",
    descriptionHash: "d1",
    title: "Staff Engineer",
    company: "Acme",
    lane: "frontend",
    compensationBand: "target",
    compensationNote: "",
    positiveSignals: [],
    negativeSignals: [],
    fitScore: 60,
    applicationRoi: 50,
  } as unknown as EnrichedJob;
  const MODEL = "claude-opus-5";
  const SYSTEM = "system prompt v1";
  // `network_or_watch` earns a dossier; `skip` at low fit does not.
  const policy = { recommendations: ["apply", "apply_and_outreach", "network_or_watch"], minFit: 70 };

  const store = (tier: "triage" | "full", analysis: Analysis) => {
    const { repo } = memoryRepo();
    const key = repo.cacheKey("m1", "Staff Engineer", "Acme", MODEL, evidenceVersion(SYSTEM, job), tier, IDENTITY);
    repo.putCachedAnalysis(key, "m1", MODEL, analysis, {}, tier);
    return repo;
  };

  it("serves a stored dossier to either mode", () => {
    for (const twoStage of [false, true]) {
      const repo = store("full", fullAnalysis());
      expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, twoStage, policy, IDENTITY)?.strengths).toEqual([
        "Ships React at scale",
      ]);
    }
  });

  it("refuses to serve a triage stub to a single-stage pass", () => {
    // Single-stage wants a dossier and nothing less. Serving the stub is
    // exactly the bug: the pass would report a cache hit and never buy one.
    const repo = store("triage", triageOnlyAnalysis(verdict({ recommendation: "skip", fitScore: 20 })));
    expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, false, policy, IDENTITY)).toBeNull();
  });

  it("serves a stub to a two-stage pass when the stub does not earn a dossier", () => {
    // This is the free case: the stored verdict already answers the only
    // question this pass would have asked.
    const repo = store("triage", triageOnlyAnalysis(verdict({ recommendation: "skip", fitScore: 20 })));
    expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, true, policy, IDENTITY)?.recommendation).toBe("skip");
  });

  it("treats a stub that DOES earn a dossier as a miss, so the stub never becomes permanent", () => {
    // The defect in one line: without this the stub is served forever to a
    // pass whose whole purpose was to buy the dossier it is standing in for.
    const repo = store("triage", triageOnlyAnalysis(verdict({ recommendation: "network_or_watch" })));
    expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, true, policy, IDENTITY)).toBeNull();
  });

  it("routes a stub on fit as well as recommendation, matching deservesDossier", () => {
    const repo = store("triage", triageOnlyAnalysis(verdict({ recommendation: "skip", fitScore: 85 })));
    expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, true, policy, IDENTITY)).toBeNull();
  });

  it("is a miss when nothing is stored at all", () => {
    const { repo } = memoryRepo();
    expect(cachedAnalysisFor(repo, job, MODEL, SYSTEM, true, policy, IDENTITY)).toBeNull();
  });
});

describe("no value the analyst did not produce is rendered as though it did", () => {
  const profile = {
    scoring: { report_threshold: 0 },
    report: { max_total: 10, max_priority_a: 5, max_priority_b: 5, max_priority_c: 5 },
  } as unknown as CareerProfile;
  const sources = { watchlist: [], sources: { remoteok: { enabled: false } } } as unknown as SourcesConfig;

  function briefingFor(analysis: Analysis): string {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { company: "Acme", title: "Staff Engineer", fitScore: 80 });
    saveAnalysisFresh(repo, db, id, analysis, "claude-opus-5");
    return buildDailyReport({ repo, profile, sources }).markdown;
  }

  it("says not assessed rather than 0% for a triage-only job", () => {
    // Defect 2: with the flag on, ~80% of analyzed jobs would have displayed
    // "Interview probability 0% (competition: moderate)" as an analyst
    // judgement. Nobody produced that 0.
    const md = briefingFor(triageOnlyAnalysis(verdict()));
    expect(md).toContain("not assessed (triage only)");
    expect(md).not.toContain("0% (competition");
    expect(md).not.toContain("competition: moderate");
  });

  it("still prints the real numbers when the analyst produced them", () => {
    const md = briefingFor(fullAnalysis());
    expect(md).toContain("45% (competition: high)");
    expect(md).not.toContain("not assessed");
  });
});
