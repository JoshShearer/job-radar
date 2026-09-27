import { describe, it, expect } from "vitest";
import { describeVerdict, endorsementOf, isApplyVerdict } from "../src/analysis/endorsement.js";
import { renderOutcomes, type AutofillResult } from "../src/apply/autofill.js";
import { computeAnalysisIdentity } from "../src/analysis/identity.js";
import type { Analysis, EnrichedJob } from "../src/model/job.js";
import type { CareerProfile } from "../src/config/schema.js";

/**
 * 22 of 43 applications were prepared against a standing `skip` or
 * `network_or_watch` verdict, with no friction at all. These tests pin the two
 * halves of the fix that can regress independently: the verdict is read
 * correctly, and the analyst's words are quoted rather than reshaped.
 */

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    fitScore: 62,
    applicationRoi: 40,
    lane: "frontend",
    recommendation: "skip",
    strengths: [],
    risks: [],
    missingRequirements: [],
    differentiation: "none identified",
    salaryClassification: "yellow",
    salaryReasoning: "Series A, likely below band.",
    interviewProbability: 20,
    competitionEstimate: "high",
    outreachTargets: [],
    reasoningSummary: "Strong React overlap but the role is explicitly backend-leaning.",
    ...over,
  };
}

function job(over: Partial<EnrichedJob> = {}): EnrichedJob {
  return { id: "j1", title: "Staff Engineer", company: "Acme", fitScore: 62, analysis: null, ...over } as EnrichedJob;
}

/** A minimal profile good enough for `computeAnalysisIdentity`/`buildSystemPrompt`. */
function profile(over: Partial<CareerProfile> = {}): CareerProfile {
  return {
    identity: { name: "Jane Doe", headline: "Senior Engineer", years_experience: 10 },
    compensation: {
      currency: "USD",
      target_min: 160_000,
      target_max: 180_000,
      acceptable_min: 140_000,
      reject_below_max: 120_000,
      stretch_min: 180_000,
      stretch_max: 220_000,
      contract_min_hourly: 90,
      contract_max_hourly: 140,
      prefer_employment_type: "full_time",
    },
    location: {
      home_metro: "Seattle",
      remote_ok: true,
      hybrid_metros: [],
      onsite_ok_metros: [],
      relocation_ok: false,
      work_authorization_blockers: [],
    },
    lanes: { frontend: { label: "Frontend", weight: 1 } },
    ...over,
  } as unknown as CareerProfile;
}

/**
 * A job whose `analysisIdentity` snapshot was formed against a fixed set of
 * DEFAULTS, while the job's own current fields carry whatever `over`
 * overrides - simulating "the analysis was formed, then the posting (or the
 * profile) moved". With no override, snapshot and current agree exactly, so
 * the job reads as freshly analyzed - that is what makes the "nothing moved"
 * regression test meaningful.
 */
const IDENTITY_DEFAULTS: Partial<EnrichedJob> = {
  title: "Staff Engineer",
  location: "Remote",
  remoteStatus: "remote",
  employmentType: "full_time",
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: "USD",
  salaryPeriod: null,
} as Partial<EnrichedJob>;

function freshJob(over: Partial<EnrichedJob> = {}, p: CareerProfile = profile()): EnrichedJob {
  const snapshot = computeAnalysisIdentity(job(IDENTITY_DEFAULTS), p);
  return { ...job({ ...IDENTITY_DEFAULTS, ...over }), analysisIdentity: snapshot };
}

describe("isApplyVerdict", () => {
  it("counts both apply tiers, and nothing else", () => {
    expect(isApplyVerdict("apply")).toBe(true);
    // The one most likely to be dropped by a second, drifted copy of the set.
    expect(isApplyVerdict("apply_and_outreach")).toBe(true);
    expect(isApplyVerdict("network_or_watch")).toBe(false);
    expect(isApplyVerdict("skip")).toBe(false);
  });
});

describe("endorsementOf", () => {
  it("reads an apply verdict as endorsed", () => {
    const e = endorsementOf(job({ analysis: analysis({ recommendation: "apply" }) }));
    expect(e.tier).toBe("endorsed");
    expect(e.verdict).toBe("apply");
  });

  it("reads network_or_watch as unendorsed, not as an apply", () => {
    // This is the verdict the tool printed and then sold the package against.
    const e = endorsementOf(job({ analysis: analysis({ recommendation: "network_or_watch" }) }));
    expect(e.tier).toBe("unendorsed");
  });

  it("reads a missing analysis as unanalyzed, never as unendorsed", () => {
    // The distinction is load-bearing: `unanalyzed` must not refuse, because
    // the only way to satisfy such a gate is to spend money.
    const e = endorsementOf(job({ analysis: null }));
    expect(e.tier).toBe("unanalyzed");
    expect(e.verdict).toBeNull();
    expect(e.reason).toBeNull();
  });

  it("quotes the analyst's reasoning verbatim when it fits", () => {
    const e = endorsementOf(job({ analysis: analysis() }));
    expect(e.reason).toBe("Strong React overlap but the role is explicitly backend-leaning.");
  });

  it("does not split on abbreviations or decimals", () => {
    // A naive `split(". ")` cuts this after "vs." and reports a fragment that
    // says the opposite of the sentence it came from.
    const summary = "Comp is $160k vs. $180k target, so the band is the risk. Otherwise a strong match.";
    const e = endorsementOf(job({ analysis: analysis({ reasoningSummary: summary }) }));
    expect(e.reason).toBe(summary);
  });

  it("truncates a long summary on a word boundary and marks it", () => {
    const summary = `${"word ".repeat(80)}end`;
    const e = endorsementOf(job({ analysis: analysis({ reasoningSummary: summary }) }));
    expect(e.reason!.endsWith("...")).toBe(true);
    expect(e.reason!.length).toBeLessThanOrEqual(164);
    // Never cuts mid-word.
    expect(e.reason).not.toMatch(/wo\.\.\.$/);
  });

  it("reports no reason rather than inventing one when the summary is blank", () => {
    const e = endorsementOf(job({ analysis: analysis({ reasoningSummary: "   " }) }));
    expect(e.reason).toBeNull();
  });

  it("collapses newlines so the reason stays one line", () => {
    const e = endorsementOf(job({ analysis: analysis({ reasoningSummary: "First line.\n\nSecond line." }) }));
    expect(e.reason).toBe("First line. Second line.");
  });
});

