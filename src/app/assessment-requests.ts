import type { AppContext } from "./context.js";
import type { GatewayRequest } from "./gateway.js";
import type { PostingSnapshot } from "../domain/catalog/posting.js";
import { dossierSchema, triageSchema, type Dossier, type Triage, type Assessment } from "../domain/evaluation/assessment.js";
import { assessmentSystemPrompt, assessmentUserPrompt, deterministicNote, type NoteInputs } from "../domain/llm/prompts.js";
import { renderCandidateBrief } from "../domain/candidate/brief.js";
import { cached } from "./gateway.js";

export const TRIAGE_KIND = "assessment:triage";
export const DOSSIER_KIND = "assessment:dossier";

export interface AssessmentRequests {
  triage: GatewayRequest<Triage>;
  dossier: GatewayRequest<Dossier>;
}

/**
 * Build the two requests for one posting. Used by BOTH evaluation (to look up
 * the current assessment) and assessment (to buy one), so "current" means
 * exactly "the answer to the request we would make right now".
 */
export function assessmentRequests(
  ctx: AppContext,
  brief: string,
  snapshot: PostingSnapshot,
  note: NoteInputs,
  subjectId: string,
  runId: number | null,
): AssessmentRequests {
  const config = ctx.config();
  const lanes = Object.keys(config.strategy.lanes);
  const system = assessmentSystemPrompt(brief);
  const n = deterministicNote(note);
  const budget = config.policy.assessment.description_char_budget;
  return {
    triage: {
      kind: TRIAGE_KIND,
      purpose: "assess",
      subjectId,
      runId,
      choice: config.operations.models.triage,
      prompt: { system, user: assessmentUserPrompt(snapshot, n, budget, "triage") },
      schema: triageSchema(lanes),
    },
    dossier: {
      kind: DOSSIER_KIND,
      purpose: "assess",
      subjectId,
      runId,
      choice: config.operations.models.assessment,
      prompt: { system, user: assessmentUserPrompt(snapshot, n, budget, "dossier") },
      schema: dossierSchema(lanes),
    },
  };
}

export function candidateBrief(ctx: AppContext): string | null {
  if (!ctx.hasEvidence()) return null;
  const c = ctx.config();
  return renderCandidateBrief(ctx.evidence(), c.preferences, c.strategy);
}

/** The assessment that answers the request we would make now, if one exists. Prefers the dossier. */
export function currentAssessment(ctx: AppContext, reqs: AssessmentRequests): Assessment | null {
  const d = cached(ctx, reqs.dossier);
  if (d) return { tier: "dossier", verdict: d.value };
  const t = cached(ctx, reqs.triage);
  if (t) return { tier: "triage", verdict: t.value };
  return null;
}
