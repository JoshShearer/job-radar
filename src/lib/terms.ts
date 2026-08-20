/**
 * Whole-word matching for config-supplied keyword terms.
 *
 * The scorer and the filters both used `text.includes(term)`. Substring
 * matching on short technical terms is not approximately right, it is mostly
 * wrong. Measured over 1,590 filter-passing jobs on the live index:
 *
 *     term      kind        substring   whole-word   phantom
 *     rag       signal           1023           41       982
 *     rust      NEGATIVE          832           59       773
 *     scala     NEGATIVE          624           43       581
 *     express   signal            465           19       446
 *     aws       signal            540          264       276
 *     iot       signal            107           63        44
 *
 * "storage", "leverage" and "average" all contain r-a-g. "trusted by" contains
 * "rust". "scalable" contains "scala". The negative signals are the worse half:
 * 773 postings were docked points for Rust because they said "trusted".
 *
 * This inflated the fit scores that decide where analysis money is spent and
 * dragged lane assignment toward ai_product.
 *
 * ---------------------------------------------------------------------------
 *
 * WHY BOTH EDGES ARE ANCHORED, AND WHY INFLECTIONS ARE ALLOWED ANYWAY
 *
 * Anchoring only the left edge is tempting - it fixes rag, iot and aws, and it
 * never loses a suffixed form. It does not fix `scala`, because "scalable"
 * starts on the same boundary; on the live corpus it left 513 of the 624
 * phantom matches in place, and 464 of 465 for `express`. So both edges have
 * to be anchored.
 *
 * But plain `\bterm\b` then loses real signal, because job postings inflect:
 *
 *     engineer              1101 -> 681    ("engineering" dropped)
 *     api                    826 -> 195    ("APIs" dropped)
 *     agent                  552 -> 285    ("agents" dropped)
 *     large language model    32 ->   4    (the plural is the common form)
 *     a/b test                31 ->   1
 *
 * So the trailing anchor allows the term's own inflections - plural, gerund and
 * agentive -er - and nothing else. That keeps "APIs" and "engineering" while still refusing
 * "scalable" for `scala` and "ragged" for `rag`, because neither is an
 * inflection of the term. Measured, the allowance recovers those columns in
 * full and adds essentially no noise: `rag` stays at 41 either way.
 *
 * Spelling variants are NOT handled here. "nextjs", "next.js" and "postgresql"
 * are separate entries in `config/career-profile.yaml` already, which is the
 * right place for them - config over code. Adding stemming here would make the
 * scorer's behaviour depend on a rule nobody can see from the config file.
 */

/**
 * Suffixes treated as inflections of the term itself.
 *
 * `er`/`ers` earns its place: without it the hard exclusion "machine learning
 * research" stopped catching "Machine Learning Researcher", and two such
 * postings passed the filter that had always been rejected. Same for "ml
 * research" -> "ML Researcher" and "marketing lead" -> "marketing leader".
 *
 * Measured over the same 1,590-job corpus, allowing `er` changes the match
 * count of exactly four terms - those three exclusions plus "crawl" ->
 * "crawler" - and leaves every phantom term untouched: rag 41, rust 59,
 * scala 43, express 19, aws 264, iot 63, identical either way. It buys three
 * correct rejections for no new noise.
 *
 * Deliberately no `ed`: "expressed" is not an inflection of the framework
 * "express", and adding it would put 400+ postings back into that signal.
 */
const INFLECTIONS = "(?:s|es|ing|er|ers)?";

const cache = new Map<string, RegExp | null>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile (and cache) the pattern for one term.
 *
 * Returns `null` for an empty term, so a blank config entry matches nothing
 * rather than everything.
 *
 * The cache is keyed on the raw term and holds one entry per distinct config
 * term - a few hundred, fixed for the life of the process. Scoring runs every
 * term against every job in the index, so recompiling per job would make this
 * the most expensive step in the pipeline.
 *
 * The pattern deliberately has no `g` flag. A cached global regex carries
 * `lastIndex` between calls and would start returning false for text it had
 * already matched - a bug that would look like random scoring drift.
 */
export function termPattern(term: string): RegExp | null {
  const cached = cache.get(term);
  if (cached !== undefined) return cached;

  const trimmedIsEmpty = term.trim() === "";
  if (trimmedIsEmpty) {
    cache.set(term, null);
    return null;
  }

  // Anchor an edge only where the term's own character is alphanumeric.
  // `\b` between a space and a space is not a boundary at all, so anchoring
  // " go " would make it match nothing; and a leading `\b` on ".net" would
  // demand a word character before the dot, so ".net developer" would fail.
  const left = /^[a-z0-9]/i.test(term) ? "\\b" : "";
  const right = /[a-z0-9]$/i.test(term) ? `${INFLECTIONS}\\b` : "";

  const re = new RegExp(left + escapeRegExp(term) + right, "i");
  cache.set(term, re);
  return re;
}

/**
 * Does `text` contain `term` as a whole word (or an inflection of one)?
 *
 * The `includes` call is a fast reject, not a second opinion. Every string this
 * pattern can match contains the term literally - the pattern only adds
 * boundaries and a trailing suffix - so a failed substring check is a
 * guaranteed non-match. It keeps the common case (term absent from a 10KB job
 * description) at `String.includes` speed instead of paying for a regex scan
 * several hundred times per job.
 */
export function matchesTerm(text: string, term: string): boolean {
  const re = termPattern(term);
  if (!re) return false;
  const lowered = term.toLowerCase();
  if (!text.toLowerCase().includes(lowered)) return false;
  return re.test(text);
}
