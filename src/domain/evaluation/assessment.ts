import { z } from "zod";
import type { EvaluationPolicy } from "../config/schema.js";

/**
 * The analyst's structured judgement of one posting. Two tiers, two STRICT
 * schemas: a triage verdict, and a full dossier. They are different products
 * and are stored as different derivation kinds, so a triage verdict is never
 * mistaken for a dossier and there is no "null means triage" convention.
 */

export const RECOMMENDATIONS = ["apply_and_outreach", "apply", "network_or_watch", "skip"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

const laneEnum = (lanes: readonly string[]) => z.enum(["other", ...lanes] as [string, ...string[]]);

export function triageSchema(lanes: readonly string[]) {
  return z
    .object({
      fitScore: z.number().int().min(0).max(100).describe("0-100 semantic fit for this candidate specifically."),
      applicationRoi: z
        .number()
        .int()
        .min(0)
        .max(100)
        .describe("0-100: is this worth the candidate's limited time? Weigh differentiation and applicant volume."),
      lane: laneEnum(lanes).describe("Which target role family this belongs to, or `other` if none fits."),
      recommendation: z.enum(RECOMMENDATIONS),
      salaryClassification: z
        .enum(["green", "yellow", "red", "unknown"])
        .describe("Compensation outlook against the candidate's stated target band."),
      reasoningSummary: z.string().min(1).describe("2-4 sentences explaining the call. The human reads this first."),
    })
    .strict();
}

export function dossierSchema(lanes: readonly string[]) {
  return triageSchema(lanes)
    .extend({
      strengths: z
        .array(z.string())
        .max(8)
        .describe("Evidence-backed reasons the candidate is strong for THIS role. Cite claim ids like [c:role-1-b2]."),
      risks: z.array(z.string()).max(8).describe("Concrete concerns: gaps, competition, seniority mismatch, comp risk."),
      missingRequirements: z
        .array(
          z
            .object({
              requirement: z.string(),
              kind: z.enum(["mandatory_domain", "learnable_tool"]),
              required: z.boolean().describe("True if the posting requires it, false if preferred."),
            })
            .strict(),
        )
        .max(10)
        .describe("Requirements the candidate cannot evidence from the claims provided."),
      differentiation: z.string().describe("What makes the candidate unusually relevant here, or 'none identified'."),
      salaryReasoning: z.string(),
      interviewProbability: z.number().int().min(0).max(100).describe("0-100 chance of a first conversation if they apply."),
      competitionEstimate: z.enum(["low", "moderate", "high", "very_high"]),
      outreachTargets: z.array(z.string()).max(6).describe("Role TITLES worth contacting. Never invent a person's name."),
    })
    .strict();
}

export type Triage = z.infer<ReturnType<typeof triageSchema>>;
export type Dossier = z.infer<ReturnType<typeof dossierSchema>>;

export type AssessmentTier = "triage" | "dossier";

/** A stored assessment: the tier is explicit, never inferred from null fields. */
export type Assessment =
  | { tier: "triage"; verdict: Triage }
  | { tier: "dossier"; verdict: Dossier };

/**
 * Does this triage verdict earn the second, expensive call? Deterministic:
 * it decides where money goes, so it must be reproducible and auditable.
 */
export function earnsDossier(v: Triage, policy: EvaluationPolicy["assessment"]): boolean {
  if ((policy.dossier_for as readonly string[]).includes(v.recommendation)) return true;
  return v.fitScore >= policy.dossier_min_fit;
}

export function dossierReason(v: Triage, policy: EvaluationPolicy["assessment"]): string {
  if ((policy.dossier_for as readonly string[]).includes(v.recommendation)) return `verdict ${v.recommendation}`;
  if (v.fitScore >= policy.dossier_min_fit) return `fit ${v.fitScore} >= ${policy.dossier_min_fit}`;
  return `triage only (${v.recommendation}, fit ${v.fitScore})`;
}

export type Endorsement = "endorsed" | "unendorsed";

export function endorsement(a: Assessment): Endorsement {
  const r = a.verdict.recommendation;
  return r === "apply" || r === "apply_and_outreach" ? "endorsed" : "unendorsed";
}

/** Truncate the analyst's own words on a word boundary; never re-summarise. */
export function reasonExcerpt(a: Assessment, max = 240): string {
  const s = a.verdict.reasoningSummary.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${cut.slice(0, at > 0 ? at : max)}...`;
}
