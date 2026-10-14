import type { AppContext } from "./context.js";
import type { Email } from "../ports/io.js";
import type { MailMessageRecord } from "../ports/records.js";
import { classifyEmail, stateForKinds } from "../domain/outcomes/classify.js";
import { matchEmailToJob, type Candidate } from "../domain/outcomes/match.js";
import { foldApplication } from "../domain/pursuit/machines.js";
import { DAY_MS } from "../kernel/clock.js";
import { degraded, ok, refused, type UseCaseResult } from "../kernel/result.js";
import { applicationViews } from "./pursuit.js";

export interface MailSummary {
  window: { from: string; to: string } | null;
  pages: number;
  fetched: number;
  alreadySeen: number;
  ignored: number;
  unmatched: number;
  ambiguous: number;
  matchedNoChange: number;
  applied: number;
  refused: number;
  changes: Array<{ applicationId: string; company: string; to: string; messageId: string }>;
  coverage: "complete" | "partial" | "failed" | "dry-run";
}

/**
 * Read application mail and record what employers said in writing.
 *
 * READ-ONLY on the mailbox. Ambiguity goes to review, never to a guess.
 * Outcomes are events with the email's received time, so the order mail is
 * processed in cannot change the result (the fold orders by time).
 *
 * Coverage is the cursor: a window is recorded COMPLETE only after every page
 * in it was read, and the next scan starts from the last complete window
 * (minus an overlap for late-indexed mail). A failed or partial scan therefore
 * never lets a backlog be skipped, and re-reading is free (message ids are
 * idempotent).
 */
