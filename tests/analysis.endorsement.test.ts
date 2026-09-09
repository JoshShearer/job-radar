import { describe, it, expect } from "vitest";
import { describeVerdict, endorsementOf, isApplyVerdict } from "../src/analysis/endorsement.js";
import { renderOutcomes, type AutofillResult } from "../src/apply/autofill.js";
import type { Analysis, EnrichedJob } from "../src/model/job.js";

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
