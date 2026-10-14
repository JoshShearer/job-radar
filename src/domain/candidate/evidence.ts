import { z } from "zod";
import { hashInput } from "../../kernel/hash.js";

/**
 * The evidence ledger: the ONLY source of claims about the candidate.
 *
 * Every prompt that describes the candidate is rendered from it, and every
 * outbound sentence (resume, cover letter, form answer) must cite claims in
 * it. Correcting a claim here changes every future output, because nothing
 * about the candidate lives anywhere else.
 *
 * Accepts the old `config/resume.yaml` shape (`bullets`, a single `headline`
 * and `summary` string) so an existing master resume loads unchanged.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = z.string().refine((s) => MONTH.test(s), { message: "must be YYYY-MM" });

export const SCOPES = ["led", "owned", "built", "contributed", "used"] as const;
export type Scope = (typeof SCOPES)[number];

export const ClaimSchema = z.object({
  /** Stable id. Generated material cites it; changing it breaks provenance. */
  id: z.string().min(2),
  text: z.string().min(10),
  /** Skills this claim is evidence FOR. Must name declared skills. */
  skills: z.array(z.string()).default([]),
  lanes: z.array(z.string()).default([]),
  /** false = never used in any generated material, until confirmed. */
  verified: z.boolean().default(true),
  /**
   * The strongest scope this claim supports. Derived from the wording when
   * omitted; set it explicitly when the wording undersells or oversells.
   */
  scope: z.enum(SCOPES).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

const withClaims = (v: unknown) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = { ...(v as Record<string, unknown>) };
    if (o.claims === undefined && o.bullets !== undefined) {
      o.claims = o.bullets;
      delete o.bullets;
    }
    return o;
  }
  return v;
};

const RoleSchema = z.preprocess(
  withClaims,
  z.object({
    id: z.string().min(2),
    company: z.string().min(1),
    title: z.string().min(1),
    start: month,
    end: month.nullable().default(null),
    location: z.string().default(""),
    context: z.string().default(""),
    employment_type: z.enum(["full_time", "contract", "founder", "part_time", "internship"]).default("full_time"),
    claims: z.array(ClaimSchema).default([]),
  }),
);

const ProjectSchema = z.preprocess(
  withClaims,
  z.object({
    id: z.string().min(2),
    name: z.string().min(1),
    url: z.string().default(""),
    context: z.string().default(""),
    start: month.nullable().default(null),
    end: month.nullable().default(null),
    claims: z.array(ClaimSchema).default([]),
  }),
);

export const SkillSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  level: z.enum(["expert", "strong", "working", "familiar"]).default("strong"),
  years: z.number().nullable().default(null),
  category: z.string().default("other"),
});
export type Skill = z.infer<typeof SkillSchema>;

const Variant = z.object({ id: z.string().min(2), text: z.string().min(1) });

const BasicsSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object") return v;
    const o = { ...(v as Record<string, unknown>) };
    if (typeof o.headline === "string") {
      o.headlines = o.headline ? [{ id: "headline-default", text: o.headline }] : [];
      delete o.headline;
    }
    if (typeof o.summary === "string") {
      o.summaries = o.summary ? [{ id: "summary-default", text: o.summary }] : [];
      delete o.summary;
    }
    return o;
  },
  z.object({
    name: z.string().min(1),
    location: z.string().default(""),
    /**
     * Headline and summary VARIANTS, written by the candidate. Tailoring
     * selects one; it never writes a new one.
     */
    headlines: z.array(Variant).default([]),
    summaries: z.array(Variant).default([]),
  }),
);

