/**
 * Seniority classification from the job title.
 *
 * Titles are noisy across companies ("Engineer III" at one place equals
 * "Senior Engineer" at another), so this returns a coarse level plus the
 * evidence, and lets scoring decide what to do about it.
 */

export type SeniorityLevel = "junior" | "mid" | "senior" | "staff" | "lead" | "exec" | "unknown";

export interface SeniorityVerdict {
  level: SeniorityLevel;
  /** True when the title indicates a level at or above senior. */
  atOrAboveSenior: boolean;
  evidence: string | null;
}

const PATTERNS: [SeniorityLevel, RegExp][] = [
  ["exec", /\b(vp|vice president|head of|director|cto|chief)\b/i],
  ["lead", /\b(lead|principal|architect|founding)\b/i],
  ["staff", /\b(staff|senior staff|distinguished)\b/i],
  ["senior", /\b(senior|sr\.?|snr)\b/i],
  ["junior", /\b(intern|internship|junior|jr\.?|entry[- ]level|new grad|graduate program|apprentice|associate engineer)\b/i],
];

// "Engineer II" / "Software Engineer 2" / "L3" style levels.
const NUMERIC_LEVEL = /\b(?:engineer|developer|swe)\s*(?:-|–)?\s*(i{1,3}|iv|v|[1-5])\b/i;
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

export function classifySeniority(title: string): SeniorityVerdict {
  const t = title.trim();

  for (const [level, re] of PATTERNS) {
    const m = re.exec(t);
    if (m) {
      return {
        level,
        atOrAboveSenior: level !== "junior",
        evidence: m[0],
      };
    }
  }

  const num = NUMERIC_LEVEL.exec(t);
  if (num?.[1]) {
    const token = num[1].toLowerCase();
    const n = ROMAN[token] ?? Number(token);
    if (Number.isFinite(n)) {
      // I/II are below senior at essentially every company; III+ is ambiguous
      // but usually at least mid-to-senior.
      if (n <= 2) return { level: "junior", atOrAboveSenior: false, evidence: num[0] };
      return { level: "senior", atOrAboveSenior: true, evidence: num[0] };
    }
  }

  // A bare "Software Engineer" with no modifier is genuinely ambiguous.
  return { level: "unknown", atOrAboveSenior: false, evidence: null };
}

/**
 * Whether a title should be rejected outright on seniority grounds.
 * Ambiguous titles are NOT rejected - they are down-ranked by scoring, because
 * "Software Engineer" at a 30-person startup is frequently a senior role.
 */
export function isBelowSenior(title: string, rejectTerms: string[]): boolean {
  const t = title.toLowerCase();
  if (rejectTerms.some((term) => term.trim() && t.includes(term.toLowerCase().trim()))) return true;
  const verdict = classifySeniority(title);
  return verdict.level === "junior";
}

export type EmploymentType = "full_time" | "part_time" | "contract" | "internship" | "temporary" | "unknown";

const EMPLOYMENT_PATTERNS: [EmploymentType, RegExp][] = [
  ["internship", /\b(intern|internship)\b/i],
  ["contract", /\b(contract|contractor|c2c|corp[- ]to[- ]corp|1099|freelance|consultant|contract[- ]to[- ]hire)\b/i],
  ["part_time", /\b(part[- ]time|parttime)\b/i],
  ["temporary", /\b(temporary|temp\b|seasonal|fixed[- ]term)\b/i],
  ["full_time", /\b(full[- ]time|fulltime|permanent|w-?2)\b/i],
];

export function classifyEmployment(
  title: string,
  atsType: string | null | undefined,
  description: string,
): EmploymentType {
  const ats = (atsType ?? "").toLowerCase();
  if (ats.includes("intern")) return "internship";
  if (ats.includes("contract") || ats.includes("temp")) return "contract";
  if (ats.includes("part")) return "part_time";
  if (ats.includes("full")) return "full_time";

  const haystack = `${title}\n${description.slice(0, 1200)}`;
  for (const [type, re] of EMPLOYMENT_PATTERNS) {
    if (re.test(haystack)) return type;
  }
  return "unknown";
}
