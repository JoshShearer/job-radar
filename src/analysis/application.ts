import { z } from "zod";

/**
 * The application-preparation contract.
 *
 * This stage produces everything needed to submit an application EXCEPT the
 * submission. Nothing here is sent, posted, or transmitted anywhere - it is
 * written to disk for a human to read, edit, and act on.
 *
 * Two rules are enforced in the prompt and re-checked here: never invent
 * experience, and never invent a person's name. `doNotClaim` exists so the
 * model has to state explicitly what would be a lie, rather than leaving the
 * boundary implicit.
 *
 * Note what this schema does NOT do: it does not cap array lengths. Structured
 * outputs cannot enforce array-length constraints, so a Zod `.max()` here would
 * reject an otherwise good, already-paid-for response for returning seven
 * interview questions instead of six. Counts are requested in the field
 * descriptions and trimmed at render time. Validate shape, not taste.
 */
export const ApplicationPackSchema = z.object({
  positioningStatement: z
    .string()
    .describe("2-3 sentences: the single frame this whole application should be built around."),
  resumeVariant: z
    .enum(["full_stack", "growth_seo", "ai_product", "proptech_3d"])
    .describe("Which base resume variant to start from."),
  resumeVariantReason: z.string().describe("Why that variant, in one or two sentences."),
  summaryRewrite: z
    .string()
    .describe("A suggested resume summary section tailored to this posting. Must use only real experience."),
  resumeEdits: z
    .array(
      z.object({
        change: z.string().describe("The specific edit to make."),
        why: z.string().describe("What in the posting motivates it."),
      }),
    )
    .describe("3-5 strategic edits. Not a rewrite."),
  keywordsToAdd: z
    .array(z.string())
    .describe("Terms in the posting that the candidate can HONESTLY claim but may not currently have on the resume."),
  coverNote: z
    .string()
    .describe("Under 200 words. Specific to this role. No generic enthusiasm, no fake familiarity."),
  formAnswers: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe("Draft answers to the free-text questions this application form is likely to ask."),
  outreachMessages: z
    .array(
      z.object({
        targetTitle: z.string().describe("Role title to contact. NEVER a person's name."),
        channel: z.string().describe("e.g. LinkedIn DM, email"),
        message: z.string().describe("Under 120 words. References something real about the role or company."),
      }),
    )
    ,
  compensationStrategy: z.object({
    askForTheirRangeFirst: z.boolean(),
    reasoning: z.string(),
    targetNumber: z.string(),
    anchorNumber: z.string(),
    walkAway: z.string(),
    suggestedWording: z.string().describe("What to actually say when the number comes up."),
  }),
  interviewPrep: z.object({
    likelyQuestions: z.array(z.string()),
    storiesToPrepare: z
      .array(z.string())
      .describe("STAR stories drawn ONLY from the candidate's real, stated history."),
    questionsToAskThem: z.array(z.string()),
  }),
  openDecisions: z
    .array(z.string())
    .describe("Things the HUMAN must decide before submitting. Be direct about real tradeoffs."),
  doNotClaim: z
    .array(z.string())
    .describe("Requirements in the posting the candidate cannot evidence and must not imply they have."),
});

export type ApplicationPack = z.infer<typeof ApplicationPackSchema>;

/** JSON Schema mirror, for structured output. */
export const APPLICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    positioningStatement: { type: "string" },
    resumeVariant: { type: "string", enum: ["full_stack", "growth_seo", "ai_product", "proptech_3d"] },
    resumeVariantReason: { type: "string" },
    summaryRewrite: { type: "string" },
    resumeEdits: {
      type: "array",
      items: {
        type: "object",
        properties: { change: { type: "string" }, why: { type: "string" } },
        required: ["change", "why"],
        additionalProperties: false,
      },
    },
    keywordsToAdd: { type: "array", items: { type: "string" } },
    coverNote: { type: "string" },
    formAnswers: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" } },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
    outreachMessages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          targetTitle: { type: "string" },
          channel: { type: "string" },
          message: { type: "string" },
        },
        required: ["targetTitle", "channel", "message"],
        additionalProperties: false,
      },
    },
    compensationStrategy: {
      type: "object",
      properties: {
        askForTheirRangeFirst: { type: "boolean" },
        reasoning: { type: "string" },
        targetNumber: { type: "string" },
        anchorNumber: { type: "string" },
        walkAway: { type: "string" },
        suggestedWording: { type: "string" },
      },
      required: [
        "askForTheirRangeFirst",
        "reasoning",
        "targetNumber",
        "anchorNumber",
        "walkAway",
        "suggestedWording",
      ],
      additionalProperties: false,
    },
    interviewPrep: {
      type: "object",
      properties: {
        likelyQuestions: { type: "array", items: { type: "string" } },
        storiesToPrepare: { type: "array", items: { type: "string" } },
        questionsToAskThem: { type: "array", items: { type: "string" } },
      },
      required: ["likelyQuestions", "storiesToPrepare", "questionsToAskThem"],
      additionalProperties: false,
    },
    openDecisions: { type: "array", items: { type: "string" } },
    doNotClaim: { type: "array", items: { type: "string" } },
  },
  required: [
    "positioningStatement",
    "resumeVariant",
    "resumeVariantReason",
    "summaryRewrite",
    "resumeEdits",
    "keywordsToAdd",
    "coverNote",
    "formAnswers",
    "outreachMessages",
    "compensationStrategy",
    "interviewPrep",
    "openDecisions",
    "doNotClaim",
  ],
  additionalProperties: false,
} as const;
