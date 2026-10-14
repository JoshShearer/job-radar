import type { AppContext } from "./context.js";
import { runSpend } from "./spend.js";
import type { ArtifactManifest, ArtifactRecord, RankingRecord } from "../ports/records.js";
import type { PostingSnapshot } from "../domain/catalog/posting.js";
import { materialPosting } from "../domain/catalog/normalize.js";
import { evidenceVersion, lintEvidence, type Evidence } from "../domain/candidate/evidence.js";
import { contactLine } from "../domain/candidate/personal.js";
import { matchRequirements } from "../domain/candidate/requirements.js";
import { renderCandidateBrief } from "../domain/candidate/brief.js";
import { ResumePlanSchema, packSchema, type PackPlan, type ResumePlan } from "../domain/materials/plan.js";
import { checkPack, composeResume, answerText, type CheckedPack } from "../domain/materials/compose.js";
import { MATERIAL_RULES_VERSION, verifyContext } from "../domain/materials/verify.js";
import {
  coverLetterHtml,
  coverLetterMarkdown,
  matchReportMarkdown,
  packReviewMarkdown,
  repairsMarkdown,
  resumeHtml,
  resumeMarkdown,
} from "../domain/materials/render.js";
import { documentBase } from "../domain/materials/documents.js";
import { packPrompt, tailorPrompt } from "../domain/llm/prompts.js";
import { validateStructured } from "../domain/llm/structured.js";
import { mayBeginPreparing } from "../domain/pursuit/machines.js";
import { reasonExcerpt } from "../domain/evaluation/assessment.js";
import { hashInput, shortId } from "../kernel/hash.js";
import { degraded, ok, refused, UserError, type UseCaseResult } from "../kernel/result.js";
import { BudgetRefusal, callModel, ModelFailure, NoModelConfigured } from "./gateway.js";
import { ensureDossier, snapshotFor } from "./assess.js";
import { pursuitOf } from "./pursuit.js";

export const RESUME_PLAN_KIND = "resume_plan";
export const PACK_PLAN_KIND = "pack_plan";

export interface MaterialsResult {
  generationId: string | null;
  dir: string | null;
  reused: boolean;
  spentUsd: number;
  notes: string[];
}

interface Gated {
  row: RankingRecord;
  snapshot: PostingSnapshot;
  notes: string[];
}

/**
 * The gates in front of every preparation, declared once:
 *
 *   closed   a posting its board stopped listing is refused (spending on a
 *            dead requisition is waste), unless overridden
 *   verdict  a posting the analyst did not endorse is refused, unless
 *            overridden; an unassessed one warns and proceeds (the only way to
 *            satisfy that gate would be to spend on an assessment)
 *
 * An override is recorded as a fact, so the disagreement is auditable. The
 * human outranks the analyst; the point is that it is never silent.
 */
