/**
 * Which applications have gone silent?
 *
 * GHOSTED cannot come from a parser, because it is the ABSENCE of email. No
 * message ever says "we are ghosting you", so this is a scheduled sweep over
 * elapsed time rather than anything the inbox scan can conclude.
 *
 * Pure and time-injected so a test does not have to wait a month.
 */

export interface GhostCandidate {
  id: string;
  company: string;
  title: string;
  status: string;
  /** When the job entered its current status. */
  statusChangedAt: string | null;
  /** Most recent email matched to this job, if any. */
  lastEmailAt: string | null;
}

/**
 * Silence is measured from the last CONTACT, not from the application.
 *
 * A confirmation email, a recruiter reply, or an interview invite all reset the
 * clock. Measuring from the application date instead would ghost a job that is
 * mid-conversation simply because it was applied to a while ago.
 */
export function ghostable(
  candidates: readonly GhostCandidate[],
  opts: { afterDays: number; from: string[]; now?: number },
): GhostCandidate[] {
  const now = opts.now ?? Date.now();
  const cutoff = opts.afterDays * 86_400_000;
  const eligible = new Set(opts.from);

  return candidates.filter((c) => {
    if (!eligible.has(c.status)) return false;
    const last = c.lastEmailAt ?? c.statusChangedAt;
    if (!last) return false;
    const t = Date.parse(last);
    if (Number.isNaN(t)) return false;
    return now - t > cutoff;
  });
}
