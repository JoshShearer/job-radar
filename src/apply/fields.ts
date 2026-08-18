import type { Personal } from "../config/personal.js";
import type { ApplicationPack } from "../analysis/application.js";
import type { Resume } from "../resume/schema.js";

/**
 * Deterministic form-field logic.
 *
 * Everything in this file is pure and tested. The browser driver in
 * `autofill.ts` is deliberately thin: it finds controls, asks these functions
 * what to do, and does it. No model is involved in deciding what goes in a
 * form field - a wrong answer to "are you authorized to work here" is a
 * misrepresentation, not a ranking error, so it must be reproducible and
 * auditable.
 */

export type FieldIntent =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "country"
  | "state"
  | "city"
  | "postal_code"
  | "location"
  | "linkedin"
  | "github"
  | "twitter"
  | "website"
  | "resume"
  | "cover_letter"
  | "work_authorization"
  | "sponsorship"
  | "salary_expectation"
  | "notice_period"
  | "referral_source"
  | "current_company"
  | "current_title"
  | "eeo"
  | "attestation"
  | "unknown";

/** Normalize a label for matching: lowercase, punctuation to spaces, collapsed. */
export function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ordered rules. Order is load-bearing, and the first two entries are the
 * reason this is ordered rather than scored:
 *
 * - `eeo` first, so "do you identify as transgender" can never fall through to
 *   some other rule and get an automatic answer.
 * - `attestation` second, so "I acknowledge I have read..." is never affirmed
 *   on the candidate's behalf.
 *
 * After those, more specific phrases precede more general ones. `sponsorship`
 * precedes `work_authorization` because "will you require visa sponsorship"
 * contains no authorization wording but the reverse question often mentions
 * sponsorship.
 */
const RULES: ReadonlyArray<readonly [FieldIntent, RegExp]> = [
  // SUFFIXES MATTER HERE. Every alternative is wrapped in a trailing `\b`, so a
  // stem cannot match its own inflections: `pronoun` did not match "pronouns",
  // and `self identif` could never match "self identify" or
  // "self identification" at all - the boundary has to fall mid-word for those
  // to match, which it cannot. Both were dead alternatives in a refusal.
  //
  // Found live: Samsara asks "Feel free to share your preferred name and
  // pronouns (she/her, they/them, he/him, ze/zir etc.)", which fell through to
  // `first_name` and got answered. Pronouns are gender self-disclosure, and
  // whether to give them is the candidate's call, not this tool's.
  [
    "eeo",
    /\b(gender identity|gender|racial|ethnic|ethnicity|race|sexual orientation|transgender|disabilit\w*|chronic condition|veteran|armed forces|hispanic|latino|pronouns?|self[- ]?identif\w*)\b/,
  ],
  [
    "attestation",
    /\b(i acknowledge|i certify|i confirm|i agree|i have read|acknowledge\w*|consent\w*|privacy notice|terms and conditions|double check|ensuring accuracy|attest\w*)\b/,
  ],
  ["cover_letter", /cover letter/],
  ["resume", /\b(resume|cv|curriculum vitae)\b/],
  ["first_name", /\b(first|given|preferred) name\b/],
  ["last_name", /\b(last|family|sur) ?name\b|surname/],
  ["email", /\be ?mail\b/],
  ["phone", /\b(phone|mobile|telephone|cell)\b/],
  ["linkedin", /linked ?in/],
  ["github", /git ?hub/],
  ["twitter", /\b(twitter|x profile)\b/],
  ["website", /\b(website|portfolio|personal site|blog|url)\b/],
  ["sponsorship", /\bsponsor/],
  [
    "work_authorization",
    /\b(work authorization|authorized to work|authorised to work|legally authorized|right to work|work permit|eligible to work|work status)\b/,
  ],
  ["referral_source", /\b(how did you hear|where did you.*hear|referral|referred|how you found|source)\b/],
  // "Current/Most Recent Company Name". Anchored on employer wording so that
  // "why do you want to work at this company" cannot match it.
  [
    "current_company",
    /\b(current|most recent|present|previous|last)\b[^?]*\b(company|employer|organi[sz]ation)\b|^(company|employer)( name)?$/,
  ],
  ["current_title", /\b(current|most recent|present|previous|last)\b[^?]*\b(job )?title\b|^(job )?title$|\bcurrent role\b/],
  [
    "salary_expectation",
    /\b(salary|compensation expectation|desired (pay|compensation|salary)|expected (salary|compensation)|pay expectation)\b/,
  ],
  ["notice_period", /\b(notice period|when can you start|earliest start|start date|availability)\b/],
  ["country", /\bcountr(y|ies)\b/],
  ["state", /\b(states?|province)\b/],
  ["city", /\bcity\b/],
  // Before `location`, and that ordering is the whole point. Samsara asks
  // "What is the zip code of your primary residence?", which matches
  // /residence/ - so this landed in `location` and typed
  // "Austin, Texas, United States" into a zip code box on a real application.
  // A wrong answer is worse than a blank one; a wrong answer that looks
  // deliberate is worse still.
  ["postal_code", /\b(zip|postal)\s*code\b|\bpostcode\b|\bzip\b/],
  ["location", /\b(location|where are you based|currently based|residence)\b/],
  ["full_name", /^name$|^full name$|\byour name\b/],
];