async function gate(
  ctx: AppContext,
  runId: number,
  opportunityId: string,
  override: boolean,
  command: string,
  enforce = true,
): Promise<Gated | { refusal: string }> {
  const row = ctx.store.rankingFor(opportunityId);
  if (!row) throw new UserError(`No evaluated posting ${opportunityId}. Run \`jr evaluate\`.`);
  const snapshot = snapshotFor(ctx, opportunityId);
  if (!snapshot) throw new UserError(`No snapshot for ${opportunityId}.`);
  const notes: string[] = [];
  // The gates guard SPENDING. A free re-render of material already bought
  // spends nothing, so it skips them (and records no override).
  if (!enforce) return { row, snapshot, notes };
  const at = ctx.clock.now().toISOString();

  if (row.postingState === "closed" || row.postingState === "missing") {
    const msg = `${row.company} - ${row.title} looks ${row.postingState}: its board's latest complete sweep no longer lists it.`;
    if (!override) return { refusal: `${msg}\nNothing was spent. If you know it is live: jr ${command} ${opportunityId} --override` };
    ctx.store.recordOverride(opportunityId, "posting_state", row.postingState, at, runId);
    notes.push(`Overrode: ${msg}`);
  }

  if (row.analystRec && row.analystRec !== "apply" && row.analystRec !== "apply_and_outreach") {
    const msg = `The analyst said ${row.analystRec.replace(/_/g, " ")} (fit ${row.analystFit}). Its reasoning: ${row.detail.analystSummary ?? "(none recorded)"}`;
    if (!override) return { refusal: `${row.company} - ${row.title} is not endorsed. ${msg}\nNothing was spent. If you disagree: jr ${command} ${opportunityId} --override` };
    ctx.store.recordOverride(opportunityId, "verdict", row.analystRec, at, runId);
    notes.push(`Overrode the analyst: ${msg}`);
  } else if (!row.analystRec) {
    notes.push(
      row.staleAssessment
        ? "The standing assessment is stale (the posting or the evidence changed since). Proceeding without a verdict."
        : "This posting has not been assessed. Proceeding without a verdict; `jr assess` gives a much better package.",
    );
  } else if (row.analystTier === "triage") {
    const d = await ensureDossier(ctx, runId, row);
    notes.push(`Endorsed on triage; ${d.note}.`);
  }
  return { row, snapshot, notes };
}

function lintOrThrow(e: Evidence): void {
  const errors = lintEvidence(e).filter((i) => i.level === "error");
  if (errors.length) {
    throw new UserError(`The evidence ledger has errors; fix them first (\`jr evidence lint\`):\n${errors.slice(0, 5).map((i) => `  ${i.where}: ${i.message}`).join("\n")}`);
  }
}

function advancePursuit(ctx: AppContext, runId: number, opportunityId: string, note: string): string | null {
  const p = pursuitOf(ctx, opportunityId);
  if (!mayBeginPreparing(p.state)) return null;
  const at = ctx.clock.now().toISOString();
  ctx.store.appendPursuitEvent({ opportunityId, to: "preparing", occurredAt: at, recordedAt: at, actor: "system", note }, runId);
  return `Pursuit ${p.state} -> preparing.`;
}

async function pdfOrNull(ctx: AppContext, html: string, notes: string[]): Promise<Uint8Array | null> {
  try {
    return await ctx.pdf.render(html);
  } catch (err) {
    notes.push(`PDF rendering failed (${(err as Error).message}); the generation has Markdown and HTML only. No older PDF stands in for it.`);
    return null;
  }
}

/* ------------------------------------------------------------------ resume */

