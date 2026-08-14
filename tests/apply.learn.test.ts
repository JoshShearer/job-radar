import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { capturableAnswers, saveAnswers, type FieldSnapshot } from "../src/apply/learn.js";
import { loadPersonal } from "../src/config/personal.js";
import type { FieldOutcome } from "../src/apply/autofill.js";

/**
 * JOB-14. The point of the tool is that a question answered once stays
 * answered. `personal.yaml` has always had the `answers` list to make that
 * work, and nothing ever wrote to it, so every free-text answer typed into a
 * browser was thrown away when the window closed.
 *
 * Capturing what a human typed is safe precisely because THEY typed it. The
 * two categories that must never be captured are the two the tool refuses to
 * answer in the first place: storing a demographic answer would make the tool
 * disclose it automatically on the next form, and storing an attestation would
 * make software certify something on a person's behalf. Those are the tests
 * that matter here.
 */

const snap = (over: Partial<FieldSnapshot>): FieldSnapshot => ({
  label: "Why do you want to work here?",
  intent: "unknown",
  kind: "textarea",
  value: "Because the product is good.",
  ...over,
});

const outcome = (over: Partial<FieldOutcome>): FieldOutcome => ({
  label: "Why do you want to work here?",
  intent: "unknown",
  status: "needs-you",
  detail: "no rule matched this question",
  ...over,
});

describe("capturableAnswers", () => {
  it("captures a free-text answer the human typed", () => {
    const got = capturableAnswers([snap({})], [outcome({})], []);
    expect(got).toEqual([
      { match: "Why do you want to work here?", answer: "Because the product is good." },
    ]);
  });

  // --- The guards that carry the refusals ----------------------------------
  it("never captures a demographic answer", () => {
    // Storing this would make the tool disclose it automatically next time,
    // which is the refusal CLAUDE.md calls load-bearing.
    const eeo = snap({
      label: "How would you describe your gender identity?",
      intent: "eeo",
      value: "Man",
    });
    expect(capturableAnswers([eeo], [outcome({ label: eeo.label, intent: "eeo" })], [])).toEqual([]);
  });

  it("never captures an attestation", () => {
    const attest = snap({
      label: "I certify that the information above is true and complete",
      intent: "attestation",
      value: "I agree",
    });
    expect(
      capturableAnswers([attest], [outcome({ label: attest.label, intent: "attestation" })], []),
    ).toEqual([]);
  });

  it("classifies from the label, not just the reported intent", () => {
    // A snapshot arriving with intent "unknown" must still be refused if the
    // label is demographic - the guard cannot depend on an upstream field.
    const mislabelled = snap({
      label: "Do you identify as transgender?",
      intent: "unknown",
      value: "No",
    });
    expect(capturableAnswers([mislabelled], [outcome({ label: mislabelled.label })], [])).toEqual([]);
  });

  // --- Not worth learning ---------------------------------------------------
  it("does not capture what autofill typed itself", () => {
    const filled = outcome({ status: "filled", detail: "Ada (personal.yaml)" });
    expect(capturableAnswers([snap({})], [filled], [])).toEqual([]);
  });

  it("does not capture identity fields that already come from config", () => {
    const fields: FieldSnapshot[] = [
      snap({ label: "Email", intent: "email", value: "ada@example.invalid" }),
      snap({ label: "Phone", intent: "phone", value: "555" }),
      snap({ label: "LinkedIn Profile", intent: "linkedin", value: "https://x" }),
      snap({ label: "First Name", intent: "first_name", value: "Ada" }),
    ];
    const outs = fields.map((f) => outcome({ label: f.label, intent: f.intent }));
    expect(capturableAnswers(fields, outs, [])).toEqual([]);
  });

  it("ignores empty and whitespace-only values", () => {
    expect(capturableAnswers([snap({ value: "" }), snap({ value: "   " })], [outcome({})], [])).toEqual([]);
  });

  it("ignores file and checkbox controls", () => {
    const fields = [snap({ kind: "file", value: "resume.pdf" }), snap({ kind: "checkbox", value: "on" })];
    expect(capturableAnswers(fields, [outcome({})], [])).toEqual([]);
  });

  it("does not duplicate or overwrite an answer already saved", () => {
    const existing = [{ match: "Why do you want to work here?", answer: "An older answer." }];
    expect(capturableAnswers([snap({})], [outcome({})], existing)).toEqual([]);
  });

  it("matches an existing answer case-insensitively, the way decide() does", () => {
    const existing = [{ match: "why do you want to work HERE", answer: "older" }];
    expect(capturableAnswers([snap({})], [outcome({})], existing)).toEqual([]);
  });

  it("captures several answers in one pass, in form order", () => {
    const a = snap({ label: "Question one?", value: "Answer one." });
    const b = snap({ label: "Question two?", value: "Answer two.", kind: "text" });
    const got = capturableAnswers([a, b], [outcome({ label: a.label }), outcome({ label: b.label })], []);
    expect(got.map((x) => x.match)).toEqual(["Question one?", "Question two?"]);
  });
});

describe("saveAnswers", () => {
  let dir: string;
  let file: string;

  const BASE = `# A hand-written config with comments that must survive.
identity:
  first_name: Ada
  last_name: Lovelace
  email: ada@example.invalid

work_eligibility:
  authorized_to_work_us: true

# Escape hatch for company-specific questions.
answers: []
`;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "job-radar-learn-"));
    file = resolve(dir, "personal.yaml");
    writeFileSync(file, BASE, "utf8");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends an answer and keeps the file loadable", () => {
    saveAnswers(file, [{ match: "Why do you want to work here?", answer: "Because." }]);
    const personal = loadPersonal(file);
    expect(personal.answers).toEqual([
      { match: "Why do you want to work here?", answer: "Because." },
    ]);
  });

  it("keeps the hand-written comments", () => {
    saveAnswers(file, [{ match: "Q", answer: "A" }]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# A hand-written config with comments that must survive.");
    expect(text).toContain("# Escape hatch for company-specific questions.");
  });

  it("backs the file up before writing", () => {
    saveAnswers(file, [{ match: "Q", answer: "A" }]);
    const backups = readdirSync(dir).filter((f) => f.includes("personal.yaml.") && f !== "personal.yaml");
    expect(backups.length).toBe(1);
    expect(readFileSync(resolve(dir, backups[0]!), "utf8")).toBe(BASE);
  });

  it("preserves answers that were already there", () => {
    writeFileSync(file, BASE.replace("answers: []", 'answers:\n  - match: "how did you hear"\n    answer: "Job board"\n'), "utf8");
    saveAnswers(file, [{ match: "New question?", answer: "New answer." }]);
    const personal = loadPersonal(file);
    expect(personal.answers).toEqual([
      { match: "how did you hear", answer: "Job board" },
      { match: "New question?", answer: "New answer." },
    ]);
  });

  it("writes nothing when given nothing", () => {
    const before = readFileSync(file, "utf8");
    saveAnswers(file, []);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["personal.yaml"]);
  });

  it("round-trips a multi-line answer", () => {
    const answer = "First paragraph.\n\nSecond paragraph with: a colon and \"quotes\".";
    saveAnswers(file, [{ match: "Tell us more", answer }]);
    expect(loadPersonal(file).answers[0]!.answer).toBe(answer);
  });
});
