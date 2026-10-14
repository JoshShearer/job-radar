import type { ComposedResume, CheckedPack, Repair } from "./compose.js";
import { coverLetterText } from "./compose.js";
import type { MatchReport } from "../candidate/requirements.js";
import { escapeHtml as esc } from "./documents.js";

function monthLabel(ym: string | null): string {
  if (!ym) return "Present";
  const [y, m] = ym.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

export function resumeMarkdown(c: ComposedResume, contact: string[]): string {
  const L: string[] = [`# ${c.name}`, ""];
  if (c.headline) L.push(c.headline);
  if (contact.length) L.push("", contact.join(" | "));
  L.push("");
  if (c.summary) L.push("## Summary", "", c.summary, "");
  if (c.skillGroups.length) {
    L.push("## Skills", "");
    for (const g of c.skillGroups) L.push(`**${g.label}:** ${g.skills.join(", ")}`);
    L.push("");
  }
  if (c.roles.length) {
    L.push("## Experience", "");
    for (const r of c.roles) {
      L.push(`### ${r.title} - ${r.company}`, `${monthLabel(r.start)} - ${monthLabel(r.end)}${r.location ? ` | ${r.location}` : ""}`);
      if (r.context) L.push("", `_${r.context}_`);
      L.push("", ...r.bullets.map((b) => `- ${b}`), "");
    }
  }
  if (c.projects.length) {
    L.push("## Projects", "");
    for (const p of c.projects) {
      L.push(`### ${p.name}${p.url ? ` - ${p.url}` : ""}`);
      if (p.context) L.push(p.context);
      L.push(...p.bullets.map((b) => `- ${b}`), "");
    }
  }
  if (c.education.length) {
    L.push("## Education", "", ...c.education.map((e) => `- ${[e.credential, e.school, e.year].filter(Boolean).join(", ")}`), "");
  }
  return L.join("\n");
}

/** One column, real text, no images: the parser is the first reader. */
export function resumeHtml(c: ComposedResume, contact: string[]): string {
  const P: string[] = [`<h1>${esc(c.name)}</h1>`];
  if (c.headline) P.push(`<p class="headline">${esc(c.headline)}</p>`);
  if (contact.length) P.push(`<p class="contact">${contact.map(esc).join(" &middot; ")}</p>`);
  if (c.summary) P.push(`<h2>Summary</h2><p>${esc(c.summary)}</p>`);
  if (c.skillGroups.length) {
    P.push("<h2>Skills</h2>");
    for (const g of c.skillGroups) P.push(`<p class="skills"><strong>${esc(g.label)}:</strong> ${esc(g.skills.join(", "))}</p>`);
  }
  if (c.roles.length) {
    P.push("<h2>Experience</h2>");
    for (const r of c.roles) {
      P.push('<section class="role">');
      P.push(`<h3>${esc(r.title)} <span class="company">${esc(r.company)}</span></h3>`);
      P.push(`<p class="meta">${esc(`${monthLabel(r.start)} - ${monthLabel(r.end)}`)}${r.location ? ` &middot; ${esc(r.location)}` : ""}</p>`);
      if (r.context) P.push(`<p class="context">${esc(r.context)}</p>`);
      P.push(`<ul>${r.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></section>`);
    }
  }
  if (c.projects.length) {
    P.push("<h2>Projects</h2>");
    for (const p of c.projects) {
      P.push(`<section class="role"><h3>${esc(p.name)}${p.url ? ` <span class="company">${esc(p.url)}</span>` : ""}</h3>`);
      if (p.context) P.push(`<p class="context">${esc(p.context)}</p>`);
      if (p.bullets.length) P.push(`<ul>${p.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
      P.push("</section>");
    }
  }
  if (c.education.length) {
    P.push(`<h2>Education</h2><ul>${c.education.map((e) => `<li>${esc([e.credential, e.school, e.year].filter(Boolean).join(", "))}</li>`).join("")}</ul>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(c.name)} - Resume</title>
<style>
  @page { size: letter; margin: 0.5in 0.55in; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.32; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2px; }
  .headline { margin: 0 0 4px; font-size: 11pt; color: #333; }
  .contact { margin: 0 0 14px; font-size: 9.5pt; color: #444; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #bbb; padding-bottom: 3px; margin: 12px 0 7px; }
  h3 { font-size: 11pt; margin: 0 0 1px; }
  .company { font-weight: 400; color: #333; }
  .meta { margin: 0 0 3px; font-size: 9.5pt; color: #555; }
  .context { margin: 0 0 4px; font-size: 9.5pt; color: #444; font-style: italic; }
  ul { margin: 0 0 10px; padding-left: 17px; }
  li { margin-bottom: 2px; break-inside: avoid; }
  p { margin: 0 0 8px; }
  h2, h3, .meta, .context { break-after: avoid; }
</style></head><body>
${P.join("\n")}
</body></html>`;
}

export function coverLetterMarkdown(name: string, company: string, title: string, pack: CheckedPack, contact: string[]): string {
  const L = [`# ${name}`];
  if (contact.length) L.push("", contact.join(" | "));
  L.push("", `**${title} - ${company}**`, "", "---", "", coverLetterText(pack));
  return L.join("\n");
}

export function coverLetterHtml(name: string, company: string, title: string, pack: CheckedPack, contact: string[]): string {
  const paras = coverLetterText(pack).split("\n\n").filter(Boolean);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(name)} - ${esc(company)}</title>
<style>
  @page { margin: 0.75in; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.5; color: #111; max-width: 7in; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 4px; font-family: Helvetica, Arial, sans-serif; }
  .contact { margin: 0 0 14px; font-size: 9.5pt; color: #444; font-family: Helvetica, Arial, sans-serif; }
  .role { font-weight: bold; margin: 0 0 18px; font-family: Helvetica, Arial, sans-serif; }
  p { margin: 0 0 11px; }
</style></head><body>
<h1>${esc(name)}</h1>
${contact.length ? `<p class="contact">${contact.map(esc).join(" &middot; ")}</p>` : ""}
<p class="role">${esc(title)} - ${esc(company)}</p>
${paras.map((p) => `<p>${esc(p)}</p>`).join("\n")}
</body></html>`;
}

/** The review document: what will be sent, and everything that was refused. */
export function packReviewMarkdown(company: string, title: string, pack: CheckedPack): string {
  const L = [`# Application pack - ${title}, ${company}`, ""];
  L.push("> Nothing here has been sent. Review it, then `approve` this generation before `fill` will type any of it into a form.", "");
  L.push("## Positioning (internal)", "", pack.positioning, "");
  if (pack.decideFirst.length) L.push("## Decide these first", "", ...pack.decideFirst.map((d) => `- ${d}`), "");
  if (pack.doNotClaim.length) L.push("## Do NOT claim", "", ...pack.doNotClaim.map((d) => `- ${d}`), "");
  L.push("## Cover letter (as it will be sent)", "", coverLetterText(pack) || "_(empty: every sentence was refused)_", "");
  L.push("## Form answers", "");
  for (const a of pack.formAnswers) {
    L.push(`### ${a.question}`, "");
    L.push(a.usable ? a.sentences.map((s) => s.text).join(" ") : "_Not usable: a sentence failed verification. Answer this one yourself._");
    L.push("");
  }
  if (pack.outreach.length) {
    L.push("## Outreach drafts (to role titles; send yourself, or not at all)", "");
    for (const o of pack.outreach) {
      L.push(`### ${o.targetTitle}`, "", o.sentences.filter((s) => s.status !== "rejected").map((s) => s.text).join(" "), "");
    }
  }
  if (pack.compensation) {
    const c = pack.compensation;
    L.push("## Compensation strategy (advice, never sent)", "");
    L.push(`- Target: ${c.target}`, `- Anchor: ${c.anchor}`, `- Walk away: ${c.walkAway}`, `- Ask for their range first: ${c.askRangeFirst ? "yes" : "no"}`, "", c.reasoning, "");
  }
  if (pack.interviewPrep.length) {
    L.push("## Interview prep", "");
    for (const q of pack.interviewPrep) {
      L.push(`- ${q.question} (evidence: ${q.claimIds.join(", ") || "none"}${q.unknownIds.length ? `; ignored unknown ids ${q.unknownIds.join(", ")}` : ""})`);
    }
    L.push("");
  }
  const refused = [...pack.coverLetter.flat(), ...pack.formAnswers.flatMap((a) => a.sentences), ...pack.outreach.flatMap((o) => o.sentences)].filter(
    (s) => s.status === "rejected",
  );
  if (refused.length) {
    L.push("## Refused by the verifier", "", "These were written by the model and removed because the cited evidence does not support them.", "");
    for (const s of refused) L.push(`- "${s.text}"`, `  - ${s.problems.map((p) => `${p.kind}: ${p.detail}`).join("; ")}`);
    L.push("");
  }
  const framing = pack.coverLetter.flat().filter((s) => s.status === "framing");
  if (framing.length) {
    L.push("## Framing sentences (no citation; check the tone)", "", ...framing.map((s) => `- ${s.text}`), "");
  }
  return L.join("\n");
}

export function repairsMarkdown(repairs: readonly Repair[]): string {
  if (!repairs.length) return "No repairs: every selection and rewrite verified.";
  return repairs.map((r) => `- [${r.action}] ${r.where}: ${r.detail}`).join("\n");
}

export function matchReportMarkdown(title: string, company: string, m: MatchReport): string {
  const L = [`# Requirement match - ${title}, ${company}`, "", "```"];
  L.push(`Required requirements evidenced : ${m.requiredCoverage}%`, `Preferred requirements evidenced: ${m.preferredCoverage}%`);
  L.push(`Requirements parsed             : ${m.matches.length}`, `Career span on record           : ${m.careerYears} years`, "```", "");
  const partial = m.matches.filter((x) => x.status === "partial");
  const gaps = m.matches.filter((x) => x.status === "gap");
  const covered = m.matches.filter((x) => x.status === "covered");
  if (partial.length) {
    L.push("## Right technology, wrong scope", "", "You have the tools these ask for, not the scope. This is where tailoring starts over-claiming.", "");
    for (const p of partial) L.push(`- **[${p.requirement.weight}]** ${p.requirement.text}`, ...p.unmet.map((u) => `  - ${u}`));
    L.push("");
  }
  if (gaps.length) {
    L.push("## Not evidenced at all", "");
    for (const g of gaps) L.push(`- **[${g.requirement.weight}]** ${g.requirement.text}`);
    L.push("");
  }
  if (covered.length) {
    L.push("## Evidenced", "");
    for (const c of covered) L.push(`- **[${c.requirement.weight}]** ${c.requirement.text}`, ...c.evidence.map((e) => `  - \`${e.claimId}\` (${e.sourceLabel}): ${e.text.slice(0, 120)}`));
    L.push("");
  }
  if (m.unclaimedTerms.length) L.push("## Named by the posting, never claimed by you", "", m.unclaimedTerms.join(", "), "", "_These belong on the do-not-claim list._", "");
  return L.join("\n");
}