export async function tailor(
  ctx: AppContext,
  runId: number,
  opportunityId: string,
  opts: { override?: boolean; force?: boolean; noCall?: boolean } = {},
): Promise<UseCaseResult<MaterialsResult>> {
  const result: MaterialsResult = { generationId: null, dir: null, reused: false, spentUsd: 0, notes: [] };
  const evidence = ctx.evidence();
  lintOrThrow(evidence);
  const g = await gate(ctx, runId, opportunityId, opts.override === true, "tailor", opts.noCall !== true);
  if ("refusal" in g) return refused(result, [g.refusal]);
  result.notes.push(...g.notes);
  const config = ctx.config();
  const material = hashInput(materialPosting(g.snapshot));
  // The ledger AND the rules it was checked under: either changing re-composes.
  const evVersion = `${evidenceVersion(evidence)}/rules-${MATERIAL_RULES_VERSION}`;
  const now = ctx.clock.now();

  // Reuse rule: a changed POSTING re-plans; a changed EVIDENCE LEDGER reuses
  // the plan and re-verifies every citation against the current ledger, so a
  // stale plan can miss new claims but can never assert a removed one.
  const latest = ctx.store.artifacts(opportunityId, "resume")[0];
  let plan: ResumePlan | null = null;
  let planKey: string | null = null;
  if (latest && latest.postingMaterial === material && !opts.force) {
    const d = ctx.store.getDerivation(RESUME_PLAN_KIND, latest.planKey);
    const v = d ? validateStructured(ResumePlanSchema, d.output) : null;
    if (v?.ok) {
      plan = v.value;
      planKey = latest.planKey;
      result.reused = true;
      if (latest.evidenceVersion === evVersion) {
        result.generationId = latest.id;
        result.dir = latest.dir;
        result.notes.push("Reused: the current generation already matches this posting and the evidence ledger. `--force` re-plans.");
        return ok(result, result.notes);
      }
      result.notes.push("The evidence ledger or the verification rules changed since this plan was made; re-composing and re-verifying it at no cost.");
    }
  }
  if (!plan) {
    if (opts.noCall) return refused(result, ["No saved plan for this posting. Run `jr tailor` first."]);
    const match = matchRequirements(evidence, g.snapshot.description, now);
    try {
      const r = await callModel(ctx, {
        kind: RESUME_PLAN_KIND,
        purpose: "tailor",
        subjectId: opportunityId,
        runId,
        choice: config.operations.models.tailor,
        prompt: tailorPrompt(evidence, g.snapshot, match),
        schema: ResumePlanSchema,
        ...(opts.force ? { salt: now.toISOString() } : {}),
      });
      plan = r.value;
      planKey = r.key;
      result.spentUsd += r.costUsd;
    } catch (err) {
      if (err instanceof BudgetRefusal || err instanceof NoModelConfigured) return refused(result, [err.message]);
      if (err instanceof ModelFailure) return { outcome: "failed", value: { ...result, spentUsd: runSpend(ctx, runId) }, notes: [err.message] };
      throw err;
    }
  }

  const ctxV = verifyContext(evidence, targetContext(g.snapshot));
  const { resume, repairs } = composeResume(evidence, plan, ctxV);
  const contact = contactLine(ctx.personal());
  const base = documentBase(evidence.basics.name, g.snapshot.company, "Resume");
  const match = matchRequirements(evidence, g.snapshot.description, now);
  const html = resumeHtml(resume, contact);
  const pdf = await pdfOrNull(ctx, html, result.notes);
  const files: Record<string, string | Uint8Array> = {
    [`${base}.md`]: resumeMarkdown(resume, contact),
    [`${base}.html`]: html,
    "requirement-match.md": matchReportMarkdown(g.snapshot.title, g.snapshot.company, match),
    "repairs.md": `# Verification\n\n${repairsMarkdown(repairs)}\n\n## Gaps to expect\n\n${plan.gapsToExpect.map((x) => `- ${x}`).join("\n") || "(none)"}\n\n## Do NOT claim\n\n${plan.doNotClaim.map((x) => `- ${x}`).join("\n") || "(none)"}\n`,
    "plan.json": JSON.stringify(plan, null, 2),
  };
  if (pdf) files[`${base}.pdf`] = pdf;

  const generationId = shortId(`${opportunityId}|resume|${planKey}|${evVersion}|${now.toISOString()}`, 10);
  const published = ctx.artifacts.publish(opportunityId, `resume-${generationId}`, files);
  const manifest: ArtifactManifest = {
    files: published.files,
    attachment: pdf ? `${base}.pdf` : null,
    coverLetter: null,
    answers: [],
    repairs: repairs.length,
    rejectedSentences: 0,
  };
  ctx.store.recordArtifact(
    { id: generationId, opportunityId, kind: "resume", planKey: planKey!, postingMaterial: material, evidenceVersion: evVersion, dir: published.dir, manifest, createdAt: now.toISOString() },
    runId,
  );
  result.generationId = generationId;
  result.dir = published.dir;
  if (repairs.length) result.notes.push(`${repairs.length} selection(s) repaired by the verifier; see repairs.md.`);
  const moved = advancePursuit(ctx, runId, opportunityId, "resume tailored");
  if (moved) result.notes.push(moved);
  return pdf ? ok(result, result.notes) : degraded(result, result.notes);
}

/* -------------------------------------------------------------------- pack */

