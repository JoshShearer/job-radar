import { canonicalSkill, containsSkill } from "../lib/text.js";
import type { Resume, Skill } from "./schema.js";

/**
 * Deterministic requirement extraction.
 *
 * Pulling the "what we need" lines out of a job description is string work,
 * not judgement, so no model touches it. It also has to run over the whole
 * index cheaply, and it has to give the same answer twice for the same
 * posting - otherwise a resume regenerated tomorrow silently differs.
 */

export type Weight = "required" | "preferred";

export interface Requirement {
  text: string;
  weight: Weight;
  /** The heading it appeared under, for explainability. */
  section: string;
}

const SECTION_HEADINGS: ReadonlyArray<readonly [RegExp, Weight]> = [
  [/\b(nice[- ]to[- ]have|bonus|preferred qualifications|preferred|plus(es)?|icing)\b/i, "preferred"],
  [
    /\b(requirements?|qualifications?|what you.{0,12}(bring|have|need|ll need)|who you are|about you|we.{0,5}re looking for|you (should )?have|minimum qualifications|basic qualifications|must[- ]have)\b/i,
    "required",
  ],
  [/\b(responsibilities|what you.{0,6}ll do|the role|day to day|in this role)\b/i, "required"],
];

const STOP_SECTION =
  /\b(benefits|perks|compensation|salary|equal opportunity|eeo|about us|about the company|our values|how to apply|interview process|what we offer)\b/i;

const BULLET = /^\s*(?:[-*•●○▪‣·]|\d+[.)])\s+(.*)$/;

/**
 * A line is requirement-like if it is a bullet, or a short standalone line
 * inside a requirements section. Prose paragraphs are skipped: they are almost
 * always narrative, and treating them as requirements floods the match report
 * with noise that hides the real gaps.
 */
export function extractRequirements(description: string): Requirement[] {
  const lines = description.split(/\r?\n/);
  const out: Requirement[] = [];
  const seen = new Set<string>();

  let weight: Weight | null = null;
  let section = "";
  let sawBullet = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = matchHeading(line);
    if (heading) {
      weight = heading.weight;
      section = line.replace(/[:\s]+$/, "").slice(0, 80);
      sawBullet = false;
      continue;
    }
    if (STOP_SECTION.test(line) && line.length < 90) {
      weight = null;
      continue;
    }
    if (!weight) continue;

    const m = BULLET.exec(line);
    // Once a section starts listing bullets, the requirements ARE the bullets.
    // A prose line after them is narrative ("we move fast and value ownership"),
    // and admitting it floods the gap list with things nobody is screening for.
    if (!m && sawBullet) continue;
    if (m) sawBullet = true;

    const text = (m?.[1] ?? line).trim();
    if (!m && (text.length > 180 || text.split(/\s+/).length > 30)) continue;
    if (text.length < 8) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: text.replace(/\s+/g, " "), weight, section });
  }

  return out;
}

function matchHeading(line: string): { weight: Weight } | null {
  // A heading is short. "You should have 5 years of React" is a requirement,
  // not a section header, even though it matches the same words.
  if (line.length > 90) return null;
  for (const [re, weight] of SECTION_HEADINGS) {
    if (re.test(line)) return { weight };
  }
  return null;
}

export interface SkillHit {
  skill: string;
  /** Which spelling actually matched, for the report. */
  matched: string;
}

/** Every master skill named by a piece of text. Alias-aware, spelling-proof. */
export function skillsMentioned(text: string, skills: Skill[]): SkillHit[] {
  const canon = canonicalSkill(text);
  const hits: SkillHit[] = [];
  for (const s of skills) {
    for (const spelling of [s.name, ...s.aliases]) {
      const c = canonicalSkill(spelling);
      if (c && containsSkill(canon, c)) {
        hits.push({ skill: s.name, matched: spelling });
        break;
      }
    }
  }
  return hits;
}

