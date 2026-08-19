import { describe, it, expect } from "vitest";
import {
  ApplicationPackSchema,
  applicationJsonSchema,
  APPLICATION_JSON_SCHEMA,
  LATER_STAGE_SECTIONS,
} from "../src/analysis/application.js";

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
    expect(applicationJsonSchema(true)).toEqual(APPLICATION_JSON_SCHEMA);
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
