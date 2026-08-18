/**
 * Don't pay twice for the same document.
 *
 * The documented flow for one job is three commands chained with `&&`:
 *
 *     resume tailor <id> && apply <id> && autofill <id>
 *
 * When the third one fails - a closed posting, a form that would not fill, a
 * browser that died - the fix is to run the chain again. Both model-calling
 * steps then ran from scratch. The run log recorded 21 `resume-tailor` and 18
 * `apply` runs against 13 prepared directories.
 *
 * Cost is the smaller half of the problem. Both stages run at `effort: high`,
 * and re-running `tailor` produces a DIFFERENT resume for the same posting,
 * because which bullets to select is a model decision. So a re-run could
 * silently replace a document that had already been read, approved, or even
 * submitted, with no record that it had changed. Reuse is the correct default;
 * regenerating is the thing that needs asking for.
 *
 * WHAT INVALIDATES REUSE IS NOT THE SAME FOR BOTH INPUTS, and the difference is
 * deliberate:
 *
 * - THE POSTING CHANGED -> regenerate. The plan was selected against a set of
 *   requirements that no longer exists. This mirrors `repo.upsert`, which
 *   already drops a cached analysis when a description changes.
 * - THE MASTER RESUME CHANGED -> reuse, and say so. A saved plan cites bullet
 *   ids, and `enforceProvenance` re-checks every citation on render: an id that
 *   has since changed or vanished is dropped or reverted to master wording. So
 *   a stale plan cannot become a false one - it can only fail to consider
 *   bullets added since. That is a reason to offer `--force`, not to spend
 *   automatically.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Which generated artifact a stamp describes. */
export type Artifact = "resumePlan" | "pack";

export interface Stamp {
  /** The posting's `description_hash` when this artifact was generated. */
  descriptionHash: string;
  /** Hash of the master resume file when this artifact was generated. */
  resumeHash: string;
  generatedAt: string;
}

export type Stamps = Partial<Record<Artifact, Stamp>>;

const STAMP_FILE = "generation.json";

export function stampPath(dir: string): string {
  return resolve(dir, STAMP_FILE);
}

export function readStamps(dir: string): Stamps {
  const file = stampPath(dir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? (raw as Stamps) : {};
  } catch {
    // A corrupt stamp must not block work. Treated as "never generated", which
    // costs a regeneration and is the safe direction.
    return {};
  }
}

export function writeStamp(dir: string, artifact: Artifact, stamp: Stamp): void {
  const next: Stamps = { ...readStamps(dir), [artifact]: stamp };
  writeFileSync(stampPath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function hashFile(file: string): string {
  if (!existsSync(file)) return "";
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

export interface ReuseInput {
  /** Is the generated artifact actually on disk? */
  artifactExists: boolean;
  stamp: Stamp | undefined;
  descriptionHash: string;
  resumeHash: string;
  force: boolean;
}

export interface ReuseDecision {
  reuse: boolean;
  /** Said out loud by the caller. A silent reuse is as confusing as a silent charge. */
  why: string;
  /** The master resume moved under a plan we are still reusing. */
  resumeChanged: boolean;
}

export function decideReuse(input: ReuseInput): ReuseDecision {
  if (input.force) {
    return { reuse: false, why: "--force: regenerating from scratch", resumeChanged: false };
  }
  if (!input.artifactExists) {
    return { reuse: false, why: "nothing saved for this job yet", resumeChanged: false };
  }
  if (!input.stamp) {
    // Prepared before stamps existed. Reuse it: the artifact is real, and the
    // alternative is charging every previously prepared job once more just to
    // learn what it was generated against.
    return {
      reuse: true,
      why: "reusing what is already on disk (generated before inputs were recorded, so staleness cannot be checked)",
      resumeChanged: false,
    };
  }
  if (input.stamp.descriptionHash !== input.descriptionHash) {
    return {
      reuse: false,
      why: "the posting has changed since this was generated - regenerating against the current text",
      resumeChanged: false,
    };
  }
  const resumeChanged = input.stamp.resumeHash !== input.resumeHash;
  return {
    reuse: true,
    why: resumeChanged
      ? "reusing the saved plan; your master resume has changed since, so bullets added since then were not considered - `--force` to re-select"
      : "reusing the saved plan - the posting and your master resume are both unchanged",
    resumeChanged,
  };
}
