import type { AppContext } from "./context.js";
import { ImportSchema, checkImport } from "../domain/candidate/import.js";
import { lintEvidence, type LintIssue } from "../domain/candidate/evidence.js";
import { matchRequirements, type MatchReport } from "../domain/candidate/requirements.js";
import { importPrompt } from "../domain/llm/prompts.js";
import { BudgetRefusal, callModel, ModelFailure, NoModelConfigured } from "./gateway.js";
import { ok, refused, UserError, type UseCaseResult } from "../kernel/result.js";
import { snapshotFor } from "./assess.js";

/**
 * Structure an existing resume into the evidence ledger. The importer may
 * split and tag; it may not add. Anything in its output that the source text
 * does not contain is marked verified: false and listed, so an embellishing
 * importer produces unusable claims, never false ones.
 */
export async function importEvidence(
  ctx: AppContext,
  runId: number,
  source: string,
  opts: { force?: boolean } = {},
): Promise<UseCaseResult<{ claims: number; uncertain: string[]; backup: string | null }>> {
  if (ctx.hasEvidence() && !opts.force) {
    return refused({ claims: 0, uncertain: [], backup: null }, [`${ctx.paths.evidence} already exists. --force replaces it (a backup is kept).`]);
  }
  if (source.trim().length < 100) throw new UserError("That file is nearly empty. Export the resume to plain text first.");
  try {
    const r = await callModel(ctx, {
      kind: "evidence_import",
      purpose: "import",
      subjectId: null,
      runId,
      choice: ctx.config().operations.models.import,
      prompt: importPrompt(source),
      schema: ImportSchema,
    });
    const { evidence, uncertain } = checkImport(r.value, source);
    const backup = ctx.saveEvidence(evidence);
    const claims = evidence.experience.reduce((n, x) => n + x.claims.length, 0) + evidence.projects.reduce((n, x) => n + x.claims.length, 0);
    return ok({ claims, uncertain, backup }, ["Nothing was added that is not in the source. Run `jr evidence lint` next."]);
  } catch (err) {
    if (err instanceof BudgetRefusal || err instanceof NoModelConfigured) return refused({ claims: 0, uncertain: [], backup: null }, [err.message]);
    if (err instanceof ModelFailure) return { outcome: "failed", value: { claims: 0, uncertain: [], backup: null }, notes: [err.message] };
    if (err instanceof Error && err.name === "ZodError") {
      return { outcome: "failed", value: { claims: 0, uncertain: [], backup: null }, notes: [`The importer's output did not form a valid ledger: ${err.message}`] };
    }
    throw err;
  }
}

export function lint(ctx: AppContext): { issues: LintIssue[]; claims: number; usable: number } {
  const e = ctx.evidence();
  const all = [...e.experience.flatMap((r) => r.claims), ...e.projects.flatMap((p) => p.claims)];
  return { issues: lintEvidence(e), claims: all.length, usable: all.filter((c) => c.verified && c.skills.length > 0).length };
}

export function matchPosting(ctx: AppContext, opportunityId: string): { report: MatchReport; title: string; company: string } {
  const snapshot = snapshotFor(ctx, opportunityId);
  if (!snapshot) throw new UserError(`No snapshot for ${opportunityId}. Run \`jr evaluate\`.`);
  return { report: matchRequirements(ctx.evidence(), snapshot.description, ctx.clock.now()), title: snapshot.title, company: snapshot.company };
}
