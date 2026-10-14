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
  /**
   * The posting names a work arrangement but no place, so the location is
   * unknown rather than wrong. Accepted, and surfaced for a human to check.
   */
  needsLocationReview: boolean;
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

/**
 * Locations that name a WORK ARRANGEMENT and no place at all.
 *
 * 213 postings on the live index have a location field reading exactly
 * "Hybrid". That classifies as hybrid, fails the metro match, and is rejected
 * as "Hybrid outside acceptable metros (Hybrid)" - a sentence that treats the
 * absence of a city as evidence of the wrong city. Some of those are very
 * likely Austin or remote.
 *
 * This is the same defect as the country-scope fix directly above, and the
 * same shape of remedy. It is also a violation of the rule filters.ts states
 * in its own header: reject on evidence, never on absence of evidence. The
 * project already applies exactly this reasoning to personal.yaml, where an
 * unset value is unknown and never a default; inbound data had not been given
 * the same treatment.
 *
 * Anchored, so only a string that is ENTIRELY arrangement vocabulary matches.
 * "Hybrid" does; "Hybrid - San Francisco" and "San Francisco, US (Hybrid)"
 * both name a place and are still judged on it.
 */
// Longest-first, so "flexible" is consumed before "flex" could leave "ible"
// behind and make a placeless value look like it named somewhere.
const ARRANGEMENT_WORDS = [
  "work from home",
  "fully remote",
  "telecommute",
  "in[- ]?person",
  "in[- ]?office",
  "on[- ]?site",
  "distributed",
  "flexible",
  "full[- ]?time",
  "part[- ]?time",
  "contract",
  "permanent",
  "optional",
  "anywhere",
  "hybrid",
  "remote",
  "onsite",
  "flex",
  "wfh",
].join("|");
const ARRANGEMENT_RE = new RegExp(`\\b(?:${ARRANGEMENT_WORDS})\\b`, "gi");

/**
 * Does this location string name a place, or only how the work is arranged?
 *
 * Implemented by subtraction rather than by matching the whole string: remove
 * every arrangement word, discard punctuation and spacing, and see whether any
 * letters or digits survive. An anchored whole-string pattern looks tidier and
 * is wrong in practice - "On-site (Full-time)" has a trailing bracket that no
 * reasonable separator class covers, and location fields are full of that.
 *
 * Empty counts as naming no place, but that case never reaches the metro
 * checks: `classifyRemote` returns "unknown" for it and the unknown branch
 * already accepts.
 */
export function statesAPlace(cleanedLocation: string): boolean {
  const text = cleanedLocation.trim();
  if (!text) return false;
  const residue = text.replace(ARRANGEMENT_RE, " ").replace(/[^a-z0-9]+/gi, "");
  return residue.length > 0;
}


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
  if (wp.includes("onsite") || wp.includes("on-site") || wp.includes("on_site") || wp.includes("in office")) return "onsite";

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
      needsLocationReview: false,
    };
  }

  if (remoteStatus === "remote") {
    return prefs.remoteOk
      ? { remoteStatus, location, acceptable: true, reason: "Fully remote.", geoBlocked: false, needsLocationReview: false }
      : {
          remoteStatus,
          location,
          acceptable: false,
          reason: "Remote roles disabled in profile.",
          geoBlocked: false,
          needsLocationReview: false,
        };
  }

  // A value that names an arrangement and no place cannot be judged against a
  // metro list. Rejecting it reads the absence of a city as evidence of the
  // wrong city - see ARRANGEMENT_ONLY_RE. Accept and flag for review instead.
  const placeless = !statesAPlace(cleaned);

  if (remoteStatus === "hybrid") {
    if (placeless) {
      return {
        remoteStatus,
        location,
        acceptable: true,
        reason: `Location unknown - review. The posting says "${location}" and names no place.`,
        geoBlocked: false,
        needsLocationReview: true,
      };
    }
    const ok = matchesMetro(location, prefs.hybridMetros);
    return {
      remoteStatus,
      location,
      acceptable: ok,
      reason: ok
        ? `Hybrid in an acceptable metro (${location}).`
        : `Hybrid outside acceptable metros (${location}); relocation is off.`,
      geoBlocked: false,
      needsLocationReview: false,
    };
  }

  if (remoteStatus === "onsite") {
    if (placeless) {
      return {
        remoteStatus,
        location,
        acceptable: true,
        reason: `Location unknown - review. The posting says "${location}" and names no place.`,
        geoBlocked: false,
        needsLocationReview: true,
      };
    }
    const ok = matchesMetro(location, prefs.onsiteOkMetros) || prefs.relocationOk;
    return {
      remoteStatus,
      location,
      acceptable: ok,
      reason: ok
        ? `Onsite in an acceptable metro (${location}).`
        : `Onsite outside ${prefs.homeMetro} (${location}); relocation is off.`,
      geoBlocked: false,
      needsLocationReview: false,
    };
  }

  // Unknown: do not reject. An unlabeled location is common on small boards,
  // and rejecting on absence of data throws away good roles.
  return {
    remoteStatus,
    location,
    acceptable: true,
    reason: "Location unknown - review. The posting states no location at all.",
    geoBlocked: false,
    needsLocationReview: true,
  };
}

/** Detect work-authorization blockers stated in the description. */
export function findAuthBlockers(text: string, blockers: string[]): string[] {
  const lower = text.toLowerCase();
  return blockers.filter((b) => b.trim() && lower.includes(b.toLowerCase().trim()));
}
