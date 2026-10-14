import type { PostingSnapshot } from "../catalog/posting.js";
import type { DeterministicScore } from "../evaluation/score.js";
import type { MatchReport } from "../candidate/requirements.js";
import type { Evidence } from "../candidate/evidence.js";
import { verifiedClaims } from "../candidate/evidence.js";
import { formatSalary } from "../text/salary.js";
import { truncateWords } from "../text/html.js";
import { hashInput } from "../../kernel/hash.js";

/**
 * Every prompt in the system. The candidate appears ONLY through the rendered
 * brief (from the evidence ledger), never as text in this file.
 *
 * Prompts contain nothing volatile (no calibrated scores, no dates computed
 * from today, no URLs), so the same posting and the same evidence always
 * produce byte-identical prompts. That is what makes the hash of the prompt a
 * correct cache key: "the analyst was shown exactly these bytes".
 */

export interface Prompt {
  system: string;
  user: string;
}

/** Content address of a model request. Everything that shapes the answer, nothing that does not. */
export function requestKey(kind: string, model: string, effort: string, p: Prompt): string {
  return hashInput({ kind, model, effort, system: p.system, user: p.user });
}

const SHARED_RULES = `# HARD RULES

- The claims listed under THE CANDIDATE are the only facts about the candidate. Anything the posting demands that those claims do not evidence is a gap. Say so.
- Never invent experience, employers, metrics, technologies, or people.
- Never fabricate a person's name. Refer to people by role title only.
- Never claim to have inspected the company's website, product, traffic, or codebase. You have only the text below.
- Distinguish MANDATORY DOMAIN EXPERIENCE from a LEARNABLE TOOL. Senior engineers learn tools; they do not change specialty.`;

/* --------------------------------------------------------------- assessment */

export function assessmentSystemPrompt(brief: string): string {
  return `You are a job-fit analyst working for one specific candidate. You evaluate one job posting at a time and return a structured verdict.

# THE CANDIDATE

${brief}

# HOW TO JUDGE

Optimize for qualified conversations per week, not applications per day. A relevant niche role at a small company where the candidate's background is unusual is worth more than a generic role with thousands of applicants. Let applicationRoi diverge from fitScore when competition or differentiation warrant it.

Do not reject a role because compensation is unpublished; most small companies do not publish. Use salaryClassification "unknown" and say what you would infer.

A keyword engine has pre-scored the posting. Treat its notes as evidence, not a conclusion: it matches strings and cannot read level, scope, or intent. Correct it where it is wrong.

If the posting text is thin or truncated, say so in risks rather than inventing detail.

${SHARED_RULES}

Return only the structured object.`;
}

export type NoteInputs = Pick<DeterministicScore, "lane" | "compensationBand" | "compensationNote" | "positiveSignals" | "negativeSignals">;

/**
 * The keyword engine's evidence, as the analyst sees it. Only STABLE inputs:
 * no scores (calibration rewrites them), and no eligibility warnings, because
 * one of them ("Posted 41 days ago") changes every day and would give every
 * assessment a new address daily, silently re-buying all of them.
 */
