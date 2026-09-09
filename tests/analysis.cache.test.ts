import { describe, it, expect } from "vitest";
import { memoryRepo } from "./helpers/db.js";
import { materialHash } from "../src/lib/hash.js";
import { buildDeterministicNote, evidenceVersion } from "../src/analysis/analyzer.js";
import type { EnrichedJob, NormalizedJob } from "../src/model/job.js";

/**
 * 430 cache rows, 3 lifetime hits. Two independent bugs, and they fail
 * differently, so they are pinned separately:
 *
 * (a) the key hashed the WHOLE profile, so any edit to career-profile.yaml
 *     invalidated everything - and that file is edited constantly.
 * (b) the key hashed the description byte-for-byte, so a board re-rendering
 *     the same words threw away an analysis that had been paid for.
 */

const SYSTEM = "You are a careers analyst. Rules: ...";

function job(over: Partial<EnrichedJob> = {}): EnrichedJob {
  return {
    id: "j1",
    title: "Staff Engineer",
    company: "Acme",
    lane: "frontend",
    fitScore: 62,
    applicationRoi: 55,
    compensationBand: "target",
    compensationNote: "160-180k plausible",
    positiveSignals: ["react", "typescript"],
    negativeSignals: ["on-site"],
    descriptionClean: "We need a frontend leader.",
    descriptionHash: "byte-1",
    materialHash: "material-1",
    ...over,
  } as unknown as EnrichedJob;
}

describe("(a) the key follows the evidence, not the whole profile", () => {
  it("does not change when only the calibrated fit and ROI move", () => {
    // THE CENTRAL ONE. `project()` rewrites exactly these two from the observed
    // calibration on every scoring run, and the calibration moves whenever a
    // new analysis lands - so they churn for every UN-ANALYZED job, which is
    // precisely the population the cache serves. Hashing them would invalidate
    // the cache continuously, worse than the profileVersion this replaces.
    const before = evidenceVersion(SYSTEM, job({ fitScore: 62, applicationRoi: 55 }));
    const after = evidenceVersion(SYSTEM, job({ fitScore: 71, applicationRoi: 80 }));
    expect(after).toBe(before);
  });

  it("changes when a matched signal changes", () => {
    // The signals reach the model through the USER turn, so hashing only the
    // system prompt would silently reuse an analysis computed under different
    // evidence.
    const before = evidenceVersion(SYSTEM, job());
    const after = evidenceVersion(SYSTEM, job({ positiveSignals: ["react", "typescript", "kubernetes"] }));
    expect(after).not.toBe(before);
  });

  it("changes when the compensation band changes", () => {
    expect(evidenceVersion(SYSTEM, job({ compensationBand: "below" }))).not.toBe(evidenceVersion(SYSTEM, job()));
  });

  it("changes when a concern changes", () => {
    expect(evidenceVersion(SYSTEM, job({ negativeSignals: [] }))).not.toBe(evidenceVersion(SYSTEM, job()));
  });

  it("changes when the lane changes", () => {
    expect(evidenceVersion(SYSTEM, job({ lane: "solutions_eng" }))).not.toBe(evidenceVersion(SYSTEM, job()));
  });

  it("changes when the system prompt changes", () => {
    expect(evidenceVersion("different rules", job())).not.toBe(evidenceVersion(SYSTEM, job()));
  });
});

describe("the note builder returns both halves from one definition", () => {
  it("shows fit and ROI to the model but keeps them out of the stable half", () => {
    const note = buildDeterministicNote(job());
    expect(note.full).toContain("Fit score: 62");
    expect(note.full).toContain("Application ROI: 55");
    expect(note.stable).not.toContain("62");
    expect(note.stable).not.toContain("Application ROI");
    // The lane is stable and must survive into the key.
    expect(note.stable).toContain("frontend");
  });

  it("applies the same truncation to both halves as the model sees", () => {
    // Two copies of this truncation would drift, and a key that hashes
    // different text than the model saw is worse than no key at all.
    const many = Array.from({ length: 30 }, (_, i) => `sig${i}`);
    const note = buildDeterministicNote(job({ positiveSignals: many, negativeSignals: many }));
    expect(note.full).toContain("sig11");
    expect(note.full).not.toContain("sig12");
    expect(note.stable).toContain("sig11");
    expect(note.stable).not.toContain("sig12");
    // Negative signals truncate at 8.
    expect(note.stable).toContain("sig7");
  });
});

