/**
 * HTML -> plain text. Job descriptions arrive as HTML (sometimes
 * double-escaped, as Greenhouse does), and every downstream stage - keyword
 * scoring, salary parsing, LLM analysis - wants readable text.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
  bull: "*",
  middot: "*",
  eacute: "e",
  reg: "(R)",
  copy: "(c)",
  trade: "(TM)",
  deg: " degrees ",
};

/** Decode HTML entities once. Handles named, decimal, and hex references. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Decode repeatedly until stable (max 3 passes). Greenhouse serves content
 * that is entity-escaped twice: `&amp;lt;p&amp;gt;` really means `<p>`.
 */
export function decodeEntitiesDeep(input: string, maxPasses = 3): string {
  let out = input;
  for (let i = 0; i < maxPasses; i++) {
    const next = decodeEntities(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Strip HTML tags to readable plain text, preserving block structure. */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  let s = decodeEntitiesDeep(input);

  // Drop non-content elements entirely, including their inner text.
  s = s.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // Turn list items into bullets and block ends into newlines before stripping.
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|li|tr|section|article)>/gi, "\n");
  s = s.replace(/<(p|div|h[1-6]|ul|ol|tr|section|article)\b[^>]*>/gi, "\n");

  // Remove all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");

  // A second decode pass: entities can be revealed by tag removal.
  s = decodeEntities(s);

  // Normalize whitespace without destroying paragraph breaks.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

/** Collapse to a single lowercase line - the form keyword matching wants. */
export function searchable(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Truncate to a token-ish budget without cutting mid-word. */
export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf(" ");
  return `${(lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n[...truncated]`;
}
