import { describe, it, expect } from "vitest";
import {
  ApplicationPackSchema,
  applicationJsonSchema as rawApplicationJsonSchema,
  LATER_STAGE_SECTIONS,
} from "../src/analysis/application.js";

/** Lanes now come from config; these tests only care about shape, not the set. */
const LANES = ["full_stack", "ai_product", "solutions_eng"];
const applicationJsonSchema = (full: boolean) => rawApplicationJsonSchema(full, LANES);

/**
 * JOB-23. The application pack is the largest output in the tool - roughly
 * 6,000 tokens per job plus thinking - and output is where the money goes.
 * About half of it (outreach drafts, interview prep, negotiation strategy) is
 * useful at a later stage than "submit this application", so it is opt-in.
 *
 * The saving only exists if those sections are never GENERATED. Hiding them at
 * render time would pay for them and then throw them away.
 */

const core = {
  positioningStatement: "A frame.",
  resumeVariant: "full_stack",
  resumeVariantReason: "Because.",
  summaryRewrite: "A summary.",
  resumeEdits: [{ change: "c", why: "w" }],
  keywordsToAdd: ["typescript"],
  coverNote: "A note.",
  formAnswers: [{ question: "q", answer: "a" }],
  doNotClaim: ["Go"],
};

describe("the core pack schema", () => {
  it("omits every later-stage section from what is requested", () => {
    const schema = applicationJsonSchema(false) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const section of LATER_STAGE_SECTIONS) {
      expect(Object.keys(schema.properties), section).not.toContain(section);
      expect(schema.required, section).not.toContain(section);
    }
  });

  it("keeps everything the application itself needs", () => {
    const schema = applicationJsonSchema(false) as { required: string[] };
    // coverNote and formAnswers are what `autofill` and the cover letter use;
    // doNotClaim is the safety list. None may be dropped to save tokens.
    for (const kept of ["coverNote", "formAnswers", "doNotClaim", "positioningStatement", "resumeEdits"]) {
      expect(schema.required, kept).toContain(kept);
    }
  });

  it("never makes doNotClaim optional, in either variant", () => {
    // A cheaper pack is still a pack that cannot make a false statement.
    for (const full of [true, false]) {
      const schema = applicationJsonSchema(full) as { required: string[] };
      expect(schema.required, `full=${full}`).toContain("doNotClaim");
    }
    expect(ApplicationPackSchema.safeParse({ ...core, doNotClaim: undefined }).success).toBe(false);
  });

  it("stays as strictly validated as the full variant", () => {
    // Trading scope for cost must not trade away rigour.
    const schema = applicationJsonSchema(false) as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    // The full schema drops nothing; every property survives.
    const full = applicationJsonSchema(true) as { properties: Record<string, unknown>; required: string[] };
    for (const section of LATER_STAGE_SECTIONS) expect(full.properties).toHaveProperty(section);
  });

  it("actually asks for less", () => {
    const coreSchema = applicationJsonSchema(false) as { properties: Record<string, unknown> };
    const fullSchema = applicationJsonSchema(true) as { properties: Record<string, unknown> };
    expect(Object.keys(coreSchema.properties).length).toBeLessThan(Object.keys(fullSchema.properties).length);
  });
});

describe("loading a pack", () => {
  it("accepts a core pack", () => {
    const parsed = ApplicationPackSchema.safeParse(core);
    expect(parsed.success).toBe(true);
  });

  it("accepts a full pack", () => {
    const parsed = ApplicationPackSchema.safeParse({
      ...core,
      outreachMessages: [{ targetTitle: "EM", channel: "LinkedIn", message: "hi" }],
      compensationStrategy: {
        askForTheirRangeFirst: true,
        reasoning: "r",
        targetNumber: "$1",
        anchorNumber: "$2",
        walkAway: "$0",
        suggestedWording: "w",
      },
      interviewPrep: { likelyQuestions: ["q"], storiesToPrepare: ["s"], questionsToAskThem: ["a"] },
      openDecisions: ["d"],
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects malformed output rather than storing it", () => {
    // The determinism rule does not relax because the pack got smaller.
    expect(ApplicationPackSchema.safeParse({ ...core, formAnswers: "not an array" }).success).toBe(false);
    expect(ApplicationPackSchema.safeParse({ ...core, coverNote: 42 }).success).toBe(false);
  });
});

/**
 * JOB-29. The lane list must live in one place.
 *
 * `resumeVariant`'s enum was hardcoded as
 * ["full_stack", "growth_seo", "ai_product", "proptech_3d"], which had drifted
 * twice: it never learned about `solutions_eng`, and `proptech_3d` is not a
 * lane key at all - config calls that lane `spatial_iot`. The model was being
 * offered an option that could never be right and denied one that often was.
 */
describe("resumeVariant lanes come from config", () => {
  it("offers exactly the lanes it was given", () => {
    const schema = rawApplicationJsonSchema(true, ["full_stack", "solutions_eng"]) as {
      properties: { resumeVariant: { enum: string[] } };
    };
    expect(schema.properties.resumeVariant.enum).toEqual(["full_stack", "solutions_eng"]);
  });

  it("picks up a newly added lane with no code change", () => {
    const schema = rawApplicationJsonSchema(true, ["full_stack", "brand_new_lane"]) as {
      properties: { resumeVariant: { enum: string[] } };
    };
    expect(schema.properties.resumeVariant.enum).toContain("brand_new_lane");
  });

  it("no longer offers proptech_3d, which was never a real lane key", () => {
    const schema = rawApplicationJsonSchema(true, ["spatial_iot"]) as {
      properties: { resumeVariant: { enum: string[] } };
    };
    expect(schema.properties.resumeVariant.enum).not.toContain("proptech_3d");
  });

  it("still reads a saved pack whose variant is a retired lane", () => {
    // pack.json files on disk carry whatever the enum allowed when they were
    // written, including `proptech_3d`. Re-validating on read must not throw.
    expect(ApplicationPackSchema.shape.resumeVariant.safeParse("proptech_3d").success).toBe(true);
  });
});
