import { z } from "zod";
import type { Period } from "../lib/salary.js";
import type { RemoteStatus } from "../lib/location.js";
import type { EmploymentType, SeniorityLevel } from "../lib/seniority.js";
import type { Priority, Status } from "./status.js";

/**
 * The normalized job record. Every source adapter must produce this shape, and
 * nothing downstream may depend on source-specific fields.
 */
export interface NormalizedJob {
  /** Stable internal id: short hash of source + external_id. */
  id: string;
  /** Id as given by the source system. */
  externalId: string;
  /** Adapter name: greenhouse | lever | ashby | remoteok | ... */
  source: string;
  /** ATS platform backing the posting, when known. */
  ats: string | null;
  sourceUrl: string;
  applicationUrl: string | null;

  company: string;
  title: string;
  location: string;
  remoteStatus: RemoteStatus;
  employmentType: EmploymentType;
  seniority: SeniorityLevel;

  datePosted: string | null; // ISO8601
  dateDiscovered: string; // ISO8601

  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: Period | null;

  descriptionClean: string;
  descriptionHash: string;
  /**
   * Content address that survives cosmetic edits. Keys the analysis cache,
   * where `descriptionHash` keys `job_events` so change history stays exact.
   */
  materialHash: string;

  department: string | null;
  team: string | null;
  companySizeEstimate: string | null;
  companyStage: string | null;
  industry: string | null;
}

/** Deterministic analysis produced by the scoring engine (no LLM). */
export interface ScoreResult {
  fitScore: number;
  lane: string;
  laneLabel: string;
  compensationScore: number;
  compensationConfidence: string;
  competitionScore: number;
  applicationRoi: number;
  positiveSignals: string[];
  negativeSignals: string[];
  combos: string[];
  explanation: string;
  priority: Priority;
}

export interface FilterResult {
  passed: boolean;
  /** Human-readable reasons a job was rejected. Empty when passed. */
  reasons: string[];
  /** Non-fatal concerns worth surfacing on an otherwise passing job. */
  warnings: string[];
}