describe("(b) the material hash absorbs churn without hiding real edits", () => {
  const base = "We need a Senior Engineer.\n\nRequirements:\n- React\n- TypeScript\n\nBenefits:\n- Health\n";

  it("ignores whitespace and indentation reflow", () => {
    expect(materialHash(base.replace(/\s+/g, "   "))).toBe(materialHash(base));
  });

  it("ignores section reordering", () => {
    const reordered = "Benefits:\n- Health\n\nRequirements:\n- React\n- TypeScript\n\nWe need a Senior Engineer.\n";
    expect(materialHash(reordered)).toBe(materialHash(base));
  });

  it("ignores punctuation and bullet restyling", () => {
    expect(materialHash(base.replace(/-/g, "*").replace(/:/g, " -"))).toBe(materialHash(base));
  });

  it("ignores case changes", () => {
    expect(materialHash(base.toUpperCase())).toBe(materialHash(base));
  });

  it("still notices an added requirement", () => {
    expect(materialHash(`${base}- 5 years of Kubernetes\n`)).not.toBe(materialHash(base));
  });

  it("still notices a removed requirement", () => {
    expect(materialHash(base.replace("- TypeScript\n", ""))).not.toBe(materialHash(base));
  });

  it("still notices a changed number", () => {
    // The asymmetry that governs this whole function: a false "material" costs
    // $0.046, a false "immaterial" serves a verdict formed against text that no
    // longer exists.
    expect(materialHash("Requires 3 years")).not.toBe(materialHash("Requires 5 years"));
  });

  it("keeps duplicates, so repetition is not silently collapsed", () => {
    expect(materialHash("react react")).not.toBe(materialHash("react"));
  });

  it("keeps c++, c# and node.js distinct from their prefixes", () => {
    expect(materialHash("c++")).not.toBe(materialHash("c"));
    expect(materialHash("c#")).not.toBe(materialHash("c"));
    expect(materialHash("node.js")).not.toBe(materialHash("node"));
  });
});

describe("upsert separates history from invalidation", () => {
  function normalized(over: Partial<NormalizedJob> = {}): NormalizedJob {
    const clean = over.descriptionClean ?? "We need a Senior Engineer. React. TypeScript.";
    return {
      id: "j1",
      externalId: "ext-1",
      source: "greenhouse",
      ats: "greenhouse",
      sourceUrl: "https://example.test/j1",
      applicationUrl: null,
      company: "Acme",
      companyNormalized: "acme",
      title: "Staff Engineer",
      location: "Remote",
      remoteStatus: "remote",
      employmentType: "full_time",
      seniority: "staff",
      datePosted: null,
      dateDiscovered: new Date().toISOString(),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: "USD",
      salaryPeriod: null,
      descriptionClean: clean,
      descriptionHash: `byte-${clean.length}-${clean.slice(0, 4)}`,
      materialHash: materialHash(clean),
      department: null,
      team: null,
      companySizeEstimate: null,
      companyStage: null,
      industry: null,
      ...over,
    } as NormalizedJob;
  }

  function withAnalysis() {
    const { repo, db } = memoryRepo();
    repo.upsert(normalized(), "d1");
    db.prepare("UPDATE jobs SET analysis_json = '{}', analyzed_at = '2026-09-01T00:00:00Z' WHERE id = 'j1'").run();
    return { repo, db };
  }

  const hasAnalysis = (db: ReturnType<typeof memoryRepo>["db"]) =>
    (db.prepare("SELECT analysis_json FROM jobs WHERE id = 'j1'").get() as { analysis_json: string | null })
      .analysis_json !== null;

  it("keeps the analysis when only the rendering changed", () => {
    // The churn case: 4,349 recorded description changes, one posting changing
    // 32 times. Each one used to throw away a paid-for analysis.
    const { repo, db } = withAnalysis();
    repo.upsert(normalized({ descriptionClean: "REACT.   TYPESCRIPT.  We need a Senior Engineer." }), "d1");
    expect(hasAnalysis(db)).toBe(true);
  });

  it("still records the byte-level change in job_events, so history stays exact", () => {
    const { repo, db } = withAnalysis();
    repo.upsert(normalized({ descriptionClean: "REACT.   TYPESCRIPT.  We need a Senior Engineer." }), "d1");
    const ev = db
      .prepare("SELECT detail FROM job_events WHERE job_id = 'j1' AND event_type = 'description_changed'")
      .get() as { detail: string } | undefined;
    expect(ev).toBeDefined();
    // And says which kind it was, so the two can be told apart later.
    expect(JSON.parse(ev!.detail).material).toBe(false);
  });

  it("still drops the analysis when the posting materially changed", () => {
    // CLAUDE.md requires upsert to invalidate a cached analysis when the
    // description changes. That behaviour is kept - "changes" now means
    // "materially changes", biased toward material.
    const { repo, db } = withAnalysis();
    repo.upsert(normalized({ descriptionClean: "We need a Senior Engineer. React. TypeScript. Kubernetes." }), "d1");
    expect(hasAnalysis(db)).toBe(false);
  });

  it("leaves everything alone when the posting is merely re-seen", () => {
    const { repo, db } = withAnalysis();
    repo.upsert(normalized(), "d1");
    expect(hasAnalysis(db)).toBe(true);
  });
});