/**
 * Some requirements ask for more than a technology: they ask for a SCOPE of
 * experience with it. "Have contributed to the Next.js open-source projects"
 * names React and Next.js, so naive skill matching counts every React bullet
 * as evidence and reports the requirement covered. It is not covered, and a
 * resume built on that reading over-claims.
 *
 * Each qualifier below is detected in the requirement and must then be
 * independently evidenced in the bullet. Unmet qualifiers downgrade a match to
 * `partial`, which reads as "you have the technology, not the claimed scope".
 */
const QUALIFIERS: ReadonlyArray<{ kind: string; inRequirement: RegExp; inEvidence: RegExp; note: string }> = [
  {
    kind: "leadership",
    inRequirement: /\b(led|leading|lead(?:s|ing)?\b|managed|mentor(ed|ing)?|team of|line manage)\b/i,
    inEvidence: /\b(led|lead|leading|managed|mentored|owned|head(ed)?|director|principal|staff)\b/i,
    note: "asks for leading, not just doing",
  },
  {
    kind: "open source",
    inRequirement: /\b(open[- ]source|oss|contributed to|contributor|maintainer|maintain (a |popular |the ))/i,
    inEvidence: /\b(open[- ]source|oss|contributed|contributor|maintainer|pull request|upstream)\b/i,
    note: "asks for open-source contribution",
  },
  {
    kind: "enterprise scale",
    inRequirement: /\b(at scale|large[- ]scale|enterprise|high[- ]traffic|millions|billions|fortune \d+)\b/i,
    inEvidence: /\b(enterprise|at scale|million|billion|[0-9][0-9,.]*\s?(k|m)\b|high[- ]traffic|fortune)\b/i,
    note: "asks for scale this resume does not evidence",
  },
  {
    kind: "migration",
    inRequirement: /\b(migrat(e|ed|ing|ion)|modernized?|legacy|re-?platform)\b/i,
    inEvidence: /\b(migrat(e|ed|ing|ion)|modernized?|legacy|re-?platform|port(ed)?|upgrade[ds]?)\b/i,
    note: "asks for migration work specifically",
  },
  {
    kind: "public speaking",
    inRequirement: /\b(conference|speak(er|ing)|talks|published author|blog(ged)? publicly)\b/i,
    inEvidence: /\b(spoke|speaker|conference|talk|presented|published)\b/i,
    note: "asks for public speaking or publishing",
  },
];

export interface RequirementMatch {
  requirement: Requirement;
  skills: SkillHit[];
  /** Bullet ids that are evidence for this requirement. */
  evidence: Array<{ bulletId: string; sourceLabel: string; text: string }>;
  /**
   * covered = evidenced. partial = the technology matches but the scope the
   * requirement asks for is not evidenced. gap = nothing.
   */
  status: "covered" | "partial" | "gap";
  /** Qualifiers the requirement asks for that no evidence bullet satisfies. */
  unmet: string[];
  covered: boolean;
}

