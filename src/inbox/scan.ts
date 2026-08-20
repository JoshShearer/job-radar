import type { JobRepo } from "../db/repo.js";
import type { Status } from "../model/status.js";
import { log } from "../lib/log.js";
import { classifyEmail, statusForKinds } from "./classify.js";
import { matchEmailToJob } from "./match.js";
import type { Email, MailSource } from "./source.js";

/**
 * Read application mail and move the jobs it is about.
 *
 * Three refusals hold this together, and all three come from the issue:
 *
 *  - READ-ONLY. Nothing here sends, replies, labels or deletes.
 *  - AMBIGUITY GOES TO REVIEW. An email that resolves to two jobs, or to none,
 *    is recorded and left alone. There is no tie-break anywhere in this path.
 *  - GHOSTED IS NOT PARSED. It is the absence of mail, so it lives in a
 *    separate sweep over elapsed time (`ghost.ts`), not here.
 */

export interface ScanSummary {
  fetched: number;
  alreadySeen: number;
  ignored: number;
  matched: number;
  transitioned: number;
  ambiguous: number;
  unmatched: number;
  changes: Array<{ jobId: string; company: string; title: string; from: string; to: string; messageId: string }>;
}

/**
 * Which current statuses an email-driven status may overwrite.
 *
 * An allowlist rather than a rank comparison, for the reason `status.ts`
 * already records: a rank cannot express these rules. A rejection is valid
 * from anywhere in flight; an interview invite must not drag a job that has
 * already reached INTERVIEW back to SCREEN, because a later email in the same
 * thread often repeats the scheduling language.
 */
const ALLOWED_FROM: Record<string, readonly string[]> = {
  REJECTED: ["SAVED", "APPLY", "APPLIED", "CONTACTED", "SCREEN", "INTERVIEW", "FINAL", "OFFER"],
  SCREEN: ["APPLY", "APPLIED", "CONTACTED"],
  OFFER: ["SCREEN", "INTERVIEW", "FINAL"],
};

export function mayTransition(from: string, to: string): boolean {
  return (ALLOWED_FROM[to] ?? []).includes(from);
}

export async function scanInbox(
  repo: JobRepo,
  source: MailSource,
  opts: { limit: number; apply: boolean; since?: string | null },
): Promise<ScanSummary> {
  const summary: ScanSummary = {
    fetched: 0, alreadySeen: 0, ignored: 0, matched: 0,
    transitioned: 0, ambiguous: 0, unmatched: 0, changes: [],
  };

  const since = opts.since !== undefined ? opts.since : repo.lastEmailAt();
  const emails: Email[] = await source.fetch({ since, limit: opts.limit });
  summary.fetched = emails.length;

  const candidates = repo.inFlightApplications();

  for (const email of emails) {
    if (repo.emailSeen(email.id)) {
      summary.alreadySeen++;
      continue;
    }

    const record = (resolution: string, jobId: string | null, appliedStatus: string | null, note: string | null,
                    kinds: string[], evidence: string[]) => {
      if (!opts.apply) return;
      repo.recordEmailEvent({
        messageId: email.id, source: source.name, from: email.from, subject: email.subject,
        receivedAt: email.receivedAt, kinds, evidence, resolution, jobId, appliedStatus, note,
      });
    };

    const { kinds, evidence } = classifyEmail(email);
    if (kinds.length === 0) {
      summary.ignored++;
      record("ignored", null, null, "no application signal", kinds, evidence);
      continue;
    }

    const match = matchEmailToJob(email, candidates);
    if (match.kind === "unmatched") {
      summary.unmatched++;
      record("unmatched", null, null, match.why, kinds, evidence);
      continue;
    }
    if (match.kind === "ambiguous") {
      // The refusal that matters most. Two applications at the same company
      // must not be guessed between - picking one would silently close the
      // others.
      summary.ambiguous++;
      record("ambiguous", null, null, `${match.why} (${match.jobs.map((j) => j.id).join(", ")})`, kinds, evidence);
      continue;
    }

    summary.matched++;
    const job = match.job;
    const target = kinds.length === 1 ? statusForKinds(kinds) : null;

    if (!target) {
      // Either a confirmation (real, but not a step forward) or an email
      // carrying two verdicts at once.
      record(
        kinds.length > 1 ? "ambiguous" : "matched",
        job.id, null,
        kinds.length > 1 ? "email carries more than one verdict" : "confirmation only",
        kinds, evidence,
      );
      if (kinds.length > 1) summary.ambiguous++;
      continue;
    }

    if (!mayTransition(job.status, target)) {
      record("matched", job.id, null, `would not move ${job.status} -> ${target}`, kinds, evidence);
      continue;
    }

    if (opts.apply) {
      repo.setStatus(job.id, target as Status, `${target} from email ${email.id}`);
    }
    summary.transitioned++;
    summary.changes.push({
      jobId: job.id, company: job.company, title: job.title,
      from: job.status, to: target, messageId: email.id,
    });
    record("matched", job.id, target, match.why, kinds, evidence);
    log.info(`  ${job.company} - ${job.title}: ${job.status} -> ${target}`);
  }

  return summary;
}
