import { normalizeForIdentity } from "../text/identity.js";
import { senderDomain } from "./classify.js";

/**
 * Which application does this email belong to?
 *
 * The rule the issue states and this file exists to enforce: two applications
 * at the same company must not be guessed between. A rejection from Samsara
 * when you have applied to three Samsara roles identifies a COMPANY, not a
 * job, and picking the most recent one would silently close two live
 * applications.
 *
 * So this returns one of three things and never a best guess.
 */

export interface Candidate {
  /** Application id. */
  id: string;
  company: string;
  title: string;
  state: string;
  /** When the application was submitted; an email cannot predate it by much. */
  submittedAt: string | null;
}

export type MatchResult =
  | { kind: "matched"; job: Candidate; why: string }
  | { kind: "ambiguous"; jobs: Candidate[]; why: string }
  | { kind: "unmatched"; why: string };

/** Tokens too generic to identify a company on their own. */
const STOPWORDS = new Set([
  "the", "and", "inc", "llc", "ltd", "corp", "co", "company", "team", "hq",
  "labs", "group", "technologies", "technology", "software", "systems", "io",
  "ai", "app", "apps", "careers", "jobs", "hiring", "recruiting", "talent",
  "no", "reply", "noreply", "notifications", "mail",
]);

function tokens(s: string): string[] {
  return normalizeForIdentity(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Does this email plausibly concern this company?
 *
 * Two independent routes, because ATS mail splits into two shapes: the company
 * name appears in the subject or body ("Your application to Vanta"), or it does
 * not and only the sending domain carries it (recruiter@vanta.com).
 */
export function mentionsCompany(company: string, email: { from: string; subject: string; body: string }): boolean {
  const companyTokens = tokens(company);
  if (companyTokens.length === 0) return false;

  const haystack = `${email.subject}\n${email.body}`.toLowerCase();
  // Every distinctive token must appear. "Clear Street" must not match an
  // email that merely says "street".
  if (companyTokens.every((t) => haystack.includes(t))) return true;

  const domain = senderDomain(email.from);
  const domainTokens = tokens(domain.replace(/\.[a-z.]+$/i, ""));
  return companyTokens.length > 0 && companyTokens.every((t) => domainTokens.includes(t));
}

/**
 * Pick the application an email refers to.
 *
 * `receivedAt` gates on time: an email that predates the application cannot be
 * about it. That single check removes most of the ambiguity from a repeat
 * applicant, without ever choosing between two equally plausible jobs.
 */
export function matchEmailToJob(
  email: { from: string; subject: string; body: string; receivedAt: string },
  candidates: readonly Candidate[],
): MatchResult {
  const plausible = candidates.filter((c) => mentionsCompany(c.company, email));
  if (plausible.length === 0) {
    return { kind: "unmatched", why: "no open application matches this sender or company" };
  }

  const received = Date.parse(email.receivedAt);
  const afterApplying = plausible.filter((c) => {
    if (!c.submittedAt) return true;
    const applied = Date.parse(c.submittedAt);
    if (Number.isNaN(applied) || Number.isNaN(received)) return true;
    // A day of slack: ATS confirmations often carry a timestamp slightly before
    // the local status write, and clock skew should not drop a real match.
    return received >= applied - 86_400_000;
  });

  const pool = afterApplying.length > 0 ? afterApplying : plausible;
  if (pool.length === 1) {
    return { kind: "matched", job: pool[0]!, why: `only in-flight application at ${pool[0]!.company}` };
  }

  // The title is the last honest discriminator. It is only used when it
  // identifies exactly one job - a title that matches two is still ambiguous.
  const haystack = `${email.subject}\n${email.body}`.toLowerCase();
  const byTitle = pool.filter((c) => {
    const t = tokens(c.title);
    return t.length > 0 && t.every((tok) => haystack.includes(tok));
  });
  if (byTitle.length === 1) {
    return { kind: "matched", job: byTitle[0]!, why: `title named in the email` };
  }

  return {
    kind: "ambiguous",
    jobs: pool,
    why: `${pool.length} in-flight applications at ${pool[0]!.company} and the email does not say which`,
  };
}
