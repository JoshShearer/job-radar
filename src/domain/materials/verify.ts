import type { Evidence, IndexedClaim, Scope, Skill } from "../candidate/evidence.js";
import { allClaims } from "../candidate/evidence.js";
import { AMBIGUOUS_TECH, GENERIC_ACRONYMS, TECH_TERMS } from "../text/tech-lexicon.js";

/**
 * Deterministic verification of generated text against the evidence ledger.
 *
 * ALLOWLIST, not deny-list. A sentence may only assert what the claims it
 * cites assert. Five kinds of assertion are extracted from both the sentence
 * and its cited evidence, and anything in the sentence that the evidence does
 * not contain is a problem:
 *
 *   numbers     digits and spelled-out numbers ("two hundred", "40%", "3x")
 *   technology  lexicon terms, the candidate's own skill names, and anything
 *               technology-shaped (CamelCase, dotted names, acronyms)
 *   scope       used < contributed < built < owned < led
 *   qualifiers  leadership, team size, org-wide reach, scale, open source,
 *               migration, public speaking, seniority titles
 *   names       capitalized names (companies, products, people)
 *
 * The caller decides what failure means. For a resume rewrite it means revert
 * to the claim's own wording; for a cover-letter sentence it means drop it and
 * tell the human. Reverting is always available, so strictness only ever costs
 * polish, never truth.
 */

export type ProblemKind =
  | "unknown_claim"
  | "unverified_claim"
  | "wrong_owner"
  | "novel_number"
  | "novel_technology"
  | "scope_inflation"
  | "novel_qualifier"
  | "novel_name"
  | "uncited_assertion";

export interface Problem {
  kind: ProblemKind;
  detail: string;
}

/**
 * Bump whenever verification or composition rules change. Saved generations
 * are stamped with it, so the next tailor/prepare/render re-composes and
 * re-verifies the saved plan under the current rules (free; no model call).
 * 2: skill-group headings verified as headings, not as prose.
 * 3: technology spans read once; "won't" is not "won"; hyphen compounds; the
 *    posting's department and team are target context.
 * 4: uncited first-person text must be framed as interest; target context
 *    names but never licenses; sentence-initial names checked; figures keep
 *    their unit; oversight and sole-ownership words are scope.
 */
export const MATERIAL_RULES_VERSION = 4;

export interface VerifyContext {
  claims: ReadonlyMap<string, IndexedClaim>;
  skills: readonly Skill[];
  /**
   * Words that may appear without evidence because they describe the TARGET,
   * not the candidate: the employer's name and the posting's title.
   */
  context: readonly string[];
}

export function verifyContext(e: Evidence, context: readonly string[] = []): VerifyContext {
  return { claims: new Map(allClaims(e).map((c) => [c.claim.id, c])), skills: e.skills, context };
}

/* ------------------------------------------------------------------ numbers */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  dozen: 12, half: 0.5, double: 2, twice: 2, triple: 3, tripled: 3, doubled: 2, quadrupled: 4,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

/**
 * "one" is too common as a pronoun ("one of the first") to treat as a figure;
 * it is a number only when a scale word follows it ("one hundred").
 */
