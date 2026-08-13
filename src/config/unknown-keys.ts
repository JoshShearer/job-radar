/**
 * Unknown top-level keys are an error, not something to strip quietly.
 *
 * Zod drops keys it does not recognize. For a config file that is the wrong
 * default: a value pasted into the wrong file, or under the wrong nesting,
 * validates cleanly, reports "ready", and does nothing. Work-authorization
 * answers landed in the resume file exactly this way and were silently
 * discarded while every check passed.
 *
 * Because the two config files have disjoint, known shapes, a misplaced key
 * can usually be routed to the file it belongs in rather than just rejected.
 */

const OWNER: Readonly<Record<string, string>> = {
  identity: "config/personal.yaml",
  links: "config/personal.yaml",
  work_eligibility: "config/personal.yaml",
  preferences: "config/personal.yaml",
  answers: "config/personal.yaml",

  // Frequently pasted at the top level instead of nested.
  authorized_to_work_us: "config/personal.yaml, nested under `work_eligibility:`",
  requires_sponsorship: "config/personal.yaml, nested under `work_eligibility:`",
  authorization_option_hint: "config/personal.yaml, nested under `work_eligibility:`",
  desired_salary: "config/personal.yaml, nested under `preferences:`",
  referral_source: "config/personal.yaml, nested under `preferences:`",
  notice_period: "config/personal.yaml, nested under `preferences:`",

  basics: "config/resume.yaml",
  experience: "config/resume.yaml",
  projects: "config/resume.yaml",
  education: "config/resume.yaml",
  certifications: "config/resume.yaml",
};

export function checkTopLevelKeys(raw: unknown, allowed: readonly string[], file: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const known = new Set(allowed);
  const unknown = Object.keys(raw as Record<string, unknown>).filter((k) => !known.has(k));
  if (unknown.length === 0) return;

  const lines = unknown.map((k) => {
    const owner = OWNER[k];
    return owner && owner !== file
      ? `  - "${k}" is not part of ${file}. It belongs in ${owner}.`
      : `  - "${k}" is not a recognized key in ${file}.`;
  });

  throw new Error(
    `${file} has ${unknown.length} key(s) that would be ignored:\n${lines.join("\n")}\n\n` +
      `Nothing was loaded from them. Move or remove them, then re-run.`,
  );
}