function describeAssessment(row: RankingRecord): string {
  if (!row.analystRec) return "No assessment. Work from the posting alone.";
  const lines = [`Fit ${row.analystFit} / ROI ${row.analystRoi} / ${row.analystRec}`];
  if (row.analystTier === "triage") lines.push("Triage only; no dossier.");
  if (row.detail.analystSummary) lines.push(row.detail.analystSummary);
  return lines.join("\n");
}

export async function preparePack(
  ctx: AppContext,
  runId: number,
  opportunityId: string,
  opts: { override?: boolean; force?: boolean; full?: boolean } = {},
): Promise<UseCaseResult<MaterialsResult & { rejected: number }>> {
  const result = { generationId: null as string | null, dir: null as string | null, reused: false, spentUsd: 0, notes: [] as string[], rejected: 0 };
  const evidence = ctx.evidence();
  lintOrThrow(evidence);
  const g = await gate(ctx, runId, opportunityId, opts.override === true, "prepare");
  if ("refusal" in g) return refused(result, [g.refusal]);
  result.notes.push(...g.notes);
  const config = ctx.config();
  const full = opts.full === true;
  const material = hashInput(materialPosting(g.snapshot));
  // The ledger AND the rules it was checked under: either changing re-composes.
  const evVersion = `${evidenceVersion(evidence)}/rules-${MATERIAL_RULES_VERSION}`;
  const now = ctx.clock.now();
  const schema = packSchema(full);

  const latest = ctx.store.artifacts(opportunityId, "pack").find((a) => a.postingMaterial === material);
  let plan: PackPlan | null = null;
  let planKey: string | null = null;
  if (latest && !opts.force) {
    const d = ctx.store.getDerivation(PACK_PLAN_KIND, latest.planKey);
    const v = d ? validateStructured(schema, d.output) : null;
    if (v?.ok) {
      plan = v.value as PackPlan;
      planKey = latest.planKey;
      result.reused = true;
      if (latest.evidenceVersion === evVersion) {
        result.generationId = latest.id;
        result.dir = latest.dir;
        result.notes.push("Reused the current pack generation. `--force` regenerates (and needs a fresh approval).");
        return ok(result, result.notes);
      }
      result.notes.push("The evidence ledger or the verification rules changed; re-verifying the saved pack at no cost.");
    }
  }
  if (!plan) {
    const brief = renderCandidateBrief(evidence, config.preferences, config.strategy);
    try {
      const r = await callModel(ctx, {
        kind: PACK_PLAN_KIND,
        purpose: "prepare",
        subjectId: opportunityId,
        runId,
        choice: config.operations.models.pack,
        prompt: packPrompt(brief, g.snapshot, describeAssessment(g.row), full),
        schema,
        ...(opts.force ? { salt: now.toISOString() } : {}),
      });
      plan = r.value as PackPlan;
      planKey = r.key;
      result.spentUsd += r.costUsd;
    } catch (err) {
      if (err instanceof BudgetRefusal || err instanceof NoModelConfigured) return refused(result, [err.message]);
      if (err instanceof ModelFailure) return { outcome: "failed", value: { ...result, spentUsd: runSpend(ctx, runId) }, notes: [err.message] };
      throw err;
    }
  }

  const checked: CheckedPack = checkPack(plan, verifyContext(evidence, targetContext(g.snapshot)));
  result.rejected = checked.rejectedCount;
  const contact = contactLine(ctx.personal());
  const base = documentBase(evidence.basics.name, g.snapshot.company, "Cover_Letter");
  const letterHtml = coverLetterHtml(evidence.basics.name, g.snapshot.company, g.snapshot.title, checked, contact);
  const hasLetter = checked.coverLetter.some((p) => p.some((s) => s.status !== "rejected"));
  const pdf = hasLetter ? await pdfOrNull(ctx, letterHtml, result.notes) : null;
  const files: Record<string, string | Uint8Array> = {
    "pack-review.md": packReviewMarkdown(g.snapshot.company, g.snapshot.title, checked),
    "pack.json": JSON.stringify(checked, null, 2),
  };
  if (hasLetter) {
    files[`${base}.md`] = coverLetterMarkdown(evidence.basics.name, g.snapshot.company, g.snapshot.title, checked, contact);
    files[`${base}.html`] = letterHtml;
    if (pdf) files[`${base}.pdf`] = pdf;
  }
  const generationId = shortId(`${opportunityId}|pack|${planKey}|${evVersion}|${now.toISOString()}`, 10);
  const published = ctx.artifacts.publish(opportunityId, `pack-${generationId}`, files);
  const answers = checked.formAnswers
    .map((a) => ({ question: a.question, answer: answerText(a) }))
    .filter((a): a is { question: string; answer: string } => a.answer !== null);
  const manifest: ArtifactManifest = {
    files: published.files,
    attachment: null,
    coverLetter: pdf ? `${base}.pdf` : null,
    answers,
    repairs: 0,
    rejectedSentences: checked.rejectedCount,
  };
  ctx.store.recordArtifact(
    { id: generationId, opportunityId, kind: "pack", planKey: planKey!, postingMaterial: material, evidenceVersion: evVersion, dir: published.dir, manifest, createdAt: now.toISOString() },
    runId,
  );
  result.generationId = generationId;
  result.dir = published.dir;
  if (checked.rejectedCount) result.notes.push(`${checked.rejectedCount} sentence(s) were refused by the verifier and removed; pack-review.md lists them.`);
  result.notes.push(`Review pack-review.md, then \`jr approve ${opportunityId}\` before \`jr fill\` will type any of it into a form.`);
  const moved = advancePursuit(ctx, runId, opportunityId, "application pack prepared");
  if (moved) result.notes.push(moved);
  return ok(result, result.notes);
}

