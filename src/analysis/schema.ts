/**
 * JSON Schema for the analysis structured output.
 *
 * Hand-written rather than generated so it satisfies the API's structured
 * output constraints exactly: every object sets `additionalProperties: false`,
 * every property is listed in `required`, and no unsupported keywords
 * (minLength, minimum, recursive $ref) appear. The response is validated
 * against the matching Zod schema (AnalysisSchema in model/job.ts) after it
 * comes back, so a malformed response is rejected rather than written to the
 * database.
 */
export const ANALYSIS_JSON_SCHEMA = {
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
      enum: ["full_stack", "growth_seo", "ai_product", "spatial_iot", "other"],
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
} as const;