/** Structured output contract for the LLM analysis stage. */
export const AnalysisSchema = z.object({
  fitScore: z
    .number()
    .min(0)
    .max(100)
    .describe("0-100 semantic fit for this candidate specifically, not general job quality."),
  applicationRoi: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "0-100 estimate of whether this deserves the candidate's time, accounting for likely applicant volume, differentiation, and compensation probability.",
    ),
  // Deliberately `string` rather than an enum here. The set of valid lanes
  // lives in config/career-profile.yaml, so it is not knowable at compile
  // time; `analysisSchemaFor` narrows it at validation time. Stored analyses
  // are read back with a plain JSON.parse, so a lane retired from config
  // still deserialises rather than throwing on historical rows.
  lane: z.string().describe("Which target role family this belongs to."),
  recommendation: z
    .enum(["apply_and_outreach", "apply", "network_or_watch", "skip"])
    .describe("The action the candidate should take."),
  strengths: z
    .array(z.string())
    .max(8)
    .describe("Specific, evidence-backed reasons this candidate is unusually strong for THIS role."),
  risks: z
    .array(z.string())
    .max(8)
    .describe("Concrete concerns: gaps, competition, seniority mismatch, comp risk."),
  missingRequirements: z
    .array(z.string())
    .max(8)
    .describe(
      "Requirements the candidate cannot currently evidence. Distinguish mandatory domain experience from learnable tools in the text.",
    ),
  differentiation: z
    .string()
    .describe(
      "One sentence: what makes this candidate unusually relevant here versus a generic senior React developer. Say 'none identified' if there is nothing special.",
    ),
  salaryClassification: z
    .enum(["green", "yellow", "red", "unknown"])
    .describe("Compensation outlook against a $160-180k base target."),
  salaryReasoning: z
    .string()
    .describe("Why that classification, including any inference from company stage or level."),
  // Nullable, and null means EXACTLY ONE thing: this posting was only triaged,
  // so the analyst never formed these judgements. `triageOnlyAnalysis` used to
  // fill them with 0 and "moderate", which rendered as "Interview probability
  // 0% | competition moderate" - a hardcoded constant presented to a human as
  // an analyst's conclusion. That is the "never invent" rule, in the one place
  // it is easiest to break by accident.
  //
  // `.nullable()` and NOT `.optional()`: on Zod 4.4.3 a nullable field still
  // REJECTS a missing key, so a full response that simply forgot the field
  // fails validation exactly as it did before. `.optional()` would accept it,
  // quietly turning "malformed output is rejected" soft.
  interviewProbability: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe("0-100 estimated chance of reaching a first conversation if the candidate applies."),
  competitionEstimate: z
    .enum(["low", "moderate", "high", "very_high"])
    .nullable()
    .describe("Expected applicant volume based on company profile and role genericness."),
  outreachTargets: z
    .array(z.string())
    .max(6)
    .describe("Role titles worth contacting at this company, e.g. 'Head of Growth'. Titles only, never invented names."),
  reasoningSummary: z
    .string()
    .describe("2-4 sentences explaining the overall call. This is what the human reads first."),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * Which half of the analysis a stored row holds.
 *
 * `triage` is the cheap verdict alone; `full` also carries the dossier
 * (strengths, risks, missing requirements, outreach targets). They are
 * different products at different prices and must never share a cache row.
 */
export type AnalysisTier = "triage" | "full";

/**
 * The analysis schema with `lane` narrowed to the lanes this profile defines.
 *
 * Used to validate a fresh model response. The hardcoded five-lane enum this
 * replaces is why 90 of 98 solutions-engineering roles came back labelled
 * "other": `solutions_eng` was added to config and the analyst had no legal
 * way to say it. It failed silently - the model picked the closest legal
 * value, validation passed, and the lane column was wrong.
 *
 * `other` is appended and reserved as the escape hatch for a role that fits no
 * configured lane. `validateProfileCoherence` refuses a config lane named
 * `other` so the two meanings cannot collide.
 */
/**
 * The triage half of the analysis, validated as strictly as the full form.
 *
 * A separate schema rather than making the dossier fields optional on
 * `AnalysisSchema`. Optional-with-defaults would mean a FULL response that
 * simply forgot `strengths` would validate and store an empty array, which is
 * exactly the "malformed output is rejected, never stored" guarantee going
 * quietly soft. Two strict schemas keep both paths honest.
 */
export function triageSchemaFor(laneKeys: readonly string[]) {
  return z.object({
    fitScore: AnalysisSchema.shape.fitScore,
    applicationRoi: AnalysisSchema.shape.applicationRoi,
    lane: z.enum(["other", ...laneKeys] as unknown as [string, ...string[]]),
    recommendation: AnalysisSchema.shape.recommendation,
    salaryClassification: AnalysisSchema.shape.salaryClassification,
    reasoningSummary: AnalysisSchema.shape.reasoningSummary,
  });
}

export type TriageVerdict = z.infer<ReturnType<typeof triageSchemaFor>>;

/**
 * Fill the dossier half with empties for a job that was only triaged.
 *
 * Deliberately explicit rather than a `Partial<Analysis>` flowing through the
 * codebase: everything downstream already handles an empty strengths list, and
 * a reader can see at a glance that nothing was invented to fill the gap.
 */
export function triageOnlyAnalysis(v: TriageVerdict): Analysis {
  return {
    ...v,
    strengths: [],
    risks: [],
    missingRequirements: [],
    differentiation: "",
    salaryReasoning: "",
    // Null, not 0 and "moderate". The analyst did not assess these.
    interviewProbability: null,
    competitionEstimate: null,
    outreachTargets: [],
  };
}

export function analysisSchemaFor(laneKeys: readonly string[]) {
  return AnalysisSchema.extend({
    lane: z.enum(["other", ...laneKeys] as unknown as [string, ...string[]]),
    // Re-required as non-null. The base schema is nullable so a TRIAGE-ONLY
    // analysis can honestly say "not assessed"; a FULL response that answers
    // null has not done the job it was paid for, and is rejected.
    interviewProbability: AnalysisSchema.shape.interviewProbability.unwrap(),
    competitionEstimate: AnalysisSchema.shape.competitionEstimate.unwrap(),
  });
}

/**
 * Was this analysis produced by the cheap triage pass alone?
 *
 * One definition, so the meaning of "null scalars" is not re-derived at every
 * render site. Null on these two fields is set only by `triageOnlyAnalysis`
 * and only ever means "the dossier half was never bought" - `analysisSchemaFor`
 * rejects a full response that answers null, so the two cannot be confused.
 */
export function isTriageOnly(analysis: Analysis): boolean {
  return analysis.interviewProbability === null;
}

/** A job joined with its scoring and (optional) LLM analysis. */
export interface EnrichedJob extends NormalizedJob {
  status: Status;
  /** When the status last moved. Drives "days in status" in the briefing. */
  statusChangedAt: string | null;
  fitScore: number | null;
  applicationRoi: number | null;
  lane: string | null;
  priority: Priority | null;
  compensationBand: string | null;
  compensationNote: string | null;
  scoreExplanation: string | null;
  positiveSignals: string[];
  negativeSignals: string[];
  analysis: Analysis | null;
  analyzedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  notes: string | null;
}
