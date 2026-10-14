import { z } from "zod";

/**
 * What a model may return for materials. Every piece of outbound prose is a
 * SENTENCE that cites claim ids; the verifier checks each one before it can
 * reach a document. Resume headline and summary are chosen by id from the
 * candidate's own variants and are never written by a model.
 */

const Sentence = z
  .object({
    text: z.string().min(1).describe("One sentence."),
    cites: z
      .array(z.string())
      .describe("Claim ids this sentence relies on. Empty only for framing that asserts nothing about the candidate."),
  })
  .strict();
export type Sentence = z.infer<typeof Sentence>;

const PlannedClaim = z
  .object({
    claimId: z.string(),
    rewrite: z
      .string()
      .nullable()
      .describe("Same claim in the posting's vocabulary, or null to keep the original wording."),
  })
  .strict();

export const ResumePlanSchema = z
  .object({
    positioning: z.string().describe("Internal note for the candidate: the frame this resume argues."),
    headlineId: z.string().describe("Id of one of the candidate's headline variants."),
    summaryId: z.string().describe("Id of one of the candidate's summary variants."),
    skillGroups: z
      .array(z.object({ label: z.string(), skills: z.array(z.string()) }).strict())
      .describe("Declared skills only, most relevant group first."),
    roles: z.array(z.object({ roleId: z.string(), claims: z.array(PlannedClaim) }).strict()),
    projects: z.array(z.object({ projectId: z.string(), claims: z.array(PlannedClaim) }).strict()),
    omitted: z.array(z.object({ id: z.string(), why: z.string() }).strict()),
    gapsToExpect: z.array(z.string()),
    doNotClaim: z.array(z.string()),
  })
  .strict();
export type ResumePlan = z.infer<typeof ResumePlanSchema>;

export function packSchema(full: boolean) {
  const base = z.object({
    positioning: z.string().describe("Internal note: the one frame that makes the candidate the obvious fit."),
    coverLetter: z
      .array(z.array(Sentence))
      .describe("Paragraphs of sentences. Every claim about the candidate cites claim ids."),
    formAnswers: z
      .array(z.object({ question: z.string(), sentences: z.array(Sentence) }).strict())
      .describe("Draft answers to questions this application form is likely to ask."),
    doNotClaim: z.array(z.string()).describe("Requirements the candidate cannot evidence and must not imply."),
    decideFirst: z.array(z.string()).describe("Genuine tradeoffs only the candidate can resolve."),
  });
  if (!full) return base.strict();
  return base
    .extend({
      outreach: z
        .array(z.object({ targetTitle: z.string(), sentences: z.array(Sentence) }).strict())
        .describe("Short notes to role TITLES. Never a person's name."),
      compensation: z
        .object({
          target: z.string(),
          anchor: z.string(),
          walkAway: z.string(),
          askRangeFirst: z.boolean(),
          reasoning: z.string(),
        })
        .strict()
        .describe("Advice for the candidate. Never sent anywhere."),
      interviewPrep: z
        .array(z.object({ question: z.string(), claimIds: z.array(z.string()) }).strict())
        .describe("Likely questions, each with the claims that answer it."),
    })
    .strict();
}
export type PackPlan = z.infer<ReturnType<typeof packSchema>> & {
  outreach?: Array<{ targetTitle: string; sentences: Sentence[] }>;
  compensation?: { target: string; anchor: string; walkAway: string; askRangeFirst: boolean; reasoning: string };
  interviewPrep?: Array<{ question: string; claimIds: string[] }>;
};