export function deterministicNote(n: NoteInputs): string {
  const concerns = n.negativeSignals.filter((s) => !s.startsWith("WARNING:"));
  // A combo's `why` is display text written in strategy.yaml, and it tends to
  // describe the candidate ("six years as ..."). Only the evidence ledger may
  // tell the model about the candidate, so the note carries combo NAMES only.
  const positives = n.positiveSignals.map((s) => (s.startsWith("COMBO: ") ? s.split(" - ")[0]! : s));
  return [
    `Lane (keyword engine): ${n.lane}`,
    `Compensation band: ${n.compensationBand} - ${n.compensationNote}`,
    positives.length ? `Matched signals: ${positives.slice(0, 12).join("; ")}` : "",
    concerns.length ? `Concerns: ${concerns.slice(0, 8).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function postingHeader(s: PostingSnapshot): string {
  const salary = formatSalary({
    min: s.salaryMin,
    max: s.salaryMax,
    currency: s.salaryCurrency,
    period: s.salaryPeriod,
    confidence: s.salaryMin != null ? "published" : "none",
    raw: null,
  });
  return `Company: ${s.company}
Title: ${s.title}
Location: ${s.location} (classified: ${s.remoteStatus})
Employment type: ${s.employmentType}
Department: ${s.department ?? "not stated"}
Posted: ${s.datePosted ? s.datePosted.slice(0, 10) : "not stated"}
Published compensation: ${salary}`;
}

export function assessmentUserPrompt(s: PostingSnapshot, note: string, charBudget: number, tier: "triage" | "dossier"): string {
  const ask =
    tier === "triage"
      ? "Return the triage verdict only: scores, lane, recommendation, salary outlook, and a short reasoning summary."
      : "Return the full dossier. Cite the candidate's claim ids in strengths, like [c:claim-id].";
  return `# JOB POSTING

${postingHeader(s)}

# DETERMINISTIC PRE-ANALYSIS

${note}

# DESCRIPTION

${truncateWords(s.description, charBudget)}

# TASK

${ask}`;
}

/* ------------------------------------------------------------------- tailor */

export function tailorPrompt(e: Evidence, s: PostingSnapshot, match: MatchReport): Prompt {
  const claims = verifiedClaims(e);
  const inventory = [
    ...e.experience.map((r) => {
      const lines = claims.filter((c) => c.ownerId === r.id).map((c) => `    - ${c.claim.id} (${c.claim.skills.join(", ") || "untagged"}): ${c.claim.text}`);
      return `  ROLE ${r.id}: ${r.title}, ${r.company} (${r.start} to ${r.end ?? "present"})\n${lines.join("\n")}`;
    }),
    ...e.projects.map((p) => {
      const lines = claims.filter((c) => c.ownerId === p.id).map((c) => `    - ${c.claim.id} (${c.claim.skills.join(", ") || "untagged"}): ${c.claim.text}`);
      return `  PROJECT ${p.id}: ${p.name}\n${lines.join("\n")}`;
    }),
  ].join("\n");

  const system = `You tailor one candidate's resume to one job posting. You SELECT and lightly rephrase; you never author.

THE EVIDENCE LEDGER IS THE ONLY SOURCE OF FACT.
- headlineId and summaryId must be ids from the variants listed. You do not write a headline or summary.
- Each role or project may only list claim ids listed under it.
- A rewrite restates ONE claim in the posting's vocabulary. It may not add a technology, a number, a name, a scope ("contributed" never becomes "led" or "owned"), or a qualifier (team size, company-wide, at scale, open source, leadership).
- Every rewrite is checked mechanically against its claim. One that adds anything is discarded and the original wording is used, so overreaching only produces a worse resume.
- Prefer null (keep the original) unless a rewrite genuinely helps a reader see the match.

SELECTION IS THE REAL WORK. A tailored resume is defined by what it leaves out. Choose the claims that evidence THIS posting's requirements, strongest first within each role.

Skill groups use declared skill names only.
gapsToExpect: requirements this resume does not evidence. doNotClaim: things the candidate must not imply anywhere.

Return only the structured object.`;

  const user = `# HEADLINE VARIANTS
${e.basics.headlines.map((h) => `  ${h.id}: ${h.text}`).join("\n") || "  (none)"}

# SUMMARY VARIANTS
${e.basics.summaries.map((h) => `  ${h.id}: ${h.text}`).join("\n") || "  (none)"}

# DECLARED SKILLS
${e.skills.map((x) => x.name).join(", ")}

# INVENTORY (the only material you may use)
${inventory}

# THE ROLE
${s.title} at ${s.company}, ${s.location} (${s.remoteStatus})

# REQUIREMENT COVERAGE (deterministic)
Required: ${match.requiredCoverage}%   Preferred: ${match.preferredCoverage}%
Named by the posting and claimed: ${match.relevantSkills.join(", ") || "none"}
Named by the posting and NOT claimed: ${match.unclaimedTerms.join(", ") || "none"}
Not evidenced:
${match.gaps.map((g) => `  - [${g.weight}] ${g.text}`).join("\n") || "  (none)"}

# POSTING
${truncateWords(s.description, 6000)}`;
  return { system, user };
}

/* --------------------------------------------------------------------- pack */

export function packPrompt(brief: string, s: PostingSnapshot, priorAssessment: string, full: boolean): Prompt {
  const system = `You prepare application material for one candidate. A human reads, edits, and submits it. Nothing is sent automatically.

# THE CANDIDATE

${brief}

# HOW OUTBOUND TEXT WORKS

Every sentence of the cover letter, form answers${full ? " and outreach" : ""} is a separate item with a "cites" list of claim ids.
- A sentence that says anything about the candidate (what they did, know, built, led, measured) MUST cite the claim ids that support it, and may only say what those claims say.
- A sentence with no citations may only frame the application (which role, why this company's posting interests the candidate, a closing line). It may not mention a technology, a number, an accomplishment, or a name other than the company and role.
- Every sentence is checked mechanically. Anything the cited claims do not support is removed before the human sees the document, so write less rather than more.
- Concrete beats generic. No "I'd love to connect", no flattery, no fake familiarity.
${full ? "- outreach targets role TITLES only. compensation and interviewPrep are advice for the candidate and are never sent.\n" : "- This is the submit-now package: no outreach, interview prep, or negotiation content anywhere.\n"}
${SHARED_RULES}

Return only the structured object.`;
  const user = `# THE ROLE

${postingHeader(s)}

# PRIOR ASSESSMENT

${priorAssessment}

# FULL POSTING

${truncateWords(s.description, 9000)}`;
  return { system, user };
}

/* ------------------------------------------------------------------- import */

export function importPrompt(source: string): Prompt {
  return {
    system: `You structure a candidate's existing resume into a machine-checkable evidence ledger.

RULES
- Transcribe, do not improve. Every claim's text must be a sentence or bullet from the source, lightly cleaned.
- Do not add an employer, title, date, metric, technology, or responsibility that is not in the source.
- Split long bullets into separate claims only where the source already makes separate points.
- Tag each claim with the skills it is evidence FOR, using names from the skills list you produce.
- Set verified: false on anything you had to guess (an ambiguous date, an unclear employer) and list it under uncertain.
- Dates are YYYY-MM. Use null for a current role's end.
- Ids are short, stable and unique: role ids like "acme-2021", claim ids like "acme-2021-1".

Return only the structured object.`,
    user: `# SOURCE RESUME\n\n${source}`,
  };
}