const WEAK_UNITS = new Set(["one", "half"]);

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();

  // Digit forms: 200+, 1,200, $1.2m, 40%, 3x, 12k, "2 million".
  const re = /\$?(\d[\d,]*(?:\.\d+)?)(?![\d])\s?(k|mm|m|bn|b|million|billion|thousand)?(?![a-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    let n = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const unit = m[2];
    if (unit === "k" || unit === "thousand") n *= 1_000;
    else if (unit === "m" || unit === "mm" || unit === "million") n *= 1_000_000;
    else if (unit === "b" || unit === "bn" || unit === "billion") n *= 1_000_000_000;
    out.add(fmt(n));
  }
  // "3x", "10x": the multiplier letter is attached, so match it separately.
  // A figure with a unit is ALSO recorded with that unit, and the verifier
  // requires a united figure to appear with the same unit: "200+" in the
  // evidence does not license "200x" or "200%".
  for (const x of lower.matchAll(/(\d+(?:\.\d+)?)x\b/g)) {
    out.add(fmt(Number(x[1])));
    out.add(`${fmt(Number(x[1]))}x`);
  }
  for (const x of lower.matchAll(/(\d+(?:\.\d+)?)\s?(%|percent\b)/g)) out.add(`${fmt(Number(x[1]))}%`);
  // Vague quantities are still quantities.
  if (/\b(in half|by half|halved|halving)\b/.test(lower)) out.add("half");
  for (const x of lower.matchAll(/\b(dozens|hundreds|thousands|millions|billions|tens) of\b/g)) out.add(x[1]!);

  // Spelled-out numbers. Punctuation and digits end a number phrase, and a
  // scale word right after digits ("2 million") was already read above.
  const tokens = lower.match(/[a-z]+|\d[\d,.]*|[^a-z\d\s]/g) ?? [];
  let current: number | null = null;
  let total = 0;
  let weakOnly = false;
  const flush = () => {
    if ((current !== null || total) && !weakOnly) out.add(fmt(total + (current ?? 0)));
    current = null;
    total = 0;
    weakOnly = false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i]!;
    if (w in UNITS) {
      weakOnly = current === null && total === 0 ? WEAK_UNITS.has(w) : false;
      current = (current ?? 0) + UNITS[w]!;
    } else if (w in SCALES) {
      if (current === null && total === 0 && /^\d/.test(tokens[i - 1] ?? "")) continue;
      weakOnly = false;
      const base: number = current ?? 1;
      if (SCALES[w]! >= 1000) {
        total += base * SCALES[w]!;
        current = null;
      } else current = base * SCALES[w]!;
    } else if (w === "and" && (current !== null || total)) {
      continue;
    } else flush();
  }
  flush();
  return out;
}

/* --------------------------------------------------------------- technology */

/**
 * One canonical spelling per technology: punctuation and spacing are not
 * meaning, so "Next.js", "NextJS" and "next js" are the same claim.
 */
export function canon(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#]/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termRegex(term: string, caseSensitiveCap: boolean): RegExp {
  const body = escapeRe(term).replace(/\\ /g, "[\\s-]+").replace(/ /g, "[\\s-]+");
  // Word-ish boundaries that also respect + # . in names like c++ and next.js.
  return new RegExp(`(?<![A-Za-z0-9+#])${body}(?![A-Za-z0-9+#]|\\.[A-Za-z])`, caseSensitiveCap ? "g" : "gi");
}

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|inc|co|corp|ltd|jr|sr|dr|mr|ms|mrs|st)\.$/i;

function sentenceStarts(text: string): Set<number> {
  const starts = new Set<number>([0]);
  const re = /[.!?]\s+|\n+|^\s*[-*•]\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // "e.g. Walmart": an abbreviation's period does not start a sentence.
    if (m[0].startsWith(".") && ABBREVIATIONS.test(text.slice(0, m.index + 1))) continue;
    starts.add(m.index + m[0].length);
  }
  // Skip leading whitespace at position 0.
  const lead = /^\s*/.exec(text)?.[0].length ?? 0;
  starts.add(lead);
  return starts;
}

/** Technology terms asserted by `text`, canonicalized. */
export function extractTechnology(text: string, skills: readonly Skill[]): Set<string> {
  return new Set(technologySpans(text, skills).map((s) => s.canonical));
}

/** `text` with every technology span blanked (same length, so sentence starts are kept). */
function withoutTechnology(text: string, skills: readonly Skill[]): string {
  let out = text;
  for (const s of technologySpans(text, skills)) out = out.slice(0, s.start) + " ".repeat(s.end - s.start) + out.slice(s.end);
  return out;
}

