/** Direct evidence from an open page that a posting is gone. Pure. */
/**
 * Wording a board uses when the posting is gone, plus the redirect Greenhouse
 * performs. Returns the marker that matched, for the message, or null.
 *
 * Deliberately narrow. A posting that merely mentions other open roles must not
 * match, or the tool would refuse to fill live forms.
 */
const CLOSED_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bjob you are looking for is no longer open\b/i, "the board says this job is no longer open"],
  [/\bno longer (open|available|accepting applications)\b/i, "the board says this job is no longer open"],
  [/\bthis (job|position|posting|role) (has been|is) (filled|closed)\b/i, "the board says this job is filled or closed"],
  [/\bposition has been filled\b/i, "the board says this position has been filled"],
  [/\bthis posting (has )?(is )?(now )?closed\b/i, "the board says this posting is closed"],
];

export function closedPostingMarker(finalUrl: string, bodyText: string): string | null {
  // Greenhouse sends a dead posting to the board root with an error flag. The
  // page that results is a real listings page, which is exactly why this needs
  // catching: it looks like a working page and enumerates like one.
  if (/[?&]error=true\b/.test(finalUrl)) return "the board redirected to its job list with an error flag";

  for (const [re, why] of CLOSED_PHRASES) {
    if (re.test(bodyText)) return why;
  }
  return null;
}

