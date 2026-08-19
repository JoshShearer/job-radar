/**
 * Location and remote-status classification.
 *
 * The decision this feeds is binary and expensive to get wrong: a role that is
 * actually onsite in New York wastes an application, and a remote role
 * misclassified as onsite silently disappears from the slate. So the
 * classifier is conservative: it only calls something REMOTE on an explicit
 * remote signal, and it treats "remote (US)" and "remote - anywhere" alike.
 */

export type RemoteStatus = "remote" | "hybrid" | "onsite" | "unknown";

export interface LocationVerdict {
  remoteStatus: RemoteStatus;
  /** Cleaned, human-readable location string. */
  location: string;
  /** True if this location is acceptable given the profile. */
  acceptable: boolean;
  /** Why it was accepted or rejected - shown in reports. */
  reason: string;
  /** Set when the posting restricts to a country/region we cannot satisfy. */
  geoBlocked: boolean;
}

export interface LocationPrefs {
  homeMetro: string;
  remoteOk: boolean;
  hybridMetros: string[];
  onsiteOkMetros: string[];
  relocationOk: boolean;
}

const REMOTE_RE =
  /\b(fully remote|100% remote|remote-first|remote first|work from home|wfh|distributed team|anywhere in the (us|u\.s\.|united states)|remote \(|remote,|remote -|remote –|^remote$|\bremote\b)/i;
const HYBRID_RE = /\b(hybrid|in[- ]office \d+|(\d+) days? (a week )?in[- ]?(the )?office|flexible onsite)\b/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]?person|in[- ]?office only|must be (located|based) in|relocation required)\b/i;

/**
 * Countries and regions that make a "remote" role unusable for someone who
 * can only work in the US.
 *
 * Matching is on the region name alone, NOT on a phrase like "canada only".
 * Boards overwhelmingly write "Remote - Canada", never "Remote - Canada only",
 * so requiring the qualifier lets every non-US remote role through the filter.
 */
const NON_US_REGION_RE =
  /\b(uk|united kingdom|england|scotland|ireland|emea|europe|european union|eu|apac|latam|india|canada|australia|new zealand|germany|france|netherlands|poland|spain|portugal|italy|sweden|switzerland|brazil|mexico|colombia|argentina|philippines|nigeria|kenya|south africa|singapore|japan|china|israel|uae|dubai)\b/i;

/**
 * US-inclusive scope. A posting naming both the US and another region is
 * fine - "Remote (US, Canada)" is workable, "Remote (Canada)" is not.
 * Global/worldwide postings count as US-inclusive.
 */
const US_SCOPE_RE =
  /\b(us|u\.s\.|u\.s|usa|united states|north america|americas|nam|worldwide|anywhere|global|remote global)\b/i;

/**
 * Locations that name a country, a continent, or nothing narrower.
 *
 * Anchored on purpose: this must match a location that is ONLY scope, never
 * one that also names a city. "United States" matches; "Austin, United States"
 * does not, and stays onsite.
 *
 * Non-US countries are deliberately absent. "Germany" with no other signal is
 * still best read as onsite in Germany, and reading it as unknown would make it
 * acceptable to someone who cannot work there.
 */
const SCOPE_WORDS =
  "united states|usa|u\\.s\\.a\\.?|u\\.s\\.?|us|north america|americas|nam|nationwide|" +
  "global|worldwide|anywhere|multiple locations|various locations|remote";
const SCOPE_ONLY_RE = new RegExp(`^(?:${SCOPE_WORDS})(?:\\s*[,/&()-]+\\s*(?:${SCOPE_WORDS}))*$`, "i");

/** Normalize whitespace/punctuation in a raw location string. */
export function cleanLocation(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s*[;|]\s*/g, ", ")
    .replace(/^[,\s-]+|[,\s-]+$/g, "")
    .trim();
}

function matchesMetro(location: string, metros: string[]): boolean {
  const loc = location.toLowerCase();
  return metros.some((m) => m.trim() && loc.includes(m.toLowerCase().trim()));
}

/**
 * Classify remote status from the location string plus supporting hints
 * (workplace type field, description text).
 */