function technologySpans(text: string, skills: readonly Skill[]): Array<{ start: number; end: number; canonical: string }> {
  const out: Array<{ start: number; end: number; canonical: string }> = [];
  const starts = sentenceStarts(text);
  const vocab = new Map<string, string>(); // spelling -> canonical name
  for (const t of TECH_TERMS) vocab.set(t, canon(t));
  // A skill's aliases all resolve to the skill, so citing a claim tagged
  // "Next.js" licenses writing "NextJS".
  const skillCanon = new Map<string, string>();
  for (const s of skills) for (const sp of [s.name, ...s.aliases]) skillCanon.set(canon(sp), canon(s.name));
  for (const s of skills) for (const sp of [s.name, ...s.aliases]) vocab.set(sp.toLowerCase(), canon(s.name));
  const resolve = (c: string) => skillCanon.get(c) ?? c;

  // Longest spelling first, and a span claimed by a longer term is not read
  // again as its parts: "Payload CMS" is one technology, not also "Payload"
  // and "CMS" (observed live, against a claim spelled "PayloadCMS").
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x);
  for (const [spelling, canonical] of [...vocab].sort((a, b) => b[0].length - a[0].length)) {
    if (!spelling) continue;
    const ambiguous = AMBIGUOUS_TECH.has(spelling);
    const re = termRegex(spelling, false);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0];
      if (overlaps(m.index, m.index + hit.length)) continue;
      if (ambiguous) {
        const capitalized = /^[A-Z]/.test(hit);
        const allCaps = hit.length > 1 && hit === hit.toUpperCase();
        if (!(allCaps || (capitalized && !starts.has(m.index)))) continue;
      }
      taken.push([m.index, m.index + hit.length]);
      out.push({ start: m.index, end: m.index + hit.length, canonical: resolve(canonical) });
    }
  }

  // Technology-shaped tokens the lexicon does not know.
  const shapedRe = /\b[A-Za-z][A-Za-z0-9]*(?:\.(?:js|ts|io|py|net|rb|go))\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][A-Z0-9]{1,}s?\b/g;
  let sm: RegExpExecArray | null;
  while ((sm = shapedRe.exec(text)) !== null) {
    const tok = sm[0];
    if (overlaps(sm.index, sm.index + tok.length)) continue;
    if (GENERIC_ACRONYMS.has(tok.toUpperCase().replace(/S$/, "")) || GENERIC_ACRONYMS.has(tok.toUpperCase())) continue;
    out.push({ start: sm.index, end: sm.index + tok.length, canonical: resolve(canon(tok)) });
  }
  return out;
}

/* -------------------------------------------------------------------- scope */

const SCOPE_RANK: Record<Scope, number> = { used: 0, contributed: 1, built: 2, owned: 3, led: 4 };

const SCOPE_PATTERNS: ReadonlyArray<readonly [Scope, RegExp]> = [
  ["led", /\b(led|lead(s|ing)?|manag(ed|es|ing|er)|mentor(ed|ing|s)?|direct(ed|ing|or)|head(ed|ing)?|supervis(ed|ing)|hired|coached|founded|co-?founded|founding|overs(aw|ee|ees|eeing|een)|steer(ed|ing)?|guid(ed|ing))\b/i],
  ["owned", /\b(own(ed|s|ing|er|ership)|architect(ed|ing)?|spearhead(ed|ing)?|drove|driving|end[- ]to[- ]end|responsible for|accountable for|championed|pioneered|coordinat(ed|ing)|single[- ]handedly|sole(ly)?)\b/i],
  ["built", /\b(buil[td]|building|design(ed|ing)?|develop(ed|ing)?|implement(ed|ing)?|creat(ed|ing)|engineer(ed|ing)|ship(ped|ping)|launch(ed|ing)|deliver(ed|ing)|wr(ote|itten)|author(ed)?|automat(ed|ing)|integrat(ed|ing)|ran|run|operat(ed|es|ing)|establish(ed)?|introduc(ed|ing)|migrat(ed|ing)|optimi[sz](ed|ing)|improv(ed|ing)|reduc(ed|ing)|increas(ed|ing)|scal(ed|ing))\b/i],
  ["contributed", /\b(contribut(ed|ing|or)|assist(ed|ing)|help(ed|ing)|support(ed|ing)|participat(ed|ing)|collaborat(ed|ing)|work(ed|ing) (on|with))\b/i],
];

/**
 * A past-tense achievement verb. Uncited text may say what the candidate WANTS
 * to do ("I'd like to help build"), not what they DID.
 */
