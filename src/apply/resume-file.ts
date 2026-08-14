import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { paths } from "../config/load.js";

/**
 * Which resume file gets attached to an application, and why.
 *
 * Kept out of `autofill.ts` deliberately. That module imports Playwright at
 * load time, and this is plain filesystem work - the same split that was made
 * for `detectChallenge`, and for the same reason: the decisions that end up on
 * a real application should be testable without a browser.
 *
 * The rule is recency, not filename. A filename is not evidence of anything:
 * `Shearer_Resume_Dev_March2025.pdf` sorts after `Shearer_Resume_2026.pdf`, so
 * the alphabetical rule this replaced attached a year-stale resume and said
 * nothing about having done so. Attaching the wrong resume is silent and
 * unrecoverable once a human presses submit, so the choice is both
 * deterministic and reported.
 */

const RESUME_FILE = /\.(pdf|docx?|txt|rtf)$/i;

export interface ResumeChoice {
  /** Absolute path of the file that will be attached. */
  path: string;
  /**
   * `tailored` - written for this posting by `resume tailor`, and preferred
   * over anything generic. `newest` - the most recently modified file in
   * `resumes/`. The distinction is printed in the report, so it must never be
   * inferred from a path the caller happened to pass.
   */
  source: "tailored" | "newest";
  /** Candidates that lost, newest first. Absolute paths. */
  passedOver: string[];
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

/**
 * Every resume-shaped file in `dir`, newest first.
 *
 * Ties break on the basename, compared byte-wise and descending. Two files with
 * the same mtime carry no recency signal at all, so the tie-break is arbitrary
 * by construction - its only job is to be stable, which is why it does not use
 * `localeCompare`: that is locale- and ICU-dependent, and would let the same
 * directory resolve differently on two machines. The report names what was
 * passed over, so a coin flip is visible rather than hidden.
 */
function candidates(dir: string): Candidate[] {
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const found: Candidate[] = [];
  for (const name of names) {
    if (!RESUME_FILE.test(name)) continue;
    const path = resolve(dir, name);
    try {
      // A directory named `archive.pdf` matches the extension test and would
      // throw inside `setInputFiles`, mid-run, on a form a human is watching.
      // `statSync` follows symlinks on purpose: a symlink to a resume is one.
      const st = statSync(path);
      if (!st.isFile()) continue;
      found.push({ path, mtimeMs: st.mtimeMs });
    } catch {
      // Removed between the listing and the stat. Not our problem to report.
      continue;
    }
  }

  return found.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const an = basename(a.path);
    const bn = basename(b.path);
    if (an === bn) return 0;
    return an < bn ? 1 : -1;
  });
}

/**
 * Resolve the resume to attach.
 *
 * `preferred` is the resume tailored to this specific posting. It wins over
 * everything in `dir` regardless of age - it was written for this job. If it is
 * not on disk the newest generic file is used instead, and reported as
 * `newest`: the report must not claim a provenance the attached file does not
 * have.
 */
export function chooseResume(preferred?: string, dir: string = paths.resumes()): ResumeChoice | null {
  const pool = candidates(dir);

  if (preferred && existsSync(preferred)) {
    const chosen = resolve(preferred);
    return {
      path: chosen,
      source: "tailored",
      passedOver: pool.map((c) => c.path).filter((p) => p !== chosen),
    };
  }

  const [first, ...rest] = pool;
  if (!first) return null;
  return { path: first.path, source: "newest", passedOver: rest.map((c) => c.path) };
}

/** Newest resume-looking file in `resumes/`, or null. */
export function findResume(dir: string = paths.resumes()): string | null {
  return chooseResume(undefined, dir)?.path ?? null;
}

/**
 * The line that goes in the autofill report next to the other field outcomes.
 *
 * Naming what was passed over is the point: an implicit ordering rule gives a
 * human no moment at which they would notice the wrong file went out.
 */
export function describeResumeChoice(choice: ResumeChoice, limit = 4): string {
  const name = basename(choice.path);
  const why = choice.source === "tailored" ? "tailored to this posting" : "newest in resumes/";

  if (!choice.passedOver.length) {
    // A single candidate and no tailored resume: there was no choice to report.
    return choice.source === "tailored" ? `attached ${name} (${why})` : `attached ${name}`;
  }

  const shown = choice.passedOver.slice(0, limit).map((p) => basename(p));
  const more = choice.passedOver.length > limit ? `, +${choice.passedOver.length - limit} more` : "";
  return `attached ${name} (${why}; passed over ${shown.join(", ")}${more})`;
}