export function classifyRemote(
  location: string,
  hints: { workplaceType?: string | null; isRemote?: boolean | null; description?: string | null } = {},
): RemoteStatus {
  const loc = location.toLowerCase();
  const wp = (hints.workplaceType ?? "").toLowerCase();

  // Explicit ATS fields win - they are structured data, not prose.
  if (wp.includes("hybrid")) return "hybrid";
  if (wp.includes("remote")) return "remote";
  if (wp.includes("onsite") || wp.includes("on-site") || wp.includes("in office")) return "onsite";

  if (HYBRID_RE.test(loc)) return "hybrid";
  if (REMOTE_RE.test(loc)) return "remote";
  if (hints.isRemote === true) return "remote";

  // Fall back to the description, but only the first slice: a remote mention
  // deep in a benefits section is not a statement about this role.
  const head = (hints.description ?? "").slice(0, 1500);
  if (HYBRID_RE.test(head)) return "hybrid";
  if (REMOTE_RE.test(head)) return "remote";
  if (ONSITE_RE.test(head)) return "onsite";

  // A COUNTRY IS NOT A WORKSITE.
  //
  // This used to fall straight through to "onsite" for any non-empty string,
  // so a posting whose only stated location was "United States" was called
  // onsite and then rejected for not being Austin. Measured on the real index:
  // 149 postings discarded that way, the third-largest rejection reason behind
  // two genuine ones.
  //
  // "Unknown" is the honest answer, not a lenient one: the posting has not said
  // where the work happens, and `assessLocation` already treats that as
  // "acceptable, needs a human check" rather than as permission. A named city
  // still means onsite, so an onsite role in the wrong city is still rejected.
  if (SCOPE_ONLY_RE.test(loc.trim())) return "unknown";

  if (loc.trim().length > 0) return "onsite";
  return "unknown";
}

/**
 * Decide whether a location is workable given the profile. Returns a verdict
 * rather than a boolean so the reason can be surfaced in the report.
 */
export function assessLocation(
  rawLocation: string | null | undefined,
  prefs: LocationPrefs,
  hints: { workplaceType?: string | null; isRemote?: boolean | null; description?: string | null } = {},
): LocationVerdict {
  // Classify from the cleaned RAW value, before substituting the display
  // placeholder. Passing "Unspecified" into the classifier makes the
  // non-empty-string fallback fire and silently reports every location-less
  // posting as onsite, which then rejects it.
  const cleaned = cleanLocation(rawLocation);
  const remoteStatus = classifyRemote(cleaned, hints);
  const location = cleaned || "Unspecified";
  const loc = cleaned.toLowerCase();

  // A remote role scoped to a region we cannot work in is a hard no.
  // Only applies to remote/unknown postings: an onsite role in Berlin is
  // already rejected by the metro check, with a clearer reason.
  const geoBlocked =
    remoteStatus !== "onsite" && NON_US_REGION_RE.test(loc) && !US_SCOPE_RE.test(loc);
  if (geoBlocked) {
    return {
      remoteStatus,
      location,
      acceptable: false,
      reason: `Remote but scoped to a region outside the US (${location}).`,
      geoBlocked: true,
    };
  }

  if (remoteStatus === "remote") {
    return prefs.remoteOk
      ? { remoteStatus, location, acceptable: true, reason: "Fully remote.", geoBlocked: false }
      : {
          remoteStatus,
          location,
          acceptable: false,
          reason: "Remote roles disabled in profile.",
          geoBlocked: false,
        };
  }

  if (remoteStatus === "hybrid") {
    const ok = matchesMetro(location, prefs.hybridMetros);
    return {
      remoteStatus,
      location,
      acceptable: ok,
      reason: ok
        ? `Hybrid in an acceptable metro (${location}).`
        : `Hybrid outside acceptable metros (${location}); relocation is off.`,
      geoBlocked: false,
    };
  }

  if (remoteStatus === "onsite") {
    const ok = matchesMetro(location, prefs.onsiteOkMetros) || prefs.relocationOk;
    return {
      remoteStatus,
      location,
      acceptable: ok,
      reason: ok
        ? `Onsite in an acceptable metro (${location}).`
        : `Onsite outside ${prefs.homeMetro} (${location}); relocation is off.`,
      geoBlocked: false,
    };
  }

  // Unknown: do not reject. An unlabeled location is common on small boards,
  // and rejecting on absence of data throws away good roles.
  return {
    remoteStatus,
    location,
    acceptable: true,
    reason: "Location not stated; needs a human check before applying.",
    geoBlocked: false,
  };
}

/** Detect work-authorization blockers stated in the description. */
export function findAuthBlockers(text: string, blockers: string[]): string[] {
  const lower = text.toLowerCase();
  return blockers.filter((b) => b.trim() && lower.includes(b.toLowerCase().trim()));
}