const PAST_ACHIEVEMENT =
  /\b(led|managed|mentored|directed|headed|supervised|hired|founded|co-?founded|owned|architected|spearheaded|drove|built|designed|developed|implemented|created|engineered|shipped|launched|delivered|wrote|authored|automated|integrated|ran|operated|established|introduced|migrated|optimi[sz]ed|improved|reduced|increased|scaled|contributed|grew|achieved|won)\b(?!['\u2019]t)/i;

const FIRST_PERSON = /\b(I|me|my|mine|myself)\b|\bI['\u2019](m|ve|d|ll)\b/;
const INTENT_FRAME =
  /\b(I['\u2019]m|I am) (applying|writing|interested|excited|eager|keen|drawn|happy|glad|looking forward)\b|\bI['\u2019]d (like|love|welcome|enjoy|appreciate|be glad|be happy|bring)\b|\bI would (like|love|welcome|appreciate|enjoy|bring)\b|\bI (want|hope|look forward|wanted)\b|\bthank you\b/i;
const EXPERIENCE_CLAIM =
  /\bI have\b|\bI['\u2019]ve\b|\bI had\b|\bI was\b|\bI (am|['\u2019]m) (an?|the)\b|\bas I (have|did|do)\b|\byears?\b|\bmy (experience|career|time at|role at|team|work at)\b|\bfounding\b|\bdoctorate\b|\bph\.?d\b|\bdegree\b|\bcertifi(ed|cation)\b/i;

export function scopeOf(text: string): Scope {
  for (const [scope, re] of SCOPE_PATTERNS) if (re.test(text)) return scope;
  return "used";
}

/* --------------------------------------------------------------- qualifiers */

const QUALIFIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["leadership", /\b(team lead|tech(nical)? lead|lead engineer|engineering manager|managed (a |the )?team|leadership)\b/i],
  ["team size", /\b(team of|teams of \w+|\d+[- ]person|\w+[- ]person team|direct reports?|headcount)\b/i],
  ["org-wide reach", /\b(company[- ]wide|org(anization)?[- ]wide|cross[- ]functional|across (the )?(company|org(anization)?)|global(ly)?|all teams)\b/i],
  ["scale", /\b(at scale|large[- ]scale|-scale|high[- ]traffic|enterprise|millions?|billions?|petabytes?|terabytes?|high[- ]availability|mission[- ]critical)\b/i],
  ["open source", /\b(open[- ]source|oss|maintainer|upstream|pull requests?)\b/i],
  ["migration", /\b(migrat(e|ed|ing|ion)|re-?platform(ed|ing)?|moderniz(ed|ing|ation)|legacy)\b/i],
  ["public speaking", /\b(spoke|speaker|keynote|conference|presented at|published|talks?)\b/i],
  ["seniority title", /\b(staff|principal|senior staff|distinguished|architect|director|vp|vice president|head of|cto|chief)\b/i],
  ["revenue impact", /\b(revenue|profit|arr|mrr|sales|conversion(s| rate)?|cost savings?|saved \$?)\b/i],
  ["award", /\b(award(ed)?|patent(ed|s)?|recogni[sz]ed|promoted)\b/i],
];

export function qualifiersOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const [name, re] of QUALIFIERS) if (re.test(text)) out.add(name);
  return out;
}

/* -------------------------------------------------------------------- names */

const COMMON_CAPS = new Set([
  "I", "I'm", "I've", "I'd", "I'll", "My", "The", "A", "An", "This", "That", "These", "Those", "We", "Our", "You",
  "Your", "It", "In", "On", "At", "For", "With", "And", "But", "Or", "As", "By", "From", "To", "Of", "Dear",
  "Hiring", "Manager", "Team", "Thank", "Thanks", "Best", "Regards", "Sincerely", "Hi", "Hello", "Yes", "No",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

/**
 * Ordinary words a sentence may open with. A capitalized word at a sentence
 * start is still a name unless it is one of these, a verb or adverb form, or a
 * scope verb: "Google partners used..." names Google.
 */
const OPENERS = new Set([
  "about", "across", "after", "again", "all", "also", "although", "an", "another", "any", "are", "as", "at", "because",
  "before", "being", "beyond", "both", "building", "during", "each", "earlier", "early", "either", "even", "every",
  "first", "following", "for", "here", "how", "if", "into", "is", "it's", "its", "just", "last", "later", "lately",
  "like", "many", "more", "most", "much", "my", "next", "not", "now", "once", "one", "only", "other", "outside",
  "over", "part", "previously", "prior", "recently", "rather", "second", "since", "so", "some", "still", "such",
  "than", "that's", "their", "then", "there", "there's", "they", "through", "throughout", "today", "together",
  "under", "until", "what", "when", "where", "whether", "which", "while", "who", "why", "within", "without",
  "working", "would", "yet",
]);

function isOpener(word: string): boolean {
  const w = word.toLowerCase();
  if (OPENERS.has(w) || COMMON_CAPS.has(word)) return true;
  if (/^[a-z]+(ed|ing|ly)$/.test(w)) return true;
  return PAST_ACHIEVEMENT.test(w) || SCOPE_PATTERNS.some(([, re]) => re.test(w));
}

/** Names of things: capitalized words (sentence openers excepted), and inner-capital brands like eBay. */
export function extractNames(text: string): Set<string> {
  const out = new Set<string>();
  const starts = sentenceStarts(text);
  for (const m of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) out.add(m[0].toLowerCase());
  const re = /\b[A-Z][a-zA-Z0-9&'-]+\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (starts.has(m.index) && isOpener(m[0].split("-")[0]!.replace(/'s$/, ""))) continue;
    // "Python-backed" names Python; the lowercase tail names nothing. Each
    // capitalized part of a compound is a name ("Node-RED" -> node, red).
    for (const part of m[0].replace(/'s$/, "").split("-")) {
      if (!/^[A-Z]/.test(part) || COMMON_CAPS.has(part)) continue;
      out.add(part.toLowerCase());
    }
  }
  return out;
}

