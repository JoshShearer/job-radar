import { chromium } from "playwright";
import type { EnrichedJob } from "../model/job.js";
import type { Resume } from "./schema.js";
import { allBullets } from "./schema.js";
import type { TailorPlan } from "./tailor.js";
import type { MatchReport } from "./requirements.js";
import { buildVocabulary, checkRewrite, checkSelection, type Violation } from "./provenance.js";

/**
 * Rendering. The tailored resume is composed HERE, from master data plus the
 * plan's selections - the model's output is a set of ids and replacement
 * strings, never a document. A model cannot emit a line into the final resume
 * without an id that survived provenance checking.
 *
 * `composeResume` is the one entry point that turns a plan into a document,
 * and it enforces provenance on every call - there is no way to compose
 * without it running first. Composition then resolves each role's bullets
 * from that role's OWN bullet list, never the flat cross-resume index, as a
 * structural second gate: even if enforcement were somehow bypassed, a
 * bullet id that belongs to a different role simply would not resolve.
 */

const HEADLINE_ID = "basics.headline";
const SUMMARY_ID = "basics.summary";

/**
 * Validate a plan against the master resume and repair it in place.
 *
 * Repair rather than reject: a plan that cites one bad bullet id is still a
 * good plan minus that bullet. Dropping the bad citation and reverting the bad
 * rewrite produces a correct resume, where failing the whole run produces
 * nothing and costs another API call.
 */
export function enforceProvenance(resume: Resume, plan: TailorPlan): { violations: Violation[]; reverted: string[] } {
  const violations: Violation[] = [];
  const reverted: string[] = [];
  const vocabulary = buildVocabulary(resume);

  const index = new Map(allBullets(resume).map((b) => [b.bullet.id, b.bullet]));
  const roleIds = new Set([...resume.experience.map((r) => r.id), ...resume.projects.map((p) => p.id)]);
  const skillNames = new Set(resume.skills.map((s) => s.name.toLowerCase()));

  plan.roles = plan.roles.filter((r) => {
    if (roleIds.has(r.roleId)) return true;
    violations.push({ bulletId: r.roleId, kind: "unknown_bullet", detail: "no role with this id in the master resume" });
    return false;
  });

  for (const role of plan.roles) {
    const bad = checkSelection(resume, role.bulletIds, role.roleId);
    violations.push(...bad);
    const drop = new Set(bad.map((v) => v.bulletId));
    role.bulletIds = role.bulletIds.filter((id) => !drop.has(id));

    role.rewrites = role.rewrites.filter((rw) => {
      const source = index.get(rw.bulletId);
      if (!source) {
        violations.push({ bulletId: rw.bulletId, kind: "unknown_bullet", detail: "rewrite cites an unknown bullet" });
        return false;
      }
      const bad2 = checkRewrite(rw.bulletId, source.text, rw.text, vocabulary);
      if (bad2.length) {
        violations.push(...bad2);
        reverted.push(rw.bulletId);
        return false; // fall back to the master wording
      }
      return true;
    });
  }

  plan.projectIds = plan.projectIds.filter((id) => roleIds.has(id));

  // Skill groups may only name declared skills.
  plan.skillGroups = plan.skillGroups
    .map((g) => ({ ...g, skills: g.skills.filter((s) => skillNames.has(s.toLowerCase())) }))
    .filter((g) => g.skills.length > 0);

  // The headline and summary are free text too, and the model wrote them -
  // they get the same rewrite check as a bullet, checked against the master's
  // own headline/summary wording, with the same revert-to-truth fallback.
  const headlineBad = checkRewrite(HEADLINE_ID, resume.basics.headline, plan.headline, vocabulary);
  if (headlineBad.length) {
    violations.push(...headlineBad);
    reverted.push(HEADLINE_ID);
    plan.headline = resume.basics.headline;
  }

  const summaryBad = checkRewrite(SUMMARY_ID, resume.basics.summary, plan.summary, vocabulary);
  if (summaryBad.length) {
    violations.push(...summaryBad);
    reverted.push(SUMMARY_ID);
    plan.summary = resume.basics.summary;
  }

  return { violations, reverted };
}

function monthLabel(ym: string | null): string {
  if (!ym) return "Present";
  const [y, m] = ym.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(m) - 1;
  return `${names[idx] ?? m} ${y}`;
}

export interface ComposedResume {
  headline: string;
  summary: string;
  skillGroups: Array<{ label: string; skills: string[] }>;
  roles: Array<{
    company: string;
    title: string;
    dates: string;
    location: string;
    context: string;
    bullets: string[];
  }>;
  projects: Array<{ name: string; url: string; context: string; bullets: string[] }>;
  education: Array<{ school: string; credential: string; year: string }>;
}

export interface ComposeResult {
  composed: ComposedResume;
  violations: Violation[];
  /** Rewrites (including headline/summary) reverted to the master wording. */
  reverted: string[];
}