export function classifyLabel(rawLabel: string): FieldIntent {
  const label = normalizeLabel(rawLabel);
  if (!label) return "unknown";

  // "United States" appearing in a label must not make it a state question.
  const forState = label.replace(/united states/g, "usa");

  for (const [intent, re] of RULES) {
    const target = intent === "state" ? forState : label;
    if (re.test(target)) return intent;
  }
  return "unknown";
}

/**
 * Categories this tool will never answer automatically, and why.
 *
 * These are not "hard to parse" - they are answers that are not the tool's to
 * give. Demographic self-identification is the candidate's to disclose or
 * withhold, and an attestation is a statement that a human read something and
 * stands behind it. Auto-filling either would be the software making a claim
 * in his name.
 */
export const NEVER_FILL: Readonly<Record<string, string>> = {
  eeo: "demographic self-identification is yours to answer or leave blank, never mine",
  attestation: "this is you certifying something; software must not affirm it for you",
};

export function isNeverFill(intent: FieldIntent): boolean {
  return intent in NEVER_FILL;
}

/** Guard used before clicking anything. Nothing matching this is ever clicked. */
export function isSubmitControl(text: string): boolean {
  const t = normalizeLabel(text);
  if (!t) return false;
  return /\b(submit|send application|apply now|finish and apply|complete application)\b/.test(t);
}

export type FillDecision =
  | { action: "fill"; value: string; why: string }
  | { action: "select"; desired: string; why: string }
  | { action: "file"; kind: "resume" | "cover_letter"; why: string }
  | { action: "skip"; why: string; consequential?: boolean };

export interface DecisionContext {
  personal: Personal;
  pack: ApplicationPack | null;
  /**
   * Master resume, when the caller has it. Employment history is answered from
   * here rather than duplicated into `personal.yaml`: two copies of where you
   * work is two things to keep in sync, and the stale one ends up on an
   * application.
   */
  resume?: Resume;
}

/**
 * The role a form means by "current/most recent".
 *
 * Deterministic, because a form field is not the place to be creative: an
 * ongoing role wins over a finished one, the latest start breaks ties among
 * ongoing roles, and the latest end date decides when nothing is ongoing. A
 * same-start tie falls back to the company name compared byte-wise, so the same
 * resume always produces the same answer regardless of array order.
 *
 * The caller reports which role this picked, so a candidate who means the other
 * one can see it and change it before submitting.
 */
export function currentRole(resume: Resume | undefined): Resume["experience"][number] | null {
  const roles = resume?.experience ?? [];
  if (!roles.length) return null;

  const ongoing = roles.filter((r) => !r.end);
  const pool = ongoing.length ? ongoing : roles;
  const key = (r: (typeof roles)[number]) => (ongoing.length ? r.start : (r.end ?? r.start));

  return [...pool].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    if (a.company === b.company) return 0;
    return a.company < b.company ? -1 : 1;
  })[0] as (typeof roles)[number];
}

/**
 * Decide what a field should receive. Returns a `skip` with a readable reason
 * rather than a guess whenever the honest answer is "I do not know".
 */
