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
  // `string`, not an enum, for the same reason `Analysis.lane` is: the valid
  // set lives in config/career-profile.yaml and is not knowable at compile
  // time. This schema also re-validates packs read back from disk, and the
  // enum that used to be here listed `proptech_3d` - a key no lane has ever
  // had - so saved packs must stay readable while the model is constrained by
  // the JSON schema below.
  resumeVariant: z.string().describe("Which base resume variant to start from."),
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
    .describe("Cold outreach drafts. Role titles only, never a person's name.")
    .optional(),
  compensationStrategy: z
    .object({
      askForTheirRangeFirst: z.boolean(),
      reasoning: z.string(),
      targetNumber: z.string(),
      anchorNumber: z.string(),
      walkAway: z.string(),
      suggestedWording: z.string().describe("What to actually say when the number comes up."),
    })
    .optional(),
  interviewPrep: z
    .object({
      likelyQuestions: z.array(z.string()),
      storiesToPrepare: z
        .array(z.string())
        .describe("STAR stories drawn ONLY from the candidate's real, stated history."),
      questionsToAskThem: z.array(z.string()),
    })
    .optional(),
  openDecisions: z
    .array(z.string())
    .describe("Things the HUMAN must decide before submitting. Be direct about real tradeoffs.")
    .optional(),
  // NEVER optional, in either variant. This is the list of things that must
  // not be claimed on the application; a cheaper pack is still a pack that
  // cannot make a false statement.
  doNotClaim: z
    .array(z.string())
    .describe("Requirements in the posting the candidate cannot evidence and must not imply they have."),
});

export type ApplicationPack = z.infer<typeof ApplicationPackSchema>;

/**
 * Sections that belong to a later stage than "submit this application".
 *
 * Outreach drafts, interview prep and a negotiation strategy are useful, and
 * none of them is useful at the moment of filling in a form. Together they are
 * about half of what the model generates, and OUTPUT is where the money goes:
 * one measured pack was 4,281 tokens in and 8,675 out, ten times more spent on
 * output than input at Opus rates.
 *
 * So they are opt-in (`apply --full`) rather than always-on. Not hidden at
 * render time - a section that is rendered-but-not-shown has already been paid
 * for. They are removed from the schema, which is what actually stops them
 * being written.
 */
export const LATER_STAGE_SECTIONS = [
  "outreachMessages",
  "compensationStrategy",
  "interviewPrep",
  "openDecisions",
] as const;

/**
 * JSON Schema mirror, for structured output.
 *
 * `resumeVariant`'s enum is filled in from config by `applicationJsonSchema`.
 * The list hardcoded here previously was `["full_stack", "growth_seo",
 * "ai_product", "proptech_3d"]`, which had drifted twice over: it never
 * learned about `solutions_eng`, and `proptech_3d` is not a lane key at all -
 * the config calls that lane `spatial_iot`. So the model was being offered one
 * option that could never be right and denied one that often was.
 */
const APPLICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    positioningStatement: { type: "string" },
    resumeVariant: { type: "string" },
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

/**
 * The schema to ask for. `full` decides whether the later-stage sections are
 * requested at all.
 *
 * Both variants keep `additionalProperties: false` and an accurate `required`
 * list, so the core pack is as strictly validated as the full one - this trades
 * scope for cost, never rigour. The Zod schema marks the same four optional, so
 * a core pack loads and re-validates exactly like a full one.
 */
export function applicationJsonSchema(full: boolean, laneKeys: readonly string[]): Record<string, unknown> {
  const drop = full ? new Set<string>() : new Set<string>(LATER_STAGE_SECTIONS);
  const properties = Object.fromEntries(
    Object.entries(APPLICATION_JSON_SCHEMA.properties)
      .filter(([k]) => !drop.has(k))
      // The lane list comes from config, so it is injected here rather than
      // written into the constant above.
      .map(([k, v]) => (k === "resumeVariant" ? [k, { ...v, enum: [...laneKeys] }] : [k, v])),
  );
  return {
    ...APPLICATION_JSON_SCHEMA,
    properties,
    required: APPLICATION_JSON_SCHEMA.required.filter((k) => !drop.has(k)),
  };
}
