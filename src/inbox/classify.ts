/**
 * What is this email telling us about an application?
 *
 * DETERMINISTIC, and that is a rule rather than a convenience. Reading a
 * rejection is parsing, not judgement, and the project's determinism boundary
 * puts parsing firmly on this side: it has to be reproducible, free to run over
 * a whole mailbox on every pass, and auditable when a status change looks
 * wrong. A model deciding that a job had been rejected would be unreviewable
 * and would cost money per email.
 *
 * The output is a SET of kinds, not a single verdict. An email matching two
 * kinds is not resolved by precedence here - it is handed to the caller as
 * ambiguous, and ambiguity goes to a review list rather than to a status
 * change. Guessing between "we are moving forward with other candidates" and
 * "we would like to schedule a call" is exactly the guess that must not be
 * made automatically.
 */

export type EmailKind = "confirmation" | "rejection" | "interview" | "offer";

export interface EmailInput {
  from: string;
  subject: string;
  body: string;
}

export interface Classification {
  /** Every kind whose evidence appeared. More than one means ambiguous. */
  kinds: EmailKind[];
  /** The phrases that matched, so a status change can explain itself. */
  evidence: string[];
}

/**
 * Phrases, not keywords.
 *
 * "unfortunately" alone is not a rejection - it appears in scheduling mail
 * ("unfortunately I have to move our call"). Every pattern here is a phrase
 * that carries the meaning on its own, because a false REJECTED closes a live
 * application in the tracker and a person may never look at it again.
 */
const PATTERNS: ReadonlyArray<readonly [EmailKind, RegExp]> = [
  // --- rejection -----------------------------------------------------------
  ["rejection", /\bmov(?:e|ing) forward with other candidates\b/i],
  ["rejection", /\b(?:will not|won't|are not|aren't) (?:be )?mov(?:e|ing) forward\b/i],
  ["rejection", /\bdecided not to (?:move forward|proceed|continue)\b/i],
  ["rejection", /\bnot to proceed with your application\b/i],
  ["rejection", /\bno longer under consideration\b/i],
  ["rejection", /\bpursu(?:e|ing) other candidates\b/i],
  ["rejection", /\bnot select(?:ed)? (?:you )?(?:to )?(?:move|proceed|advance)\b/i],
  ["rejection", /\bwe have filled (?:the|this) (?:role|position)\b/i],
  ["rejection", /\bdecided to move (?:ahead|forward) with (?:another|other)\b/i],

  // --- interview -----------------------------------------------------------
  ["interview", /\b(?:schedule|set ?up|book) (?:a |an )?(?:time|call|chat|interview|conversation)\b/i],
  ["interview", /\binvit(?:e|ing|ation) (?:you )?to (?:an? )?(?:interview|conversation|call)\b/i],
  ["interview", /\bphone screen\b/i],
  ["interview", /\b(?:technical|initial|first) (?:round|interview)\b/i],
  ["interview", /\bavailability for (?:a |an )?(?:call|chat|interview)\b/i],
  ["interview", /\b(?:calendly|savvycal)\.com\b/i],
  ["interview", /\bmove(?:d)? (?:you )?(?:forward|ahead) to the next (?:round|stage|step)\b/i],

  // --- offer ---------------------------------------------------------------
  ["offer", /\bpleased to (?:extend|offer)\b/i],
  ["offer", /\boffer letter\b/i],
  ["offer", /\bextend(?:ing)? (?:you )?an offer\b/i],

  // --- confirmation --------------------------------------------------------
  // Lowest signal on purpose: a rejection almost always opens with one of
  // these, so on its own it means only "the ATS acknowledged something".
  ["confirmation", /\b(?:we|I) (?:have )?received your application\b/i],
  ["confirmation", /\bapplication (?:has been )?received\b/i],
  ["confirmation", /\bthank(?:s| you) for (?:applying|your application)\b/i],
  ["confirmation", /\bthank(?:s| you) for your interest in\b/i],
  ["confirmation", /\bsuccessfully submitted\b/i],
];

/**
 * Senders worth reading at all.
 *
 * A prefilter, not a security boundary: it keeps the scan cheap and stops an
 * unrelated newsletter that happens to say "thank you for applying" from
 * touching a job. Company-domain mail still reaches here because recruiters
 * reply from their own addresses; that is what the matcher is for.
 */
const ATS_SENDERS = [
  /@(?:.+\.)?greenhouse\.io$/i,
  /@(?:.+\.)?hire\.lever\.co$/i,
  /@(?:.+\.)?lever\.co$/i,
  /@(?:.+\.)?ashbyhq\.com$/i,
  /@(?:.+\.)?myworkday(?:jobs)?\.com$/i,
  /@(?:.+\.)?workable(?:mail)?\.com$/i,
  /@(?:.+\.)?smartrecruiters\.com$/i,
  /@(?:.+\.)?recruitee\.com$/i,
  /@(?:.+\.)?rippling\.com$/i,
  /@(?:.+\.)?jobvite\.com$/i,
  /@(?:.+\.)?icims\.com$/i,
];

export function isAtsSender(from: string): boolean {
  const addr = extractAddress(from);
  return ATS_SENDERS.some((re) => re.test(addr));
}

/** Pull `a@b.com` out of `Name <a@b.com>`. */
export function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** The domain of the sender, used to match a company when the ATS does not name one. */
export function senderDomain(from: string): string {
  const addr = extractAddress(from);
  const at = addr.lastIndexOf("@");
  return at === -1 ? "" : addr.slice(at + 1);
}

export function classifyEmail(email: EmailInput): Classification {
  // Subject and body together: ATS rejections routinely put the whole message
  // in the subject ("Your application to Acme"), and interview invites
  // routinely put nothing useful there.
  //
  // Whitespace is collapsed FIRST, and that is not cosmetic. ATS mail is
  // hard-wrapped at about 72 characters, so the phrases below land across line
  // breaks constantly - a real Samsara rejection read "decided not to\nproceed"
  // and matched nothing but the confirmation pattern. Every pattern here uses
  // literal spaces, so without this they would miss a large share of genuine
  // rejections while looking like they worked.
  const text = `${email.subject}\n${email.body}`.replace(/\s+/g, " ");
  const kinds = new Set<EmailKind>();
  const evidence: string[] = [];

  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    kinds.add(kind);
    evidence.push(m[0]);
  }

  // A confirmation alongside anything else is noise, not a second opinion.
  // Every rejection and most interview invites open by thanking you for
  // applying, so keeping it would make almost every real email "ambiguous"
  // and send the whole feature to the review list.
  if (kinds.size > 1) kinds.delete("confirmation");

  return { kinds: [...kinds], evidence };
}

/**
 * The status this email implies, or null when it implies nothing actionable.
 *
 * Returns null for an ambiguous email on purpose. The caller routes those to
 * review; there is no "best guess" branch anywhere in this file.
 */
export function statusForKinds(kinds: readonly EmailKind[]): string | null {
  if (kinds.length !== 1) return null;
  switch (kinds[0]) {
    case "rejection":
      return "REJECTED";
    case "interview":
      return "SCREEN";
    case "offer":
      return "OFFER";
    case "confirmation":
      // A confirmation is evidence the application landed, which is worth
      // recording, but it is not a step forward. `apply` already set APPLIED.
      return null;
    default:
      return null;
  }
}
