import { describe, it, expect } from "vitest";
import { deservesDossier, dossierReason } from "../src/analysis/detail.js";
import { buildTriageJsonSchema, buildAnalysisJsonSchema, TRIAGE_FIELDS } from "../src/analysis/schema.js";
import { triageSchemaFor, triageOnlyAnalysis, analysisSchemaFor } from "../src/model/job.js";

const LANES = ["full_stack", "solutions_eng"];
const POLICY = { recommendations: ["apply_and_outreach", "apply", "network_or_watch"], minFit: 70 };

const verdict = (over: Partial<Record<string, unknown>> = {}) => ({
  fitScore: 40,
  applicationRoi: 40,
  lane: "full_stack",
  recommendation: "skip",
  salaryClassification: "green",
  reasoningSummary: "One sentence.",
  ...over,
}) as never;

/**
 * JOB-31. 77% of paid analyses end in "skip" (314 of 406) and the schema
 * forced a full ~3KB dossier for every one. Measured over the stored
 * analyses, the triage fields are 25.9% of the output bytes.
 */
describe("deservesDossier", () => {
  it("buys the dossier for anything a person might act on", () => {
    for (const r of ["apply", "apply_and_outreach", "network_or_watch"]) {
      expect(deservesDossier(verdict({ recommendation: r }), POLICY)).toBe(true);
    }
  });

  it("does not buy one for a plain skip", () => {
    expect(deservesDossier(verdict({ recommendation: "skip", fitScore: 40 }), POLICY)).toBe(false);
  });

  it("buys one for a high-fit skip anyway", () => {
    // The safety valve. A skip at fit 85 is more likely a model that has
    // misjudged something than a hopeless role, and the dossier is what a
    // person needs to tell which.
    expect(deservesDossier(verdict({ recommendation: "skip", fitScore: 85 }), POLICY)).toBe(true);
    expect(deservesDossier(verdict({ recommendation: "skip", fitScore: 70 }), POLICY)).toBe(true);
    expect(deservesDossier(verdict({ recommendation: "skip", fitScore: 69 }), POLICY)).toBe(false);
  });

  it("explains itself for the log", () => {
    expect(dossierReason(verdict({ recommendation: "apply" }), POLICY)).toBe("verdict apply");
    expect(dossierReason(verdict({ fitScore: 80 }), POLICY)).toBe("fit 80 >= 70");
    expect(dossierReason(verdict(), POLICY)).toContain("triage only");
  });
});

describe("the triage schema is the full schema, minus", () => {
  it("asks for exactly the triage fields and nothing else", () => {
    const t = buildTriageJsonSchema(LANES);
    expect(Object.keys(t.properties).sort()).toEqual([...TRIAGE_FIELDS].sort());
    expect(t.required.sort()).toEqual([...TRIAGE_FIELDS].sort());
  });

  it("drops the expensive prose fields", () => {
    const t = buildTriageJsonSchema(LANES);
    for (const f of ["strengths", "risks", "missingRequirements", "outreachTargets", "salaryReasoning"]) {
      expect(t.properties).not.toHaveProperty(f);
    }
  });

  it("keeps the one sentence a person actually reads on a skip", () => {
    expect(buildTriageJsonSchema(LANES).properties).toHaveProperty("reasoningSummary");
  });

  it("inherits field definitions rather than restating them", () => {
    // Derived from the full schema so a description or enum cannot drift
    // between the two forms - the exact failure JOB-29 was about.
    const full = buildAnalysisJsonSchema(LANES);
    const t = buildTriageJsonSchema(LANES);
    expect(t.properties.lane).toEqual(full.properties.lane);
    expect(t.properties.recommendation).toEqual(full.properties.recommendation);
    expect(t.additionalProperties).toBe(false);
  });
});

describe("triage output is validated as strictly as the full form", () => {
  it("accepts a well-formed triage verdict", () => {
    expect(triageSchemaFor(LANES).safeParse(verdict()).success).toBe(true);
  });

  it("rejects a lane the profile does not define", () => {
    expect(triageSchemaFor(LANES).safeParse(verdict({ lane: "not_a_lane" })).success).toBe(false);
  });

  it("rejects a bad recommendation and an out-of-range score", () => {
    expect(triageSchemaFor(LANES).safeParse(verdict({ recommendation: "maybe" })).success).toBe(false);
    expect(triageSchemaFor(LANES).safeParse(verdict({ fitScore: 140 })).success).toBe(false);
  });

  it("does not let a triage response satisfy the full schema", () => {
    // The reason these are two strict schemas rather than one with optional
    // fields: a FULL response that forgot `strengths` must still be rejected.
    expect(analysisSchemaFor(LANES).safeParse(verdict()).success).toBe(false);
  });
});

describe("triageOnlyAnalysis", () => {
  it("fills the dossier half with empties and invents nothing", () => {
    const a = triageOnlyAnalysis(verdict({ recommendation: "skip" }));
    expect(a.strengths).toEqual([]);
    expect(a.risks).toEqual([]);
    expect(a.missingRequirements).toEqual([]);
    expect(a.outreachTargets).toEqual([]);
    expect(a.differentiation).toBe("");
    expect(a.salaryReasoning).toBe("");
  });

  it("keeps every triage field intact", () => {
    const a = triageOnlyAnalysis(verdict({ fitScore: 55, recommendation: "skip" }));
    expect(a.fitScore).toBe(55);
    expect(a.recommendation).toBe("skip");
    expect(a.reasoningSummary).toBe("One sentence.");
  });

  it("still passes the full schema, so nothing malformed reaches the database", () => {
    expect(analysisSchemaFor(LANES).safeParse(triageOnlyAnalysis(verdict())).success).toBe(true);
  });
});
