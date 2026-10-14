import type { Evidence } from "../candidate/evidence.js";
import type { ResumePlan, Sentence, PackPlan } from "./plan.js";
import { describeProblems, verifyHeading, verifySegment, type Problem, type VerifyContext } from "./verify.js";

/**
 * Composition: plan + evidence -> document model. Pure, and the only way a
 * plan becomes a document. Untrusted plans are REPAIRED, never trusted:
 * unknown or unverified citations are dropped, a rewrite that fails
 * verification reverts to the claim's own wording, and a headline or summary
 * id that does not exist falls back to the candidate's first variant.
 */

export interface Repair {
  where: string;
  action: "dropped" | "reverted" | "defaulted";
  detail: string;
}

export interface ComposedResume {
  name: string;
  headline: string;
  summary: string;
  skillGroups: Array<{ label: string; skills: string[] }>;
  roles: Array<{ company: string; title: string; start: string; end: string | null; location: string; context: string; bullets: string[] }>;
  projects: Array<{ name: string; url: string; context: string; bullets: string[] }>;
  education: Array<{ school: string; credential: string; year: string }>;
  /** Every claim id that made it into the document. */
  cited: string[];
}

export function composeResume(e: Evidence, plan: ResumePlan, ctx: VerifyContext): { resume: ComposedResume; repairs: Repair[] } {
  const repairs: Repair[] = [];
  const cited: string[] = [];

  const pick = (variants: Evidence["basics"]["headlines"], id: string, where: string): string => {
    const hit = variants.find((v) => v.id === id);
    if (hit) return hit.text;
    const fallback = variants[0]?.text ?? "";
    repairs.push({ where, action: "defaulted", detail: `"${id}" is not one of the candidate's variants; used ${variants[0]?.id ?? "none"}` });
    return fallback;
  };
  const headline = pick(e.basics.headlines, plan.headlineId, "headline");
  const summary = pick(e.basics.summaries, plan.summaryId, "summary");

  const resolve = (ownerId: string, owned: Map<string, { text: string; verified: boolean }>, planned: ResumePlan["roles"][number]["claims"]) => {
    const bullets: string[] = [];
    for (const p of planned) {
      const claim = owned.get(p.claimId);
      if (!claim) {
        repairs.push({ where: `${ownerId}.${p.claimId}`, action: "dropped", detail: `not a claim of ${ownerId}` });
        continue;
      }
      if (!claim.verified) {
        repairs.push({ where: `${ownerId}.${p.claimId}`, action: "dropped", detail: "claim is verified: false" });
        continue;
      }
      let text = claim.text;
      if (p.rewrite && p.rewrite.trim() && p.rewrite.trim() !== claim.text) {
        const problems = verifySegment(p.rewrite, [p.claimId], ctx, { expectedOwner: ownerId });
        if (problems.length) {
          repairs.push({ where: `${ownerId}.${p.claimId}`, action: "reverted", detail: describeProblems(problems) });
        } else text = p.rewrite.trim();
      }
      bullets.push(text);
      cited.push(p.claimId);
    }
    return bullets;
  };

  const roles: ComposedResume["roles"] = [];
  const roleIds = new Set(e.experience.map((r) => r.id));
  for (const planned of plan.roles) {
    const role = e.experience.find((r) => r.id === planned.roleId);
    if (!role) {
      repairs.push({ where: planned.roleId, action: "dropped", detail: "no such role in the ledger" });
      continue;
    }
    const bullets = resolve(role.id, new Map(role.claims.map((c) => [c.id, c])), planned.claims);
    if (bullets.length) {
      roles.push({ company: role.company, title: role.title, start: role.start, end: role.end, location: role.location, context: role.context, bullets });
    }
  }
  roles.sort((a, b) => (b.end ?? "9999-12").localeCompare(a.end ?? "9999-12") || b.start.localeCompare(a.start));

  const projects: ComposedResume["projects"] = [];
  for (const planned of plan.projects) {
    const proj = e.projects.find((p) => p.id === planned.projectId);
    if (!proj) {
      repairs.push({ where: planned.projectId, action: "dropped", detail: roleIds.has(planned.projectId) ? "is a role, not a project" : "no such project" });
      continue;
    }
    const bullets = resolve(proj.id, new Map(proj.claims.map((c) => [c.id, c])), planned.claims);
    projects.push({ name: proj.name, url: proj.url, context: proj.context, bullets });
  }

  const declared = new Map(e.skills.map((s) => [s.name.toLowerCase(), s.name]));
  const skillGroups: ComposedResume["skillGroups"] = [];
  for (const g of plan.skillGroups) {
    const skills: string[] = [];
    for (const s of g.skills) {
      const name = declared.get(s.toLowerCase());
      if (name) skills.push(name);
      else repairs.push({ where: `skills.${g.label}`, action: "dropped", detail: `"${s}" is not a declared skill` });
    }
    if (!skills.length) continue;
    // A label is model-written text on the page; it may not assert anything.
    const labelProblems = verifyHeading(g.label, skills, ctx);
    const label = labelProblems.length ? "Skills" : g.label;
    if (labelProblems.length) repairs.push({ where: `skills.${g.label}`, action: "reverted", detail: describeProblems(labelProblems) });
    skillGroups.push({ label, skills });
  }

  return {
    resume: {
      name: e.basics.name,
      headline,
      summary,
      skillGroups,
      roles,
      projects,
      education: e.education.map((x) => ({ school: x.school, credential: x.credential, year: x.year })),
      cited,
    },
    repairs,
  };
}