/** Years of experience the requirement demands, if it states a number. */
export function yearsDemanded(text: string): number | null {
  const m = /\b(\d{1,2})\s*\+?\s*(?:or more\s*)?years?\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** Career span in years, earliest start to latest end. Deterministic given a date. */
export function careerYears(
  roles: Array<{ start: string; end: string | null }>,
  now = new Date(),
): number {
  if (!roles.length) return 0;
  const starts = roles.map((r) => r.start).sort();
  const nowYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const ends = roles.map((r) => r.end ?? nowYm).sort();
  const first = starts[0]!;
  const last = ends[ends.length - 1]!;
  const [fy, fm] = first.split("-").map(Number) as [number, number];
  const [ly, lm] = last.split("-").map(Number) as [number, number];
  return Math.max(0, Math.round((((ly - fy) * 12 + (lm - fm)) / 12) * 10) / 10);
}

export interface MatchReport {
  matches: RequirementMatch[];
  gaps: Requirement[];
  /** Skills the posting asks for that the master resume does not claim at all. */
  unclaimedTerms: string[];
  requiredCoverage: number;
  preferredCoverage: number;
  careerYears: number;
  /** Master skills the posting names - the honest keyword set for this role. */
  relevantSkills: string[];
}

/**
 * Match a posting's requirements against the master resume.
 *
 * Coverage is computed over REQUIREMENTS, not keywords, because that is the
 * question that matters: how much of what they asked for can be evidenced.
 * A resume that name-drops every technology but evidences none of them scores
 * badly here, which is the intended behavior.
 */
export function matchResumeToJob(
  resume: Resume,
  description: string,
  bullets: Array<{ bullet: { id: string; text: string; skills: string[]; verified: boolean }; sourceLabel: string }>,
  now = new Date(),
): MatchReport {
  const requirements = extractRequirements(description);
  const matches: RequirementMatch[] = [];
  const relevant = new Set<string>();

  const years = careerYears(resume.experience, now);

  for (const requirement of requirements) {
    const hits = skillsMentioned(requirement.text, resume.skills);
    for (const h of hits) relevant.add(h.skill);

    const wanted = new Set(hits.map((h) => h.skill.toLowerCase()));
    const evidence = bullets
      .filter((b) => b.bullet.verified && b.bullet.skills.some((s) => wanted.has(s.toLowerCase())))
      .slice(0, 4)
      .map((b) => ({ bulletId: b.bullet.id, sourceLabel: b.sourceLabel, text: b.bullet.text }));

    const unmet: string[] = [];
    if (evidence.length) {
      const evidenceText = evidence.map((e) => e.text).join(" ");
      for (const q of QUALIFIERS) {
        if (!q.inRequirement.test(requirement.text)) continue;
        if (q.inEvidence.test(evidenceText)) continue;
        unmet.push(`${q.kind}: ${q.note}`);
      }
      // A stated years threshold is checked against the career span, not
      // against any bullet - no single bullet can evidence a decade.
      const demanded = yearsDemanded(requirement.text);
      if (demanded !== null && years < demanded) {
        unmet.push(`experience: asks for ${demanded}+ years, resume spans ${years}`);
      }
    }

    const status: RequirementMatch["status"] =
      evidence.length === 0 ? "gap" : unmet.length ? "partial" : "covered";

    matches.push({ requirement, skills: hits, evidence, status, unmet, covered: status === "covered" });
  }

  const req = matches.filter((m) => m.requirement.weight === "required");
  const pref = matches.filter((m) => m.requirement.weight === "preferred");

  return {
    matches,
    gaps: matches.filter((m) => m.status !== "covered").map((m) => m.requirement),
    unclaimedTerms: unclaimedTerms(description, resume),
    requiredCoverage: pct(req.filter((m) => m.covered).length, req.length),
    preferredCoverage: pct(pref.filter((m) => m.covered).length, pref.length),
    relevantSkills: [...relevant],
    careerYears: years,
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

/**
 * Technology-shaped terms in the posting that the master resume never claims.
 * These are candidates for the "do not claim" list, not for the resume.
 */
const TECH_VOCAB = [
  "rust", "go", "golang", "kubernetes", "terraform", "kafka", "spark", "scala", "elixir", "ruby",
  "rails", "django", "flask", "java", "kotlin", "swift", "c++", "c#", ".net", "php", "laravel",
  "graphql", "grpc", "redis", "elasticsearch", "snowflake", "databricks", "dbt", "airflow",
  "tensorflow", "pytorch", "langchain", "llamaindex", "mcp", "rag", "vector database", "pinecone",
  "docker", "aws lambda", "gcp", "azure", "salesforce", "hubspot", "segment", "amplitude",
];

function unclaimedTerms(description: string, resume: Resume): string[] {
  const canon = canonicalSkill(description);
  const claimed = new Set<string>();
  for (const s of resume.skills) {
    for (const spelling of [s.name, ...s.aliases]) claimed.add(canonicalSkill(spelling));
  }
  const out: string[] = [];
  for (const term of TECH_VOCAB) {
    const c = canonicalSkill(term);
    if (claimed.has(c)) continue;
    if (containsSkill(canon, c)) out.push(term);
  }
  return out;
}