/**
 * Resolve a plan into concrete text, preferring an approved rewrite.
 *
 * Enforcement runs first, unconditionally - there is no `composeResume` call
 * that skips it. Each role's bullets are then resolved from THAT role's own
 * bullet list rather than a single global bullet-id index: a bullet id only
 * ever means the bullet that role actually owns, so a citation that names the
 * right id under the wrong role structurally fails to resolve, even if it
 * somehow survived enforcement.
 */
export function composeResume(resume: Resume, plan: TailorPlan): ComposeResult {
  const { violations, reverted } = enforceProvenance(resume, plan);

  const roleById = new Map(resume.experience.map((r) => [r.id, r]));
  const projectById = new Map(resume.projects.map((p) => [p.id, p]));

  const roles: ComposedResume["roles"] = [];
  for (const planned of plan.roles) {
    const role = roleById.get(planned.roleId);
    if (!role) continue;
    // Per-role, not global: this map can only ever produce a bullet that
    // `role` itself owns.
    const roleBullets = new Map(role.bullets.map((b) => [b.id, b.text]));
    const rewrites = new Map(planned.rewrites.map((r) => [r.bulletId, r.text]));
    const bullets = planned.bulletIds
      .map((id) => rewrites.get(id) ?? roleBullets.get(id))
      .filter((t): t is string => Boolean(t));
    if (!bullets.length) continue;
    roles.push({
      company: role.company,
      title: role.title,
      dates: `${monthLabel(role.start)} - ${monthLabel(role.end)}`,
      location: role.location,
      context: role.context,
      bullets,
    });
  }
  // Reverse chronological regardless of the order the plan returned them in.
  roles.sort((a, b) => (a.dates < b.dates ? 1 : -1));

  const projects: ComposedResume["projects"] = [];
  for (const id of plan.projectIds) {
    const p = projectById.get(id);
    if (!p) continue;
    projects.push({
      name: p.name,
      url: p.url,
      context: p.context,
      bullets: p.bullets.filter((b) => b.verified).map((b) => b.text),
    });
  }

  const composed: ComposedResume = {
    headline: plan.headline,
    summary: plan.summary,
    skillGroups: plan.skillGroups,
    roles,
    projects,
    education: resume.education.map((e) => ({ school: e.school, credential: e.credential, year: e.year })),
  };

  return { composed, violations, reverted };
}

