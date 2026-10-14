/**
 * Text normalization shared by form-field matching and resume matching.
 *
 * Two different normalizations, deliberately:
 *
 * - `normalizeText` keeps `. + #` so "Node.js", "C++" and "C#" survive as
 *   distinct tokens. Used where the literal wording matters.
 * - `canonicalSkill` goes further and strips the punctuation entirely, so
 *   "Next.js", "NextJS" and "next js" all collapse to "nextjs". Used when
 *   deciding whether a job's requirement names a skill the candidate has,
 *   where a posting's spelling must not change the answer.
 */

export function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalSkill(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Regex-safe escape for building word-boundary matchers from data. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-token containment on canonical text. `+` and `#` are not word
 * characters, so `\b` fails on "c++"; those get an explicit boundary check.
 */
export function containsSkill(haystackCanonical: string, skillCanonical: string): boolean {
  if (!skillCanonical) return false;
  const esc = escapeRegex(skillCanonical);
  const endsInSymbol = /[+#]$/.test(skillCanonical);
  const pattern = endsInSymbol ? `(?<![a-z0-9])${esc}(?![a-z0-9+#])` : `\\b${esc}\\b`;
  return new RegExp(pattern).test(haystackCanonical);
}

/** Numbers that look like claims: 200+, 35, 12%, $1.2M, 3x. */
export function extractNumericClaims(text: string): string[] {
  const out = new Set<string>();
  const re = /\$?\d[\d,.]*\s?(?:%|k|m|b|x|\+)?/gi;
    let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim().toLowerCase().replace(/,/g, "");
    // Bare years and tiny ordinals are not metric claims worth policing.
    if (/^(19|20)\d{2}$/.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}
