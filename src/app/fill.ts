import type { AppContext } from "./context.js";
import type { FieldOutcome } from "../ports/io.js";
import { capturableAnswers } from "../domain/browser/learn.js";
import type { FieldIntent } from "../domain/browser/fields.js";
import { ok, refused, UserError, type UseCaseResult } from "../kernel/result.js";
import { fillMaterials, verdictLine } from "./materials.js";
import { recordSubmission } from "./pursuit.js";
import { snapshotFor } from "./assess.js";

export interface FillResult {
  filled: number;
  needsYou: number;
  report: string | null;
  submittedRecorded: boolean;
  learned: number;
}

/**
 * Open the employer's form in an ordinary browser, fill what the rules can,
 * and hand the window to the human. Never submits, never ticks a checkbox,
 * never answers demographics or attestations, never invents an unknown.
 *
 * Only an APPROVED pack's answers and cover letter are used. Whether the form
 * was submitted is asked AFTER the window closes, and only the human's "yes"
 * records it; nothing is inferred from the page.
 */
export async function fill(
  ctx: AppContext,
  runId: number,
  opportunityId: string,
  opts: { headless?: boolean; override?: boolean } = {},
): Promise<UseCaseResult<FillResult>> {
  const result: FillResult = { filled: 0, needsYou: 0, report: null, submittedRecorded: false, learned: 0 };
  const personal = ctx.personal();
  if (!personal) throw new UserError(`No personal details. Create ${ctx.paths.personal} (see config.example/candidate/personal.yaml).`);
  const row = ctx.store.rankingFor(opportunityId);
  if (!row) throw new UserError(`No evaluated posting ${opportunityId}.`);
  const snapshot = snapshotFor(ctx, opportunityId);
  if (!snapshot) throw new UserError(`No snapshot for ${opportunityId}.`);

  if ((row.postingState === "closed" || row.postingState === "missing") && !opts.override) {
    return refused(result, [`${row.company} - ${row.title} looks ${row.postingState}. If you know it is live: jr fill ${opportunityId} --override`]);
  }

  const m = fillMaterials(ctx, opportunityId);
  const notes: string[] = [];
  if (!m.resume?.manifest.attachment) notes.push("No tailored resume PDF for this posting; the resume field will be left for you.");
  if (!m.approvedPack) notes.push("No APPROVED pack: no drafted answers or cover letter will be used. `jr prepare` then `jr approve`.");
  if (m.unapprovedNewer) notes.push("A newer pack generation exists but is not approved; the older approved one is used.");

  const session = await ctx.browser().fill({
    url: snapshot.applicationUrl ?? snapshot.sourceUrl,
    company: snapshot.company,
    title: snapshot.title,
    personal,
    evidence: ctx.hasEvidence() ? ctx.evidence() : null,
    answers: m.approvedPack?.manifest.answers ?? [],
    resumePath: m.resume?.manifest.attachment ? ctx.artifacts.path(m.resume.dir, m.resume.manifest.attachment) : null,
    coverLetterPath: m.approvedPack?.manifest.coverLetter ? ctx.artifacts.path(m.approvedPack.dir, m.approvedPack.manifest.coverLetter) : null,
    screenshotDir: ctx.paths.reports,
    headless: opts.headless === true,
  });

  result.filled = session.outcomes.filter((o) => o.status === "filled").length;
  result.needsYou = session.outcomes.filter((o) => o.status === "needs_you").length;
  const report = renderFillReport(row.company, row.title, verdictLine(row), session.outcomes, [...notes, ...session.notes], session.screenshot);
  const stamp = ctx.clock.now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  result.report = ctx.writeReport(`fill-${opportunityId}-${stamp}.md`, report);
  ctx.log(report);

  if (opts.headless) {
    await session.close();
    return ok(result, [...notes, "Dry run: nothing was submitted and the filled form was discarded."]);
  }

  ctx.log("The form is filled and NOT submitted. Review every field, then press the button yourself. Close the window when done.");
  const { interrupted, snapshot: fields } = await session.waitForClose();

  const learnable = capturableAnswers(
    fields.map((f) => ({ ...f, intent: f.intent as FieldIntent })),
    session.outcomes,
    personal.answers,
  );
  if (learnable.length) {
    ctx.log(`You answered ${learnable.length} question(s) by hand:`);
    for (const a of learnable) ctx.log(`  Q: ${a.match}\n  A: ${a.answer.length > 100 ? `${a.answer.slice(0, 99)}...` : a.answer}`);
    if (await ctx.prompter.confirm("Save these to personal.yaml so they fill themselves next time?")) {
      const backup = ctx.saveLearnedAnswers(learnable);
      result.learned = learnable.length;
      notes.push(`Saved ${learnable.length} answer(s). Backup: ${backup}`);
    }
  }

  if (!interrupted && (await ctx.prompter.confirm("Did you submit it yourself? Record the submission?"))) {
    const r = recordSubmission(ctx, runId, opportunityId, { note: "confirmed after fill" });
    result.submittedRecorded = r.outcome === "ok";
    notes.push(...r.notes, ...(r.outcome === "ok" ? [`Recorded application ${r.value.applicationId}.`] : []));
  }
  return ok(result, notes);
}

export function renderFillReport(
  company: string,
  title: string,
  verdict: string,
  outcomes: readonly FieldOutcome[],
  notes: readonly string[],
  screenshot: string | null,
): string {
  const filled = outcomes.filter((o) => o.status === "filled");
  const needs = outcomes.filter((o) => o.status === "needs_you");
  const left = outcomes.filter((o) => o.status === "left_alone");
  const t = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
  const L = [`# Fill report - ${title}, ${company}`, "", "```", `Filled : ${filled.length}`, `For you: ${needs.length}`, `Verdict: ${verdict}`, "Status : NOT SUBMITTED - the submit button was never touched", "```", ""];
  for (const n of notes) L.push(`> ${n}`);
  if (notes.length) L.push("");
  if (needs.length) L.push("## You need to handle these", "", ...needs.map((o) => `- **${t(o.label, 90)}** - ${o.why}`), "");
  L.push("## Filled", "", ...filled.map((o) => `- ${t(o.label, 70)} = ${o.why}`), "");
  if (left.length) L.push("## Left alone", "", ...left.map((o) => `- ${t(o.label, 70)} - ${o.why}`), "");
  if (screenshot) L.push(`Screenshot: ${screenshot}`, "");
  L.push("---", "", "Read every field before you submit. Nothing here was sent.");
  return L.join("\n");
}
