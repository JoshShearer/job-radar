import { DAY_MS } from "../../kernel/clock.js";

/**
 * Silence is not an event, so GHOSTED cannot be parsed from mail. It is a
 * SUGGESTION, never written automatically, and it is only offered when the
 * mailbox was actually read across the silent window. Without that coverage,
 * silence is unobserved, not evidence.
 */
export interface SilenceCandidate {
  applicationId: string;
  company: string;
  title: string;
  state: string;
  /** Last movement: the later of the last state change and the last matched email. */
  lastContactAt: string;
}

export interface MailCoverageSpan {
  /** Earliest instant the mailbox has been read continuously from. */
  from: string;
  /** Latest instant read. */
  to: string;
}

export type SilenceVerdict =
  | { kind: "suggest_ghosted"; days: number }
  | { kind: "unobserved"; days: number; why: string }
  | { kind: "not_silent" };

export function silenceVerdict(
  c: SilenceCandidate,
  coverage: MailCoverageSpan | null,
  opts: { afterDays: number; maxCoverageAgeDays: number; now: Date },
): SilenceVerdict {
  if (c.state !== "submitted" && c.state !== "contacted") return { kind: "not_silent" };
  const last = Date.parse(c.lastContactAt);
  if (Number.isNaN(last)) return { kind: "not_silent" };
  const days = (opts.now.getTime() - last) / DAY_MS;
  if (days <= opts.afterDays) return { kind: "not_silent" };
  if (!coverage) return { kind: "unobserved", days, why: "the mailbox has never been scanned" };
  if (Date.parse(coverage.from) > last) return { kind: "unobserved", days, why: "mail before the silence began was never scanned" };
  const lag = (opts.now.getTime() - Date.parse(coverage.to)) / DAY_MS;
  if (lag > opts.maxCoverageAgeDays) return { kind: "unobserved", days, why: `the last complete mail scan was ${Math.round(lag)} days ago` };
  return { kind: "suggest_ghosted", days };
}
