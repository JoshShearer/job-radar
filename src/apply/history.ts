import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WHAT HAS ALREADY BEEN DONE FOR A JOB, read from disk rather than from status.
 *
 * `autofill` may only write `APPLIED` when a human explicitly says they hit
 * submit (`statusAfterAutofill`). That refusal is correct and stays: the tool
 * cannot see a submit button being clicked, and guessing would mark jobs
 * applied that never were.
 *
 * But the conservative status column was then used as if it answered a
 * different question - "have I been here before?" - and it does not. On
 * 2026-08-19 the recommendation list offered four jobs that already had
 * finished packs, tailored resumes and autofill screenshots on disk: Resend,
 * Brilliant, Algolia and Samsara, all sitting at `APPLY` because nobody had
 * answered the prompt. Two of them were handed back to the user under a label
 * reading "companies you have never applied to".
 *
 * Artifacts on disk answer the question status cannot. A screenshot means a
 * browser was driven at that employer's form. That is not proof of submission
 * and this module never claims it is - `submitted` is deliberately absent. It
 * is proof the work was already done, which is all a "what should I do next"
 * list needs in order to stop repeating itself.
 */
export interface ApplicationHistory {
  /** A generated application pack exists. */
  hasPack: boolean;
  /** A tailored resume PDF exists. */
  hasResume: boolean;
  /** The form was opened and filled at least once. */
  autofillRuns: number;
  /** ISO timestamp of the most recent autofill, or null. */
  lastAutofill: string | null;
}

const EMPTY: ApplicationHistory = { hasPack: false, hasResume: false, autofillRuns: 0, lastAutofill: null };

/**
 * Read the history for one job.
 *
 * Takes the directory rather than a job so the caller owns path construction
 * (`packDir`) and this stays testable against a temp dir.
 */
export function readApplicationHistory(dir: string): ApplicationHistory {
  if (!existsSync(dir)) return EMPTY;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // An unreadable directory is not evidence of anything. Report nothing
    // rather than throwing inside a listing that is only colouring a row.
    return EMPTY;
  }

  const autofills = entries.filter((e) => e.startsWith("autofill-") && e.endsWith(".png"));
  let lastAutofill: string | null = null;
  for (const f of autofills) {
    let mtime: Date;
    try {
      mtime = statSync(resolve(dir, f)).mtime;
    } catch {
      continue;
    }
    const iso = mtime.toISOString();
    if (lastAutofill === null || iso > lastAutofill) lastAutofill = iso;
  }

  return {
    hasPack: entries.includes("pack.json"),
    hasResume: entries.some((e) => e.endsWith(".pdf") && e.includes("Resume")),
    autofillRuns: autofills.length,
    lastAutofill,
  };
}

/**
 * Has this job already had real work done on it?
 *
 * An autofill run is the threshold, not a pack. `apply` generating a pack is
 * cheap and reversible and says nothing about whether the user engaged with the
 * posting; driving a browser at the employer's own form does.
 */
export function alreadyWorked(history: ApplicationHistory): boolean {
  return history.autofillRuns > 0;
}

/** One short human-readable line, or null when there is nothing to say. */
export function describeHistory(history: ApplicationHistory): string | null {
  if (!alreadyWorked(history)) return history.hasPack ? "pack prepared" : null;
  const when = history.lastAutofill ? ` ${history.lastAutofill.slice(0, 10)}` : "";
  const times = history.autofillRuns > 1 ? ` x${history.autofillRuns}` : "";
  return `FORM ALREADY FILLED${when}${times}`;
}