export const EvidenceSchema = z.object({
  basics: BasicsSchema,
  skills: z.array(SkillSchema).default([]),
  experience: z.array(RoleSchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  education: z
    .array(z.object({ id: z.string().min(2), school: z.string().min(1), credential: z.string().default(""), year: z.string().default("") }))
    .default([]),
  certifications: z.array(z.object({ name: z.string(), year: z.string().default("") })).default([]),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Role = Evidence["experience"][number];
export type Project = Evidence["projects"][number];

export interface IndexedClaim {
  claim: Claim;
  ownerId: string;
  ownerKind: "role" | "project";
  ownerLabel: string;
}

export function allClaims(e: Evidence): IndexedClaim[] {
  const out: IndexedClaim[] = [];
  for (const r of e.experience) {
    for (const c of r.claims) out.push({ claim: c, ownerId: r.id, ownerKind: "role", ownerLabel: `${r.title}, ${r.company}` });
  }
  for (const p of e.projects) {
    for (const c of p.claims) out.push({ claim: c, ownerId: p.id, ownerKind: "project", ownerLabel: p.name });
  }
  return out;
}

export function verifiedClaims(e: Evidence): IndexedClaim[] {
  return allClaims(e).filter((c) => c.claim.verified);
}

/**
 * Content address of what the ledger asserts. Only verified material counts:
 * toggling an unverified claim cannot change any generated output, so it must
 * not invalidate anything either.
 */
export function evidenceVersion(e: Evidence): string {
  return hashInput({
    basics: e.basics,
    skills: e.skills,
    claims: verifiedClaims(e).map((c) => ({ ...c.claim, owner: c.ownerId })),
    roles: e.experience.map((r) => ({ id: r.id, company: r.company, title: r.title, start: r.start, end: r.end })),
    projects: e.projects.map((p) => ({ id: p.id, name: p.name })),
    education: e.education,
    certifications: e.certifications,
  }).slice(0, 16);
}

export interface LintIssue {
  level: "error" | "warning";
  where: string;
  message: string;
}

export function lintEvidence(e: Evidence): LintIssue[] {
  const issues: LintIssue[] = [];
  const push = (level: LintIssue["level"], where: string, message: string) => issues.push({ level, where, message });
  const ids = new Map<string, string>();
  const claimId = (id: string, where: string) => {
    const prior = ids.get(id);
    if (prior) push("error", where, `duplicate id "${id}" (also used by ${prior})`);
    else ids.set(id, where);
  };

  const skillNames = new Set(e.skills.map((s) => s.name.toLowerCase()));
  for (const r of e.experience) {
    claimId(r.id, `experience.${r.id}`);
    if (r.end && r.end < r.start) push("error", `experience.${r.id}`, `end (${r.end}) is before start (${r.start})`);
    if (r.claims.length === 0) push("warning", `experience.${r.id}`, "no claims, so this role can never be selected");
  }
  for (const p of e.projects) claimId(p.id, `projects.${p.id}`);
  for (const v of [...e.basics.headlines, ...e.basics.summaries]) claimId(v.id, `basics.${v.id}`);
  for (const ed of e.education) claimId(ed.id, `education.${ed.id}`);
  for (const c of allClaims(e)) {
    const where = `${c.ownerKind === "role" ? "experience" : "projects"}.${c.ownerId}.${c.claim.id}`;
    claimId(c.claim.id, where);
    if (c.claim.skills.length === 0) push("warning", where, "no skills tagged, so this claim can never match a requirement");
    for (const s of c.claim.skills) {
      if (!skillNames.has(s.toLowerCase())) push("error", where, `tagged skill "${s}" is not declared in skills`);
    }
    if (/\bTODO\b|\bFIXME\b|<[a-z]+(?: [a-z]+)+>/.test(c.claim.text)) push("error", where, "claim still contains placeholder text");
  }
  if (e.experience.length === 0) push("error", "experience", "no employment history: tailoring has nothing to select from");
  if (e.basics.headlines.length === 0) push("warning", "basics.headlines", "no headline variants; tailored resumes will have no headline");
  if (e.basics.summaries.length === 0) push("warning", "basics.summaries", "no summary variants; tailored resumes will have no summary");

  const sorted = [...e.experience].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.end;
    const gap = prevEnd ? monthsBetween(prevEnd, sorted[i]!.start) : 0;
    if (gap > 4) push("warning", `experience.${sorted[i]!.id}`, `${gap}-month gap after ${sorted[i - 1]!.company}; expect to be asked`);
  }
  return issues;
}

export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am);
}

/** Career span in years, earliest start to latest end. */
export function careerYears(roles: ReadonlyArray<{ start: string; end: string | null }>, now: Date): number {
  if (!roles.length) return 0;
  const nowYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const first = roles.map((r) => r.start).sort()[0]!;
  const last = roles.map((r) => r.end ?? nowYm).sort().at(-1)!;
  return Math.max(0, Math.round((monthsBetween(first, last) / 12) * 10) / 10);
}