/* ------------------------------------------------------------- verification */

interface Features {
  numbers: Set<string>;
  tech: Set<string>;
  scope: number;
  qualifiers: Set<string>;
  names: Set<string>;
  words: Set<string>;
}

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean).map((w) => w.replace(/\.$/, "")));
}

function features(text: string, skills: readonly Skill[]): Features {
  return {
    numbers: extractNumbers(text),
    tech: extractTechnology(text, skills),
    scope: SCOPE_RANK[scopeOf(text)],
    qualifiers: qualifiersOf(text),
    // A technology is checked as a technology; its words are not also names.
    names: extractNames(withoutTechnology(text, skills)),
    words: wordsOf(text),
  };
}

/** True when `name` occurs (as a word or a word sequence) in the allowed text. */
function nameAllowed(name: string, allowed: Set<string>): boolean {
  return allowed.has(name) || allowed.has(name.replace(/[-']/g, ""));
}

/**
 * Generic category words a skill-group heading may use. A heading is Title
 * Case, so capitalization says nothing about names there. Deliberately absent:
 * anything that is a qualifier (leadership, enterprise, scale), a technology
 * (AI, ML, DevOps) or a domain claim; those must come from the group's skills.
 */
const HEADING_WORDS = [
  "languages", "language", "apis", "api", "application", "applications", "development", "cloud", "delivery", "data",
  "integration", "integrations", "automation", "engineering", "practice", "practices", "frontend", "front-end",
  "backend", "back-end", "infrastructure", "tools", "tooling", "platforms", "platform", "testing", "quality",
  "databases", "database", "frameworks", "framework", "libraries", "web", "mobile", "operations", "observability",
  "security", "analytics", "design", "systems", "methods", "process", "processes", "product", "collaboration",
  "communication", "core", "other", "additional", "technical", "skills", "technologies", "programming", "storage",
  "messaging", "protocols", "hardware", "embedded", "devices", "services", "full-stack", "fullstack", "stack",
  "and", "&",
];

/**
 * Verify a skill-group heading. Model-written text on the page, so it may not
 * assert anything: technologies must be in the group it heads, and anything
 * beyond the generic category words is checked as a name or qualifier.
 */
export function verifyHeading(label: string, groupSkills: readonly string[], ctx: VerifyContext): Problem[] {
  return verifySegment(label, [], { ...ctx, context: [...ctx.context, ...groupSkills, HEADING_WORDS.join(" ")] });
}

/**
 * Verify one sentence (or bullet) that cites `cites`.
 *
 * `expectedOwner` pins every citation to one role/project: a resume bullet
 * rendered under employer A may not cite employer B's claim.
 */
export function verifySegment(
  text: string,
  cites: readonly string[],
  ctx: VerifyContext,
  opts: { expectedOwner?: string } = {},
): Problem[] {
  const problems: Problem[] = [];
  const sources: IndexedClaim[] = [];
  for (const id of cites) {
    const c = ctx.claims.get(id);
    if (!c) problems.push({ kind: "unknown_claim", detail: `cites "${id}", which is not in the evidence ledger` });
    else if (!c.claim.verified) problems.push({ kind: "unverified_claim", detail: `cites "${id}", which is marked verified: false` });
    else if (opts.expectedOwner && c.ownerId !== opts.expectedOwner) {
      problems.push({ kind: "wrong_owner", detail: `"${id}" belongs to ${c.ownerLabel}, not ${opts.expectedOwner}` });
    } else sources.push(c);
  }

  const contextText = ctx.context.join(" ");
  const ctxFeatures = features(contextText, ctx.skills);
  const t = features(text, ctx.skills);

  if (sources.length === 0) {
    // Uncited text may describe the target and the act of applying. It may
    // not assert anything about the candidate. Anything first-person must be
    // framed as interest or intent, and carry no experience marker: the
    // feature checks below are a deny-list, and "I hold a doctorate" contains
    // nothing they look for.
    const asserted: string[] = [];
    if (FIRST_PERSON.test(text) && (!INTENT_FRAME.test(text) || EXPERIENCE_CLAIM.test(text))) {
      asserted.push("something about the candidate (uncited first-person text may only express interest or intent)");
    }
    for (const n of t.numbers) if (!ctxFeatures.numbers.has(n)) asserted.push(`figure "${n}"`);
    for (const x of t.tech) if (!ctxFeatures.tech.has(x)) asserted.push(`technology "${x}"`);
    const past = PAST_ACHIEVEMENT.exec(text);
    if (past) asserted.push(`an accomplishment ("${past[0]}")`);
    for (const q of t.qualifiers) if (!ctxFeatures.qualifiers.has(q)) asserted.push(q);
    const allowedNames = new Set([...ctxFeatures.names, ...wordsOf(contextText)]);
    for (const n of t.names) {
      if (t.tech.has(canon(n))) continue;
      if (!nameAllowed(n, allowedNames)) asserted.push(`name "${n}"`);
    }
    if (asserted.length) {
      problems.push({ kind: "uncited_assertion", detail: `asserts ${asserted.join(", ")} without citing evidence` });
    }
    return problems;
  }

  // The target context may be NAMED in a cited sentence ("...work I'd bring to
  // Initech"), but it is not evidence: a posting titled "Kubernetes Platform"
  // licenses no Kubernetes claim, "Staff" no seniority, "Enterprise" no scale.
  const evidenceText = [...sources.map((s) => s.claim.text), ...sources.map((s) => s.ownerLabel)].join("\n");
  const ev = features(evidenceText, ctx.skills);
  const taggedSkills = new Set<string>();
  for (const s of sources) for (const sk of s.claim.skills) taggedSkills.add(canon(sk));
  const strongestScope = Math.max(
    ...sources.map((s) => (s.claim.scope ? SCOPE_RANK[s.claim.scope] : SCOPE_RANK[scopeOf(s.claim.text)])),
  );

  for (const n of t.numbers) {
    if (!ev.numbers.has(n)) problems.push({ kind: "novel_number", detail: `introduces the figure "${n}"` });
  }
  for (const x of t.tech) {
    if (!ev.tech.has(x) && !taggedSkills.has(x)) {
      problems.push({ kind: "novel_technology", detail: `introduces "${x}", which the cited evidence does not mention` });
    }
  }
  if (t.scope > strongestScope) {
    problems.push({ kind: "scope_inflation", detail: `claims "${scopeOf(text)}" scope; the evidence supports less` });
  }
  for (const q of t.qualifiers) {
    if (!ev.qualifiers.has(q)) problems.push({ kind: "novel_qualifier", detail: `adds a ${q} claim the evidence does not make` });
  }
  const allowedNames = new Set([...ev.names, ...ev.words, ...ctxFeatures.names, ...wordsOf(contextText)]);
  for (const n of t.names) {
    if (t.tech.has(canon(n))) continue; // already judged as technology above
    if (!nameAllowed(n, allowedNames)) problems.push({ kind: "novel_name", detail: `names "${n}", which the evidence does not` });
  }
  return problems;
}

export function describeProblems(problems: readonly Problem[]): string {
  return problems.map((p) => `[${p.kind}] ${p.detail}`).join("; ");
}