/* ---------------------------------------------------------------- approval */

/**
 * The human has read a pack generation and stands behind it. Only an approved
 * generation's answers and cover letter are ever typed into or attached to a
 * form. Approval is per generation: a regenerated pack needs a new one.
 */
export function approve(ctx: AppContext, opportunityId: string, generationId?: string, note?: string): UseCaseResult<{ generationId: string; dir: string }> {
  const packs = ctx.store.artifacts(opportunityId, "pack");
  const target = generationId ? packs.find((p) => p.id === generationId) : packs[0];
  if (!target) throw new UserError(`No pack generation for ${opportunityId}${generationId ? ` with id ${generationId}` : ""}. Run \`jr prepare\`.`);
  if (target.approvedAt) return ok({ generationId: target.id, dir: target.dir }, [`Already approved at ${target.approvedAt}.`]);
  ctx.store.approveArtifact(target.id, ctx.clock.now().toISOString(), note ?? null);
  return ok({ generationId: target.id, dir: target.dir }, [`Approved pack ${target.id}.`]);
}

/** The documents `fill` may use: the latest resume, and the latest APPROVED pack. */
export function fillMaterials(ctx: AppContext, opportunityId: string): {
  resume: ArtifactRecord | null;
  approvedPack: ArtifactRecord | null;
  unapprovedNewer: boolean;
} {
  const resume = ctx.store.artifacts(opportunityId, "resume")[0] ?? null;
  const packs = ctx.store.artifacts(opportunityId, "pack");
  const approvedPack = packs.find((p) => p.approvedAt) ?? null;
  // Only meaningful when an approved pack exists to fall back to.
  const unapprovedNewer = approvedPack !== null && packs[0] !== approvedPack;
  return { resume, approvedPack, unapprovedNewer };
}

export function verdictLine(row: RankingRecord): string {
  if (!row.analystRec) return row.staleAssessment ? "stale assessment (inputs changed)" : "not assessed";
  return `${row.analystRec.replace(/_/g, " ")} (fit ${row.analystFit}, ${row.analystTier})`;
}

export { reasonExcerpt };

/** Words that describe the TARGET and may be named without evidence: employer, role, and the posting's own team. */
function targetContext(p: PostingSnapshot): string[] {
  return [p.company, p.title, p.department, p.team].filter((x): x is string => typeof x === "string" && x.length > 0);
}
