/**
 * JSON Schema for the analysis structured output.
 *
 * Hand-written rather than generated so it satisfies the API's structured
 * output constraints exactly: every object sets `additionalProperties: false`,
 * every property is listed in `required`, and no unsupported keywords
 * (minLength, minimum, recursive $ref) appear. The response is validated
 * against the matching Zod schema (`analysisSchemaFor` in model/job.ts) after
 * it comes back, so a malformed response is rejected rather than written to
 * the database.
 *
 * The lane enum is BUILT FROM CONFIG, not written here. It used to be a
 * hardcoded list of five lanes, and when `solutions_eng` was added to
 * `config/career-profile.yaml` the analyst had no way to say it: 90 of 98
 * solutions roles came back labelled "other". Nothing failed - the model
 * picked the only legal value that fit, the analysis validated, and the lane
 * data was quietly wrong.
 *
 * `other` is appended by this builder and is reserved. It is the analyst's
 * escape hatch for a role that fits no configured lane, so config must not
 * define a lane called `other`; `validateProfileCoherence` refuses that.
 */
export function buildAnalysisJsonSchema(laneKeys: readonly string[]) {
  return {
    type: "object",
    properties: {
      fitScore: {
        type: "integer",
        description: "0-100 semantic fit for THIS candidate specifically, not general job quality.",
      },
      applicationRoi: {
        type: "integer",
        description:
          "0-100. Does this deserve the candidate's limited time? Weigh differentiation and likely applicant volume, not just match quality.",
      },
      lane: {
        type: "string",
        enum: [...laneKeys, "other"],
        description: "Which target role family this belongs to, or `other` if none fits.",
      },
      recommendation: {
        type: "string",
        enum: ["apply_and_outreach", "apply", "network_or_watch", "skip"],
      },
      strengths: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific, evidence-backed reasons this candidate is strong here. Cite what is actually in their background.",
      },
      risks: {
        type: "array",
        items: { type: "string" },
        description: "Concrete concerns: gaps, competition, seniority mismatch, compensation risk.",
      },
      missingRequirements: {
        type: "array",
        items: { type: "string" },
        description:
          "Requirements the candidate cannot evidence. Mark each as MANDATORY DOMAIN or LEARNABLE TOOL in the string itself.",
      },
      differentiation: {
        type: "string",
        description:
          "One sentence on what makes this candidate unusually relevant here versus a generic senior React developer. Say 'none identified' if nothing stands out.",
      },
      salaryClassification: {
        type: "string",
        enum: ["green", "yellow", "red", "unknown"],
      },
      salaryReasoning: { type: "string" },
      interviewProbability: {
        type: "integer",
        description: "0-100 estimated chance of reaching a first conversation if they apply.",
      },
      competitionEstimate: {
        type: "string",
        enum: ["low", "moderate", "high", "very_high"],
      },
      outreachTargets: {
        type: "array",
        items: { type: "string" },
        description: "Role TITLES worth contacting, e.g. 'Head of Growth'. Never invent a person's name.",
      },
      reasoningSummary: {
        type: "string",
        description: "2-4 sentences explaining the overall call. This is what the human reads first.",
      },
    },
    required: [
      "fitScore",
      "applicationRoi",
      "lane",
      "recommendation",
      "strengths",
      "risks",
      "missingRequirements",
      "differentiation",
      "salaryClassification",
      "salaryReasoning",
      "interviewProbability",
      "competitionEstimate",
      "outreachTargets",
      "reasoningSummary",
    ],
    additionalProperties: false,
  };
}

/**
 * Fields the TRIAGE call asks for.
 *
 * 77% of paid analyses end in "skip" (314 of 406), and the schema forced a
 * full dossier for every one of them - up to 8 strengths, 8 risks, 8 missing
 * requirements, salary reasoning, outreach targets. Output tokens are ~70% of
 * the bill. Measured over the 406 stored analyses, these six fields are 25.9%
 * of the output bytes, so the dossier is roughly three quarters of what is
 * being paid for on a verdict nobody reads.
 *
 * `reasoningSummary` stays in the triage set on purpose. It is the one thing a
 * person actually reads on a skip, and it is one sentence.
 *
 * `salaryClassification` stays because it is a four-value enum - it costs
 * almost nothing and it is used for ranking. `salaryReasoning`, the prose that
 * explains it, is dossier-only.
 */
export const TRIAGE_FIELDS = [
  "fitScore",
  "applicationRoi",
  "lane",
  "recommendation",
  "salaryClassification",
  "reasoningSummary",
] as const;

/**
 * The cheap first pass: a verdict and one sentence, nothing else.
 *
 * Derived from the full schema rather than written separately, so a field
 * description or an enum can never drift between the two forms. That drift is
 * exactly what JOB-29 was about.
 */
export function buildTriageJsonSchema(laneKeys: readonly string[]) {
  const full = buildAnalysisJsonSchema(laneKeys);
  const keep = new Set<string>(TRIAGE_FIELDS);
  return {
    ...full,
    properties: Object.fromEntries(Object.entries(full.properties).filter(([k]) => keep.has(k))),
    required: full.required.filter((k) => keep.has(k)),
  };
}