export function decide(rawLabel: string, intent: FieldIntent, ctx: DecisionContext): FillDecision {
  const { personal: p } = ctx;
  const label = normalizeLabel(rawLabel);

  // Manual overrides win over everything, including the never-fill rules being
  // skipped: if the candidate wrote an answer for a question by hand, that is
  // his own answer, not the tool's.
  for (const o of p.answers) {
    if (label.includes(normalizeLabel(o.match))) {
      return { action: "fill", value: o.answer, why: `your override for "${o.match}"` };
    }
  }

  if (isNeverFill(intent)) {
    return { action: "skip", why: NEVER_FILL[intent] as string, consequential: intent === "attestation" };
  }

  switch (intent) {
    case "first_name":
      return { action: "fill", value: p.identity.first_name, why: "personal.yaml" };
    case "last_name":
      return { action: "fill", value: p.identity.last_name, why: "personal.yaml" };
    case "full_name":
      return {
        action: "fill",
        value: `${p.identity.first_name} ${p.identity.last_name}`,
        why: "personal.yaml",
      };
    case "email":
      return { action: "fill", value: p.identity.email, why: "personal.yaml" };
    case "phone":
      return required(p.identity.phone, "identity.phone");
    case "country":
      return p.identity.country
        ? { action: "select", desired: p.identity.country, why: "personal.yaml" }
        : { action: "skip", why: "identity.country is not set in personal.yaml", consequential: true };
    case "state":
      return p.identity.state
        ? { action: "select", desired: p.identity.state, why: "personal.yaml" }
        : { action: "skip", why: "identity.state is not set in personal.yaml", consequential: true };
    case "city":
      return required(p.identity.city, "identity.city");
    case "postal_code":
      // Not derivable from the city. Unset means unknown, and an invented
      // postal code is a false statement on an employer's form.
      return required(p.identity.postal_code, "identity.postal_code");
    case "location":
      return p.identity.city && p.identity.state
        ? {
            action: "fill",
            value: `${p.identity.city}, ${p.identity.state}, ${p.identity.country}`,
            why: "personal.yaml",
          }
        : { action: "skip", why: "identity.city/state are not set in personal.yaml", consequential: true };
    case "linkedin":
    case "github":
    case "website":
    case "twitter": {
      const value = p.links[intent];
      return value
        ? { action: "fill", value, why: "personal.yaml" }
        : { action: "skip", why: `no ${intent} set in personal.yaml` };
    }
    case "resume":
      return { action: "file", kind: "resume", why: "resumes/" };
    case "cover_letter":
      return { action: "file", kind: "cover_letter", why: "prepared pack" };
    // Work eligibility is the one place where a confident wrong answer is a
    // false statement rather than a bad guess, so `null` is never coerced.
    case "sponsorship":
      return p.work_eligibility.requires_sponsorship === null
        ? {
            action: "skip",
            why: "work_eligibility.requires_sponsorship is unset in personal.yaml - answer this one yourself",
            consequential: true,
          }
        : {
            action: "select",
            desired: p.work_eligibility.requires_sponsorship ? "Yes" : "No",
            why: "personal.yaml work_eligibility",
          };
    case "work_authorization":
      return p.work_eligibility.authorized_to_work_us === null
        ? {
            action: "skip",
            why: "work_eligibility.authorized_to_work_us is unset in personal.yaml - answer this one yourself",
            consequential: true,
          }
        : {
            action: "select",
            desired: p.work_eligibility.authorized_to_work_us
              ? p.work_eligibility.authorization_option_hint
              : "not authorized",
            why: "personal.yaml work_eligibility",
          };
    // Answered from the master resume, never from a second copy of the same
    // fact. `why` names the role so a candidate who meant the other one can see
    // the pick and change it before submitting.
    case "current_company":
    case "current_title": {
      const r = currentRole(ctx.resume);
      if (!r) {
        return {
          action: "skip",
          why: "no employment history loaded - fill this one in yourself",
        };
      }
      return intent === "current_company"
        ? { action: "fill", value: r.company, why: `${r.company} in resume.yaml` }
        : { action: "fill", value: r.title, why: `your title at ${r.company} in resume.yaml` };
    }
    case "referral_source":
      return p.preferences.referral_source
        ? { action: "select", desired: p.preferences.referral_source, why: "personal.yaml" }
        : { action: "skip", why: "no referral_source set in personal.yaml" };
    case "notice_period":
      return p.preferences.notice_period
        ? { action: "fill", value: p.preferences.notice_period, why: "personal.yaml" }
        : { action: "skip", why: "no notice_period set in personal.yaml" };
    case "salary_expectation":
      return p.preferences.desired_salary
        ? { action: "fill", value: p.preferences.desired_salary, why: "personal.yaml" }
        : {
            action: "skip",
            // Flagged loudly rather than filled. The first number on the form
            // is the anchor for the whole negotiation.
            why: "desired_salary is empty in personal.yaml - the pack's advice is usually to ask for their range first",
            consequential: true,
          };
    default:
      return { action: "skip", why: "no rule matched this question" };
  }
}

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
  "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah",
  "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
] as const;

/** True when a dropdown is really a yes/no question. */
export function isYesNoOptions(options: string[]): boolean {
  if (options.length < 2 || options.length > 4) return false;
  const n = options.map(normalizeLabel);
  return n.includes("yes") && n.includes("no");
}

/**
 * Answer "Do you live in one of the following states? Alabama, Alaska, ..." -
 * a yes/no question whose correct answer is determined entirely by the list
 * embedded in the question text. Deterministic membership, no model needed.
 *
 * Returns null (leave it to the human) when the question is not actually an
 * enumeration, or when the label was truncated and the state could be sitting
 * in the part that got cut off. A confident "No" derived from half a list is
 * exactly the kind of wrong answer this system must not produce.
 */