/**
 * JOB-51. A standing analysis can be present and STILL untrustworthy: one of
 * its snapshotted inputs has moved since it was formed, or the stored JSON no
 * longer conforms to the live schema for its tier. `stale` is distinct from
 * `unendorsed` - the disagreement here is with the RECORD, not the analyst's
 * judgement - and distinct from `unanalyzed`, because there IS a verdict, it
 * just cannot be trusted as current.
 *
 * The staleness check only runs when a `profile` is passed. Without one
 * (`src/apply/autofill.ts`'s informational call), behaviour is unchanged -
 * see the JSDoc on `endorsementOf` for why that residual gap is accepted.
 */
describe("endorsementOf: the stale tier (JOB-51)", () => {
  const p = profile();

  it("stays endorsed/unendorsed when a profile is passed and nothing moved", () => {
    // The regression this guards: adding the staleness check must not make
    // every ordinary endorsed/unendorsed job look stale.
    expect(endorsementOf(freshJob({ analysis: analysis({ recommendation: "apply" }) }), p).tier).toBe("endorsed");
    expect(endorsementOf(freshJob({ analysis: analysis({ recommendation: "skip" }) }), p).tier).toBe("unendorsed");
  });

  it("goes stale when the title moved", () => {
    const j = freshJob({ analysis: analysis(), title: "Director of Engineering" });
    const e = endorsementOf(j, p);
    expect(e.tier).toBe("stale");
    expect(e.staleFields).toEqual(["title"]);
    expect(e.staleSchema).toBe(false);
    // The verdict and reasoning are PRESERVED, not cleared - decision 3.
    expect(e.verdict).toBe("skip");
    expect(e.reason).not.toBeNull();
  });

  it("goes stale when the location moved", () => {
    const j = freshJob({ analysis: analysis(), remoteStatus: "onsite" });
    const e = endorsementOf(j, p);
    expect(e.tier).toBe("stale");
    expect(e.staleFields).toEqual(["location"]);
  });

  it("goes stale when the employment type moved", () => {
    const j = freshJob({ analysis: analysis(), employmentType: "contract" });
    const e = endorsementOf(j, p);
    expect(e.tier).toBe("stale");
    expect(e.staleFields).toEqual(["employment"]);
  });

  it("goes stale when the compensation moved", () => {
    const j = freshJob({ analysis: analysis(), salaryMin: 200_000 });
    const e = endorsementOf(j, p);
    expect(e.tier).toBe("stale");
    expect(e.staleFields).toEqual(["compensation"]);
  });

  it("goes stale on a schema mismatch even when every identity field still matches", () => {
    // `lane: "backend"` is legal under no profile this analysis could have
    // been formed against here - `p.lanes` only defines "frontend" - so
    // `analysisSchemaFor(["frontend"])` rejects it. Nothing about
    // title/location/employment/compensation moved.
    const j = freshJob({ analysis: analysis({ lane: "backend" }) });
    const e = endorsementOf(j, p);
    expect(e.tier).toBe("stale");
    expect(e.staleSchema).toBe(true);
    expect(e.staleFields).toEqual([]);
  });

  it("does not run the staleness check at all without a profile", () => {
    // `src/apply/autofill.ts`'s informational report calls this with no
    // profile - a KNOWN LIMITATION (see the PR description), not a bug: a
    // job whose title has moved still reads as its raw verdict there.
    const j = freshJob({ analysis: analysis(), title: "Director of Engineering" });
    expect(endorsementOf(j).tier).toBe("unendorsed");
  });
});

describe("describeVerdict", () => {
  it("names the verdict and the fit it was formed against", () => {
    expect(describeVerdict(endorsementOf(job({ analysis: analysis({ fitScore: 71 }) })))).toBe("skip (fit 71)");
  });

  it("says so plainly when nothing was analyzed", () => {
    expect(describeVerdict(endorsementOf(job()))).toBe("not analyzed");
  });
});

describe("the autofill report carries the verdict", () => {
  const result: AutofillResult = {
    url: "https://example.com/apply",
    outcomes: [{ label: "Email", status: "filled", detail: "a@b.c" }],
    submitted: false,
  } as unknown as AutofillResult;

  it("warns in the report a human reads before submitting", () => {
    const md = renderOutcomes(job({ analysis: analysis({ recommendation: "skip" }) }), result);
    expect(md).toContain("Verdict: skip (fit 62)");
    expect(md).toContain("The analyst did not endorse this application");
    expect(md).toContain("Strong React overlap");
    // The never-submit guarantee is not weakened by any of this.
    expect(md).toContain("NOT SUBMITTED");
  });

  it("states the verdict without a warning when the analyst endorsed it", () => {
    const md = renderOutcomes(job({ analysis: analysis({ recommendation: "apply" }) }), result);
    expect(md).toContain("Verdict: apply (fit 62)");
    expect(md).not.toContain("did not endorse");
  });
});