/* --------------------------------------------------------------------- pack */

export type SentenceStatus = "verified" | "framing" | "rejected";

export interface CheckedSentence extends Sentence {
  status: SentenceStatus;
  problems: Problem[];
}

export interface CheckedPack {
  positioning: string;
  coverLetter: CheckedSentence[][];
  formAnswers: Array<{ question: string; sentences: CheckedSentence[]; usable: boolean }>;
  outreach: Array<{ targetTitle: string; sentences: CheckedSentence[] }>;
  doNotClaim: string[];
  decideFirst: string[];
  compensation: PackPlan["compensation"] | null;
  interviewPrep: Array<{ question: string; claimIds: string[]; unknownIds: string[] }>;
  rejectedCount: number;
}

function check(s: Sentence, ctx: VerifyContext): CheckedSentence {
  const problems = verifySegment(s.text, s.cites, ctx);
  const status: SentenceStatus = problems.length ? "rejected" : s.cites.length ? "verified" : "framing";
  return { ...s, status, problems };
}

/**
 * Check every outbound sentence. Rejected sentences never reach a document; a
 * form answer with any rejected sentence is not usable for filling at all,
 * because half an answer reads as a different answer.
 */
export function checkPack(plan: PackPlan, ctx: VerifyContext): CheckedPack {
  const coverLetter = plan.coverLetter.map((para) => para.map((s) => check(s, ctx)));
  const formAnswers = plan.formAnswers.map((a) => {
    const sentences = a.sentences.map((s) => check(s, ctx));
    return { question: a.question, sentences, usable: sentences.length > 0 && sentences.every((s) => s.status !== "rejected") };
  });
  const outreach = (plan.outreach ?? []).map((o) => ({ targetTitle: o.targetTitle, sentences: o.sentences.map((s) => check(s, ctx)) }));
  const interviewPrep = (plan.interviewPrep ?? []).map((q) => ({
    question: q.question,
    claimIds: q.claimIds.filter((id) => ctx.claims.get(id)?.claim.verified),
    unknownIds: q.claimIds.filter((id) => !ctx.claims.get(id)?.claim.verified),
  }));
  const all = [...coverLetter.flat(), ...formAnswers.flatMap((a) => a.sentences), ...outreach.flatMap((o) => o.sentences)];
  return {
    positioning: plan.positioning,
    coverLetter,
    formAnswers,
    outreach,
    doNotClaim: plan.doNotClaim,
    decideFirst: plan.decideFirst,
    compensation: plan.compensation ?? null,
    interviewPrep,
    rejectedCount: all.filter((s) => s.status === "rejected").length,
  };
}

/** The cover letter as it will be sent: rejected sentences removed. */
export function coverLetterText(p: CheckedPack): string {
  return p.coverLetter
    .map((para) => para.filter((s) => s.status !== "rejected").map((s) => s.text.trim()).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

export function answerText(a: CheckedPack["formAnswers"][number]): string | null {
  return a.usable ? a.sentences.map((s) => s.text.trim()).join(" ") : null;
}
