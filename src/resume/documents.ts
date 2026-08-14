/**
 * Naming and layout for the documents that actually get attached to an
 * application.
 *
 * Five applications went out with every attachment called `resume.pdf`. The
 * tailoring behind them was real - different headline, summary, skill grouping
 * and bullet order per posting - but none of that is visible in an attachment
 * list, and a recruiter reading `resume.pdf` sees a mass application. The
 * candidate could not tell their own documents apart either without opening
 * them.
 *
 * The name is DERIVED, never stored. The command that writes the file and the
 * command that later looks for it compute the same string from the same two
 * inputs, so there is no mapping file to drift out of sync.
 *
 * Nothing in this module writes prose about the candidate. `prepareApplication`
 * does that, under the prompt that forbids inventing experience; here the text
 * is laid out and escaped, and that is all. A renderer that "improved" the
 * wording would be making a claim nobody checked.
 */

/** Filesystem-safe, ASCII-ish, no separators, no traversal, bounded length. */
function slug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

const MAX_BASE = 120;

/**
 * `Josh_A_Shearer_Resume_Vanta`. `kind` is "Resume" or "Cover_Letter".
 *
 * A company that slugs away to nothing (empty, or punctuation only) drops out
 * rather than leaving a dangling separator - the name is still valid, just less
 * specific.
 */
export function documentBase(personName: string, company: string, kind: string): string {
  const parts = [slug(personName), slug(kind), slug(company)].filter(Boolean);
  return parts.join("_").slice(0, MAX_BASE).replace(/_+$/, "");
}

export function resumeName(personName: string, company: string, ext = "pdf"): string {
  return `${documentBase(personName, company, "Resume")}.${ext}`;
}

export function coverLetterName(personName: string, company: string, ext = "pdf"): string {
  return `${documentBase(personName, company, "Cover_Letter")}.${ext}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Paragraphs, as the author wrote them. Blank lines separate; nothing is reflowed. */
function paragraphs(note: string): string[] {
  return note
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function renderCoverLetterMarkdown(
  personName: string,
  company: string,
  title: string,
  note: string,
  contact: string[],
): string {
  const L: string[] = [];
  L.push(`# ${personName}`);
  if (contact.length) {
    L.push("");
    L.push(contact.join(" | "));
  }
  L.push("");
  L.push(`**${title} - ${company}**`);
  L.push("");
  L.push("---");
  L.push("");
  L.push(paragraphs(note).join("\n\n"));
  return L.join("\n");
}

export function renderCoverLetterHtml(
  personName: string,
  company: string,
  title: string,
  note: string,
  contact: string[],
): string {
  const parts: string[] = [];
  parts.push(`<h1>${esc(personName)}</h1>`);
  if (contact.length) {
    parts.push(`<p class="contact">${contact.map(esc).join(" &middot; ")}</p>`);
  }
  parts.push(`<p class="role">${esc(title)} &mdash; ${esc(company)}</p>`);
  for (const p of paragraphs(note)) parts.push(`<p>${esc(p)}</p>`);

  // Same visual language as the resume: one column, print-friendly, no assets.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(personName)} - ${esc(company)}</title>
<style>
  @page { margin: 0.75in; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 11pt; line-height: 1.5;
         color: #111; max-width: 7in; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 4px; font-family: Helvetica, Arial, sans-serif; }
  .contact { margin: 0 0 14px; font-size: 9.5pt; color: #444; font-family: Helvetica, Arial, sans-serif; }
  .role { font-weight: bold; margin: 0 0 18px; font-family: Helvetica, Arial, sans-serif; }
  p { margin: 0 0 11px; }
</style></head><body>
${parts.join("\n")}
</body></html>`;
}
