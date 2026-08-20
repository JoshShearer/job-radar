import { describe, it, expect } from "vitest";
import { buildAnalysisJsonSchema } from "../src/analysis/schema.js";
import { analysisSchemaFor, AnalysisSchema } from "../src/model/job.js";

/**
 * JOB-29. The lane list must live in one place.
 *
 * The analyst's output schema hardcoded five lanes in two files. When
 * `solutions_eng` was added to config/career-profile.yaml, the analyst had no
 * legal way to say it and labelled 90 of 98 solutions roles "other". Nothing
 * threw: the model picked the closest legal value, validation passed, and the
 * lane column was quietly wrong.
 */
const VALID: Record<string, unknown> = {
  fitScore: 70,
  applicationRoi: 60,
  lane: "solutions_eng",
  recommendation: "apply",
  strengths: [],
  risks: [],
  missingRequirements: [],
  differentiation: "x",
  salaryClassification: "green",
  salaryReasoning: "x",
  interviewProbability: 50,
  competitionEstimate: "moderate",
  outreachTargets: [],
  reasoningSummary: "x",
};

describe("analysis lane enum comes from config", () => {
  it("offers exactly the configured lanes plus the reserved escape hatch", () => {
    const schema = buildAnalysisJsonSchema(["full_stack", "solutions_eng"]);
    expect(schema.properties.lane.enum).toEqual(["full_stack", "solutions_eng", "other"]);
  });

  it("picks up a newly added lane with no TypeScript edit", () => {
    // The done-when condition of the issue, stated as a test.
    const schema = buildAnalysisJsonSchema(["full_stack", "brand_new_lane"]);
    expect(schema.properties.lane.enum).toContain("brand_new_lane");
  });

  it("accepts a lane the profile defines", () => {
    const parsed = analysisSchemaFor(["full_stack", "solutions_eng"]).safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it("rejects a lane the profile does not define", () => {
    // This is the half that makes the failure loud instead of silent.
    const parsed = analysisSchemaFor(["full_stack"]).safeParse(VALID);
    expect(parsed.success).toBe(false);
  });

  it("always accepts `other`", () => {
    const parsed = analysisSchemaFor(["full_stack"]).safeParse({ ...VALID, lane: "other" });
    expect(parsed.success).toBe(true);
  });

  it("keeps the base schema permissive, so stored analyses on a retired lane still parse", () => {
    // Analyses are read back from the database with a plain JSON.parse, but
    // anything that does re-validate must not throw on a lane that has since
    // been removed from config.
    expect(AnalysisSchema.safeParse({ ...VALID, lane: "growth_seo" }).success).toBe(true);
    expect(AnalysisSchema.safeParse({ ...VALID, lane: "a_lane_deleted_last_year" }).success).toBe(true);
  });
});
