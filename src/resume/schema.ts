import { z } from "zod";

/**
 * The master resume: one structured record of what the candidate has actually
 * done. Every tailored resume is a SELECTION from this file. Nothing may be
 * written into a generated resume that does not trace back to an id here.
 *
 * That is why bullets carry stable ids. "Never invent experience" is only
 * enforceable if generated output has to name its source, and a checker can
 * confirm the source exists and says what the output claims it says.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateField = z
  .string()
  .refine((s) => MONTH.test(s), { message: "must be YYYY-MM" });

export const BulletSchema = z.object({
  /** Stable id. Referenced by tailored resumes; changing it breaks provenance. */
  id: z.string().min(2),
  text: z.string().min(10),
  /** Skills this bullet is evidence FOR. Must name entries in `skills`. */
  skills: z.array(z.string()).default([]),
  /** Which of the four search lanes this bullet supports. */
  lanes: z.array(z.string()).default([]),
  /**
   * Set false for anything you cannot substantiate if asked in an interview.
   * Unverified bullets are never selected into a tailored resume.
   */
  verified: z.boolean().default(true),
});

const RoleSchema = z.object({
  id: z.string().min(2),
  company: z.string().min(1),
  title: z.string().min(1),
  start: dateField,
  /** null means current. */
  end: dateField.nullable().default(null),
  location: z.string().default(""),
  /** One line on what the company/product is, for context the reader lacks. */
  context: z.string().default(""),
  employment_type: z.enum(["full_time", "contract", "founder", "part_time", "internship"]).default("full_time"),
  bullets: z.array(BulletSchema).default([]),
});

const ProjectSchema = z.object({
  id: z.string().min(2),
  name: z.string().min(1),
  url: z.string().default(""),
  context: z.string().default(""),
  start: dateField.nullable().default(null),
  end: dateField.nullable().default(null),
  bullets: z.array(BulletSchema).default([]),
});

export const SkillSchema = z.object({
  name: z.string().min(1),
  /** Spellings a posting might use. "NextJS", "Next JS" for "Next.js". */
  aliases: z.array(z.string()).default([]),
  level: z.enum(["expert", "strong", "working", "familiar"]).default("strong"),
  years: z.number().nullable().default(null),
  category: z.string().default("other"),
});

export const ResumeSchema = z.object({
  basics: z.object({
    name: z.string().min(1),
    headline: z.string().default(""),
    location: z.string().default(""),
    /** Base summary. Tailoring rewrites this one field most heavily. */
    summary: z.string().default(""),
  }),
  skills: z.array(SkillSchema).default([]),
  experience: z.array(RoleSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  education: z
    .array(
      z.object({
        id: z.string().min(2),
        school: z.string().min(1),
        credential: z.string().default(""),
        year: z.string().default(""),
      }),
    )
    .default([]),
  certifications: z.array(z.object({ name: z.string(), year: z.string().default("") })).default([]),
});

export type Resume = z.infer<typeof ResumeSchema>;
export type Bullet = z.infer<typeof BulletSchema>;
export type Skill = z.infer<typeof SkillSchema>;

export interface LintIssue {
  level: "error" | "warning";
  where: string;
  message: string;
}

/**
 * Checks a per-field schema cannot express. These are the mistakes that make a
 * generated resume wrong rather than merely incomplete.
 */
export function lintResume(r: Resume): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (level: LintIssue["level"], where: string, message: string) =>
    issues.push({ level, where, message });

  // Duplicate ids silently break provenance: a tailored resume citing `b-1`
  // could resolve to either bullet, so the checker would validate the wrong one.
  const ids = new Map<string, string>();
  const claim = (id: string, where: string) => {
    const prior = ids.get(id);
    if (prior) push("error", where, `duplicate id "${id}" (also used by ${prior})`);
    else ids.set(id, where);
  };

  const skillNames = new Set(r.skills.map((s) => s.name.toLowerCase()));
  for (const s of r.skills) {
    if (s.aliases.some((a) => a.toLowerCase() === s.name.toLowerCase())) {
      push("warning", `skills.${s.name}`, "alias repeats the skill name");
    }
  }

  const allBullets: Array<{ b: Bullet; where: string }> = [];
  for (const role of r.experience) {
    claim(role.id, `experience.${role.id}`);
    if (role.end && role.end < role.start) {
      push("error", `experience.${role.id}`, `end (${role.end}) is before start (${role.start})`);
    }
    if (role.bullets.length === 0) {
      push("warning", `experience.${role.id}`, "no bullets, so this role can never be selected");
    }
    for (const b of role.bullets) {
      claim(b.id, `experience.${role.id}.${b.id}`);
      allBullets.push({ b, where: `experience.${role.id}.${b.id}` });
    }
  }
  for (const p of r.projects) {
    claim(p.id, `projects.${p.id}`);
    for (const b of p.bullets) {
      claim(b.id, `projects.${p.id}.${b.id}`);
      allBullets.push({ b, where: `projects.${p.id}.${b.id}` });
    }
  }
  for (const e of r.education) claim(e.id, `education.${e.id}`);

  for (const { b, where } of allBullets) {
    if (b.skills.length === 0) {
      push("warning", where, "no skills tagged, so this bullet can never match a requirement");
    }
    for (const s of b.skills) {
      if (!skillNames.has(s.toLowerCase())) {
        push("error", where, `tagged skill "${s}" is not declared in skills`);
      }
    }
    if (/\bTODO\b|\bFIXME\b|<[a-z ]+>/i.test(b.text)) {
      push("error", where, "bullet still contains placeholder text");
    }
  }

  if (r.experience.length === 0) {
    push("error", "experience", "no employment history: tailoring has nothing to select from");
  }
  if (!r.basics.summary) push("warning", "basics.summary", "empty; tailoring has no base to rewrite");

  // Employment gaps are not errors, but they get asked about in screens.
  const sorted = [...r.experience].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.end;
    const thisStart = sorted[i]!.start;
    if (prevEnd && monthsBetween(prevEnd, thisStart) > 4) {
      push(
        "warning",
        `experience.${sorted[i]!.id}`,
        `${monthsBetween(prevEnd, thisStart)}-month gap after ${sorted[i - 1]!.company}; expect to be asked`,
      );
    }
  }

  return issues;
}

export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** Every bullet in the resume, with the role/project it came from. */
export function allBullets(r: Resume): Array<{ bullet: Bullet; sourceId: string; sourceLabel: string }> {
  const out: Array<{ bullet: Bullet; sourceId: string; sourceLabel: string }> = [];
  for (const role of r.experience) {
    for (const b of role.bullets) {
      out.push({ bullet: b, sourceId: role.id, sourceLabel: `${role.title}, ${role.company}` });
    }
  }
  for (const p of r.projects) {
    for (const b of p.bullets) out.push({ bullet: b, sourceId: p.id, sourceLabel: p.name });
  }
  return out;
}
