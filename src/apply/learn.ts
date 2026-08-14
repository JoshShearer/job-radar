import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument, YAMLSeq } from "yaml";
import { classifyLabel, isNeverFill, normalizeLabel, type FieldIntent } from "./fields.js";
import type { FieldOutcome } from "./autofill.js";

/**
 * Learning answers from the browser.
 *
 * `personal.yaml` has always had an `answers` list, checked before every
 * built-in rule, and the example config says what it is for: answer a question
 * once and it answers itself from then on. Nothing ever wrote to it, so every
 * free-text answer typed into a form was thrown away when the window closed and
 * the next application started from nothing.
 *
 * Capturing is safe here for one specific reason: the human typed it. That
 * gives it exactly the same standing as anything else in that file - a stated
 * fact, not an inference. Nothing in this module composes, guesses, or
 * rephrases an answer.
 *
 * Two categories are never captured, and they are the same two the tool refuses
 * to answer in the first place. Storing a demographic answer would make the tool
 * disclose it automatically on the next form, and storing an attestation would
 * have software certify something on a person's behalf. Both would convert a
 * refusal into an answer by the back door, which is worse than never having
 * learned anything.
 */

export interface FieldSnapshot {
  label: string;
  intent: FieldIntent;
  kind: string;
  value: string;
}

export interface LearnedAnswer {
  match: string;
  answer: string;
}

/** Only free text is worth learning. A file input or a tickbox is not an answer. */
const LEARNABLE_KINDS = new Set(["text", "textarea"]);

/**
 * Intents already sourced from `personal.yaml`. Capturing these would store a
 * second copy of a fact the config already holds, and the copy is the one that
 * goes stale.
 */
const ALREADY_CONFIGURED: ReadonlySet<FieldIntent> = new Set<FieldIntent>([
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "city",
  "state",
  "country",
  "location",
  "linkedin",
  "github",
  "twitter",
  "website",
  "resume",
  "cover_letter",
  "work_authorization",
  "sponsorship",
  "current_company",
  "current_title",
]);

/** Long enough to identify the question, short enough to stay readable in YAML. */
const MATCH_CAP = 120;

/**
 * What a human typed that the tool did not, and that is worth keeping.
 *
 * `existing` is compared the same way `decide()` compares it - normalized
 * substring - so an answer already saved is never duplicated under a slightly
 * different wording.
 */
export function capturableAnswers(
  snapshot: ReadonlyArray<FieldSnapshot>,
  outcomes: ReadonlyArray<FieldOutcome>,
  existing: ReadonlyArray<{ match: string; answer: string }>,
): LearnedAnswer[] {
  const filledByTool = new Set(
    outcomes.filter((o) => o.status === "filled").map((o) => normalizeLabel(o.label)),
  );
  const known = existing.map((e) => normalizeLabel(e.match)).filter(Boolean);

  const out: LearnedAnswer[] = [];
  const seen = new Set<string>();

  for (const f of snapshot) {
    if (!LEARNABLE_KINDS.has(f.kind)) continue;

    const answer = f.value.trim();
    if (!answer) continue;

    const label = f.label.trim();
    const normalized = normalizeLabel(label);
    if (!normalized) continue;

    // The guard is re-derived from the label rather than trusted from the
    // snapshot: whatever intent arrives here, a demographic or attestation
    // question is refused on its own wording.
    if (isNeverFill(f.intent) || isNeverFill(classifyLabel(label))) continue;
    if (ALREADY_CONFIGURED.has(f.intent)) continue;

    if (filledByTool.has(normalized)) continue;
    if (known.some((k) => normalized.includes(k))) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    out.push({ match: label.slice(0, MATCH_CAP), answer });
  }

  return out;
}

/**
 * Append answers to `personal.yaml`, preserving the file a human wrote.
 *
 * Edited through the YAML document rather than the parsed object, so comments
 * and formatting survive - this is a hand-maintained config, and rewriting it
 * from a parsed value would silently strip everything explaining it. The
 * original is copied aside first; that file is the candidate's own statement of
 * fact and software does not get to be the only copy of it.
 */
export function saveAnswers(file: string, entries: ReadonlyArray<LearnedAnswer>): string | null {
  if (!entries.length) return null;

  const original = readFileSync(file, "utf8");
  const backup = `${file}.${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.bak`;
  copyFileSync(file, backup);

  const doc = parseDocument(original);
  let list = doc.get("answers");
  if (!(list instanceof YAMLSeq)) {
    list = new YAMLSeq();
    doc.set("answers", list);
  }

  for (const e of entries) {
    (list as YAMLSeq).add(doc.createNode({ match: e.match, answer: e.answer }));
  }

  writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  return backup;
}