export function stateListAnswer(label: string, state: string, truncated: boolean): "Yes" | "No" | null {
  if (!state) return null;
  const normalized = normalizeLabel(label);
  const listed = US_STATES.filter((s) => new RegExp(`\\b${normalizeLabel(s)}\\b`).test(normalized));
  if (listed.length < 3) return null;

  const target = normalizeLabel(state);
  // "West Virginia" contains "Virginia" as a whole word, so longer state names
  // that embed the target are masked out before testing membership.
  const masked = US_STATES.map(normalizeLabel)
    .filter((s) => s !== target && s.includes(target))
    .reduce((acc, s) => acc.split(s).join(" "), normalized);

  if (new RegExp(`\\b${target}\\b`).test(masked)) return "Yes";
  return truncated ? null : "No";
}

/** A value that must come from config, or an explicit "you have not told me". */
function required(value: string, key: string): FillDecision {
  return value
    ? { action: "fill", value, why: "personal.yaml" }
    : { action: "skip", why: `${key} is not set in personal.yaml`, consequential: true };
}

/** Token set for overlap scoring, with noise words dropped. */
const STOP = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "do", "you",
  "your", "please", "select", "choose", "this", "that", "any", "with", "at", "as", "i",
  "we", "my", "me", "it", "be", "have", "has", "will", "would", "can", "if", "not",
]);

function tokens(s: string): Set<string> {
  return new Set(normalizeLabel(s).split(" ").filter((t) => t && !STOP.has(t)));
}

/**
 * Score how well an option answers a desired value, 0..1.
 *
 * Exact match short-circuits to 1. Otherwise this is the fraction of the
 * desired value's meaningful tokens present in the option, with a penalty when
 * the option carries a negation the desired value does not. That penalty is
 * the important part: "I am not authorized to work in the US" shares almost
 * every token with "I am authorized to work in the US".
 */
export function scoreOption(desired: string, option: string): number {
  const d = normalizeLabel(desired);
  const o = normalizeLabel(option);
  if (!d || !o) return 0;
  if (d === o) return 1;

  const dt = tokens(d);
  const ot = tokens(o);
  if (dt.size === 0) return 0;

  let hits = 0;
  for (const t of dt) if (ot.has(t)) hits++;
  let score = hits / dt.size;

  const desiredNegated = /\bno\b|\bnot\b|\bnever\b|\bdo not\b|\bwithout\b/.test(d);
  const optionNegated = /\bno\b|\bnot\b|\bnever\b|\bdo not\b|\bwithout\b/.test(o);
  if (desiredNegated !== optionNegated) score -= 0.5;

  // A short option fully contained in the desired phrase (or vice versa) is a
  // strong signal that survives token-count differences.
  if (score > 0 && (d.includes(o) || o.includes(d))) score = Math.max(score, 0.8);

  // Only string equality scores a clean 1. Full token coverage is NOT the same
  // thing: "authorized to work in the US for any employer" and "...for my
  // current employer only" both contain every token of "authorized to work in
  // the US". Reserving 1.0 for exact equality is what lets `chooseOption` tell
  // "certain" apart from "covered everything and still ambiguous", and refuse.
  return Math.max(0, Math.min(0.99, score));
}

export interface OptionMatch {
  option: string;
  score: number;
}

/**
 * Pick an option, or return null when nothing is confident enough.
 *
 * Refusing to choose is a supported outcome. An unfilled dropdown is a visible
 * gap the candidate resolves in five seconds; a confidently wrong answer to a
 * work-authorization question can be a lie on a job application.
 */
export function chooseOption(desired: string, options: string[], threshold = 0.6): OptionMatch | null {
  let best: OptionMatch | null = null;
  let runnerUp = 0;

  for (const option of options) {
    const score = scoreOption(desired, option);
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { option, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (!best || best.score < threshold) return null;
  // An ambiguous top two is not a match. Ties happen on questions like
  // "authorized with sponsorship" vs "authorized without sponsorship".
  if (best.score < 1 && runnerUp > 0 && best.score - runnerUp < 0.15) return null;
  return best;
}

/**
 * Match a form's free-text question to a prepared answer from the pack.
 * Symmetric overlap, so a long prepared question does not out-score a short
 * form question or vice versa.
 */
export function matchPreparedAnswer(
  question: string,
  prepared: ReadonlyArray<{ question: string; answer: string }>,
  threshold = 0.5,
): { answer: string; matched: string; score: number } | null {
  const qt = tokens(question);
  if (qt.size === 0) return null;

  let best: { answer: string; matched: string; score: number } | null = null;
  for (const p of prepared) {
    const pt = tokens(p.question);
    if (pt.size === 0) continue;
    let hits = 0;
    for (const t of qt) if (pt.has(t)) hits++;
    const score = (2 * hits) / (qt.size + pt.size);
    if (!best || score > best.score) best = { answer: p.answer, matched: p.question, score };
  }
  return best && best.score >= threshold ? best : null;
}