export function renderResumeMarkdown(resume: Resume, c: ComposedResume, contact: string[]): string {
  const L: string[] = [];
  L.push(`# ${resume.basics.name}`);
  L.push("");
  L.push(c.headline);
  if (contact.length) L.push("", contact.join(" | "));
  L.push("");
  if (c.summary) {
    L.push("## Summary");
    L.push("");
    L.push(c.summary);
    L.push("");
  }
  if (c.skillGroups.length) {
    L.push("## Skills");
    L.push("");
    for (const g of c.skillGroups) L.push(`**${g.label}:** ${g.skills.join(", ")}`);
    L.push("");
  }
  if (c.roles.length) {
    L.push("## Experience");
    L.push("");
    for (const r of c.roles) {
      L.push(`### ${r.title} - ${r.company}`);
      L.push(`${r.dates}${r.location ? ` | ${r.location}` : ""}`);
      if (r.context) L.push("", `_${r.context}_`);
      L.push("");
      for (const b of r.bullets) L.push(`- ${b}`);
      L.push("");
    }
  }
  if (c.projects.length) {
    L.push("## Projects");
    L.push("");
    for (const p of c.projects) {
      L.push(`### ${p.name}${p.url ? ` - ${p.url}` : ""}`);
      if (p.context) L.push(p.context);
      for (const b of p.bullets) L.push(`- ${b}`);
      L.push("");
    }
  }
  if (c.education.length) {
    L.push("## Education");
    L.push("");
    for (const e of c.education) L.push(`- ${e.credential}${e.credential ? ", " : ""}${e.school} ${e.year}`.trim());
    L.push("");
  }
  return L.join("\n");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Print-oriented HTML. Deliberately plain: one column, real text, no images,
 * no icon fonts, no CSS columns. Resume parsers mangle multi-column layouts
 * and skip anything that is not selectable text, and the parser is the first
 * reader.
 */
export function renderResumeHtml(resume: Resume, c: ComposedResume, contact: string[]): string {
  const parts: string[] = [];
  parts.push(`<h1>${esc(resume.basics.name)}</h1>`);
  parts.push(`<p class="headline">${esc(c.headline)}</p>`);
  if (contact.length) parts.push(`<p class="contact">${contact.map(esc).join(" &middot; ")}</p>`);
  if (c.summary) parts.push(`<h2>Summary</h2><p>${esc(c.summary)}</p>`);

  if (c.skillGroups.length) {
    parts.push("<h2>Skills</h2>");
    for (const g of c.skillGroups) {
      parts.push(`<p class="skills"><strong>${esc(g.label)}:</strong> ${esc(g.skills.join(", "))}</p>`);
    }
  }

  if (c.roles.length) {
    parts.push("<h2>Experience</h2>");
    for (const r of c.roles) {
      parts.push('<section class="role">');
      parts.push(`<h3>${esc(r.title)} <span class="company">${esc(r.company)}</span></h3>`);
      parts.push(`<p class="meta">${esc(r.dates)}${r.location ? ` &middot; ${esc(r.location)}` : ""}</p>`);
      if (r.context) parts.push(`<p class="context">${esc(r.context)}</p>`);
      parts.push(`<ul>${r.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
      parts.push("</section>");
    }
  }

  if (c.projects.length) {
    parts.push("<h2>Projects</h2>");
    for (const p of c.projects) {
      parts.push('<section class="role">');
      parts.push(`<h3>${esc(p.name)}${p.url ? ` <span class="company">${esc(p.url)}</span>` : ""}</h3>`);
      if (p.context) parts.push(`<p class="context">${esc(p.context)}</p>`);
      if (p.bullets.length) parts.push(`<ul>${p.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
      parts.push("</section>");
    }
  }

  if (c.education.length) {
    parts.push("<h2>Education</h2>");
    parts.push(
      `<ul>${c.education
        .map((e) => `<li>${esc([e.credential, e.school, e.year].filter(Boolean).join(", "))}</li>`)
        .join("")}</ul>`,
    );
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(resume.basics.name)} - Resume</title>
<style>
  @page { size: letter; margin: 0.5in 0.55in; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt;
         line-height: 1.32; color: #111; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 2px; letter-spacing: -0.01em; }
  .headline { margin: 0 0 4px; font-size: 11pt; color: #333; }
  .contact { margin: 0 0 14px; font-size: 9.5pt; color: #444; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.08em;
       border-bottom: 1px solid #bbb; padding-bottom: 3px; margin: 12px 0 7px; }
  h3 { font-size: 11pt; margin: 0 0 1px; }
  .company { font-weight: 400; color: #333; }
  .meta { margin: 0 0 3px; font-size: 9.5pt; color: #555; }
  .context { margin: 0 0 4px; font-size: 9.5pt; color: #444; font-style: italic; }
  .skills { margin: 0 0 3px; }
  ul { margin: 0 0 10px; padding-left: 17px; }
  li { margin-bottom: 2px; break-inside: avoid; page-break-inside: avoid; }
  p { margin: 0 0 8px; }
  section.role { margin-bottom: 9px; }
  /* Keep a heading with its first lines, but let a long role flow across a
     page break. Forcing whole sections to stay together leaves half-empty
     pages and pushes a two-page resume to three. */
  h2, h3, .meta, .context { break-after: avoid; page-break-after: avoid; }
</style></head>
<body>
${parts.join("\n")}
</body></html>`;
}

/** Render HTML to PDF with the Chromium that already ships for autofill. */
export async function writeResumePdf(html: string, outPath: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outPath, format: "Letter", printBackground: true });
  } finally {
    await browser.close();
  }
}

/** The `resume match` report: deterministic, no model involved. */
export function renderMatchReport(job: EnrichedJob, m: MatchReport): string {
  const L: string[] = [];
  L.push(`# Requirement match - ${job.title}, ${job.company}`);
  L.push("");
  L.push("```");
  L.push(`Required requirements evidenced : ${m.requiredCoverage}%`);
  L.push(`Preferred requirements evidenced: ${m.preferredCoverage}%`);
  L.push(`Requirements parsed             : ${m.matches.length}`);
  L.push(`Career span on record           : ${m.careerYears} years`);
  L.push("```");
  L.push("");

  const covered = m.matches.filter((x) => x.status === "covered");
  const partial = m.matches.filter((x) => x.status === "partial");
  const gaps = m.matches.filter((x) => x.status === "gap");

  if (partial.length) {
    L.push("## Right technology, wrong scope");
    L.push("");
    L.push(
      "You have the tools these ask for, but not the scope they ask for. This is the most " +
        "dangerous category: it is exactly where a tailored resume starts over-claiming.",
    );
    L.push("");
    for (const p of partial) {
      L.push(`- **[${p.requirement.weight}]** ${p.requirement.text}`);
      for (const u of p.unmet) L.push(`  - ${u}`);
    }
    L.push("");
  }

  if (gaps.length) {
    L.push("## Not evidenced at all");
    L.push("");
    L.push("What an interviewer probes, and what must never be implied in the application.");
    L.push("");
    for (const g of gaps) {
      L.push(`- **[${g.requirement.weight}]** ${g.requirement.text}`);
      if (g.skills.length) {
        L.push(
          `  - names skills you claim (${g.skills.map((s) => s.skill).join(", ")}) but no verified bullet is tagged with them`,
        );
      }
    }
    L.push("");
  }

  if (covered.length) {
    L.push("## Evidenced");
    L.push("");
    for (const c of covered) {
      L.push(`- **[${c.requirement.weight}]** ${c.requirement.text}`);
      for (const e of c.evidence) L.push(`  - \`${e.bulletId}\` (${e.sourceLabel}): ${e.text.slice(0, 120)}`);
    }
    L.push("");
  }

  if (m.unclaimedTerms.length) {
    L.push("## Named by the posting, never claimed by you");
    L.push("");
    L.push(`${m.unclaimedTerms.join(", ")}`);
    L.push("");
    L.push("_These belong on the do-not-claim list, not on the resume._");
    L.push("");
  }

  return L.join("\n");
}