export async function scanMail(ctx: AppContext, runId: number, opts: { dryRun?: boolean } = {}): Promise<UseCaseResult<MailSummary>> {
  const summary: MailSummary = {
    window: null,
    pages: 0,
    fetched: 0,
    alreadySeen: 0,
    ignored: 0,
    unmatched: 0,
    ambiguous: 0,
    matchedNoChange: 0,
    applied: 0,
    refused: 0,
    changes: [],
    coverage: opts.dryRun ? "dry-run" : "complete",
  };
  const mailbox = ctx.mailbox();
  if (!mailbox) {
    return refused(summary, ["No mailbox configured: set the JOB_RADAR_GMAIL_* variables, or operations.mail.eml_dir."]);
  }
  const mail = ctx.config().operations.mail;
  const now = ctx.clock.now();
  const complete = ctx.store.mailScans(mailbox.name).filter((s) => s.status === "complete");
  const lastTo = complete.reduce<string | null>((m, s) => (!m || s.rangeTo > m ? s.rangeTo : m), null);
  const from = lastTo
    ? new Date(Date.parse(lastTo) - mail.overlap_days * DAY_MS).toISOString()
    : new Date(now.getTime() - mail.initial_lookback_days * DAY_MS).toISOString();
  const to = now.toISOString();
  summary.window = { from, to };

  const scanId = opts.dryRun ? null : ctx.store.beginMailScan(runId, mailbox.name, mailbox.query, from, to, to);
  const messages: Email[] = [];
  let pageToken: string | null = null;
  let error: string | null = null;
  let truncated = false;
  do {
    try {
      const page = await mailbox.page({ after: from, before: to, pageToken, pageSize: mail.page_size });
      summary.pages++;
      messages.push(...page.messages);
      pageToken = page.nextPageToken;
    } catch (err) {
      error = (err as Error).message;
      break;
    }
    if (messages.length >= mail.max_messages_per_scan && pageToken) {
      truncated = true;
      break;
    }
  } while (pageToken);
  summary.fetched = messages.length;

  messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const apps = applicationViews(ctx);
  const candidates: Candidate[] = apps
    .filter((a) => a.state !== "rejected" && a.state !== "withdrawn")
    .map((a) => ({ id: a.id, company: a.company, title: a.title, state: a.state, submittedAt: a.submittedAt }));
  const byId = new Map(apps.map((a) => [a.id, a]));

  for (const email of messages) {
    if (ctx.store.mailSeen(email.id)) {
      summary.alreadySeen++;
      continue;
    }
    const observedAt = ctx.clock.now().toISOString();
    const base: MailMessageRecord = {
      messageId: email.id,
      mailbox: mailbox.name,
      receivedAt: email.receivedAt,
      from: email.from,
      subject: email.subject,
      kinds: [],
      evidence: [],
      resolution: "ignored",
      applicationId: null,
      note: null,
      observedAt,
    };
    const { kinds, evidence } = classifyEmail(email);
    base.kinds = kinds;
    base.evidence = evidence;
    const write = (m: MailMessageRecord, event: Parameters<AppContext["store"]["recordMail"]>[1] = null) => {
      if (!opts.dryRun) ctx.store.recordMail(m, event, runId);
    };

    if (kinds.length === 0) {
      summary.ignored++;
      write({ ...base, note: "no application signal" });
      continue;
    }
    const match = matchEmailToJob(email, candidates);
    if (match.kind === "unmatched") {
      summary.unmatched++;
      write({ ...base, resolution: "unmatched", note: match.why });
      continue;
    }
    if (match.kind === "ambiguous") {
      summary.ambiguous++;
      write({ ...base, resolution: "ambiguous", note: `${match.why} (${match.jobs.map((j) => j.id).join(", ")})` });
      continue;
    }
    const appId = match.job.id;
    const target = stateForKinds(kinds);
    if (!target) {
      if (kinds.length > 1) summary.ambiguous++;
      else summary.matchedNoChange++;
      write({ ...base, resolution: kinds.length > 1 ? "ambiguous" : "matched", applicationId: appId, note: kinds.length > 1 ? "carries more than one verdict" : "confirmation only" });
      continue;
    }
    // Would this event apply, placed at its own time among the others?
    const voids = ctx.store.voids("application_event").map((v) => ({ id: v.id, voids: v.targetId }));
    const probeId = Number.MAX_SAFE_INTEGER;
    const trial = foldApplication(
      [...ctx.store.applicationEvents(appId), { id: probeId, to: target, occurredAt: email.receivedAt, actor: "mail", note: null }],
      voids,
    );
    const step = trial.steps.find((s) => s.event.id === probeId);
    if (!step?.applied) {
      summary.refused++;
      write({ ...base, resolution: "refused", applicationId: appId, note: `not applied: ${step?.reason ?? "invalid"}` });
      continue;
    }
    summary.applied++;
    summary.changes.push({ applicationId: appId, company: byId.get(appId)?.company ?? "", to: target, messageId: email.id });
    write(
      { ...base, resolution: "applied", applicationId: appId, note: match.why },
      { applicationId: appId, to: target, occurredAt: email.receivedAt, recordedAt: observedAt, actor: "mail", note: `${target} from email: ${email.subject}`.slice(0, 300), mailMessageId: email.id },
    );
    ctx.log(`  ${byId.get(appId)?.company ?? appId}: -> ${target} (${email.subject})`);
  }

  const status = error ? (summary.pages > 0 ? "partial" : "failed") : truncated ? "partial" : "complete";
  if (!opts.dryRun) {
    summary.coverage = status;
    ctx.store.finishMailScan(scanId!, status, summary.pages, summary.fetched, error ?? (truncated ? `stopped at ${mail.max_messages_per_scan} messages` : null), ctx.clock.now().toISOString());
  }
  const notes: string[] = [];
  if (error) notes.push(`Mail scan ${status}: ${error}. The cursor did not advance; the next scan re-reads this window.`);
  if (truncated) notes.push(`Stopped at ${mail.max_messages_per_scan} messages; the cursor did not advance. Run again to continue.`);
  if (summary.ambiguous || summary.unmatched) notes.push("`jr mail review` lists the mail that was not acted on.");
  if (status === "failed") return { outcome: "failed", value: summary, notes };
  return status === "partial" ? degraded(summary, notes) : ok(summary, notes);
}

/** The span of mail actually read continuously, for silence judgements. */
export function mailCoverageSpan(ctx: AppContext): { from: string; to: string } | null {
  const mailbox = ctx.mailbox();
  const scans = ctx.store.mailScans(mailbox?.name).filter((s) => s.status === "complete").sort((a, b) => a.rangeFrom.localeCompare(b.rangeFrom));
  if (!scans.length) return null;
  // Walk forward while windows overlap or touch; a gap ends continuity.
  let from = scans[0]!.rangeFrom;
  let to = scans[0]!.rangeTo;
  for (const s of scans.slice(1)) {
    if (s.rangeFrom <= to) {
      if (s.rangeTo > to) to = s.rangeTo;
    } else {
      from = s.rangeFrom;
      to = s.rangeTo;
    }
  }
  return { from, to };
}
