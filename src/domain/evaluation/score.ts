import type { EvaluationPolicy, Preferences, Strategy } from "../config/schema.js";
import type { PostingSnapshot } from "../catalog/posting.js";
import { assessCompensation, formatSalary, type CompAssessment, type CompBand } from "../text/salary.js";
import { searchable } from "../text/html.js";
import { normalizeForIdentity } from "../text/identity.js";
import { matchesTerm } from "../text/terms.js";
import { compTargets, postingAgeDays, type Eligibility } from "./eligibility.js";
import { assignPriority, type Priority } from "./priority.js";

export const SCORE_VERSION = "score@1";

/**
 * Deterministic, explainable scoring. Two numbers that answer different
 * questions: `fit` (how well this matches what the candidate can do) and `roi`
 * (whether it is worth the candidate's time this week). No model is involved.
 *
 * The output is the RAW deterministic score. Calibration projections and the
 * analyst's numbers are separate fields in the ranking, never written over it.
 */
export interface DeterministicScore {
  fit: number;
  roi: number;
  lane: string;
  laneLabel: string;
  compensationBand: CompBand;
  compensationNote: string;
  compensationScore: number;
  competitionScore: number;
  positiveSignals: string[];
  negativeSignals: string[];
  combos: string[];
  explanation: string;
  priority: Priority;
}

export interface ScoringContext {
  /**
   * Open-role count per normalized company name, taken from what we have
   * ingested. This is the competition proxy: a company with 800 open listings
   * is a large employer with heavy inbound applicant flow, and a company with
   * 12 is not. It is imperfect but it is real data we already hold, which
   * beats guessing at headcount.
   */
  companyJobCounts: Map<string, number>;
  now: Date;
}

interface SignalHit {
  term: string;
  lane: string;
  points: number;
  inTitle: boolean;
}

export function scorePosting(
  job: PostingSnapshot,
  config: { strategy: Strategy; preferences: Preferences; policy: EvaluationPolicy },
  filter: Eligibility,
  ctx: ScoringContext,
): DeterministicScore {
  const { strategy, preferences, policy } = config;
  const now = ctx.now;
  const titleText = searchable(job.title);
  const bodyText = searchable(job.description, job.department, job.team);
  const allText = `${titleText} \n ${bodyText}`;

  // ---- 1. Positive signals -------------------------------------------------
  const hits: SignalHit[] = [];
  const laneScores = new Map<string, number>();
  for (const laneKey of Object.keys(strategy.lanes)) laneScores.set(laneKey, 0);

  for (const signal of strategy.signals) {
    const term = signal.term.toLowerCase();
    const inTitle = matchesTerm(titleText, term);
    const inBody = matchesTerm(bodyText, term);
    if (!inTitle && !inBody) continue;

    // Take the stronger of the two placements rather than summing, so a term
    // repeated in both title and body does not double-count.
    const points = inTitle ? signal.weight * policy.scoring.title_multiplier : signal.weight;
    hits.push({ term: signal.term, lane: signal.lane, points, inTitle });
    laneScores.set(signal.lane, (laneScores.get(signal.lane) ?? 0) + points);
  }

  // ---- 2. Title matches a target role family ------------------------------
  const titleMatches: string[] = [];
  for (const [laneKey, titles] of Object.entries(strategy.target_titles)) {
    for (const t of titles) {
      if (matchesTerm(titleText, t.toLowerCase())) {
        titleMatches.push(t);
        laneScores.set(laneKey, (laneScores.get(laneKey) ?? 0) + policy.scoring.title_match_bonus);
        break; // one bonus per lane, not per matching phrase
      }
    }
  }

  // ---- 3. Combination bonuses (the differentiation engine) -----------------
  const combosMatched: { name: string; why: string; bonus: number }[] = [];
  for (const combo of strategy.combos) {
    const allPresent = combo.all.every((term) => matchesTerm(allText, term.toLowerCase()));
    if (!allPresent) continue;
    combosMatched.push({ name: combo.name, why: combo.why, bonus: combo.bonus });
    laneScores.set(combo.lane, (laneScores.get(combo.lane) ?? 0) + combo.bonus);
  }

  // ---- 4. Negative signals -------------------------------------------------
  const negatives: { term: string; points: number }[] = [];
  let negativeTotal = 0;
  for (const neg of strategy.negative_signals) {
    const term = neg.term.toLowerCase();
    if (!matchesTerm(allText, term)) continue;
    // Weight it up when the unwanted technology is in the title - that means
    // it is the job, not an adjacent nice-to-have.
    const points = matchesTerm(titleText, term) ? neg.weight * 2 : neg.weight;
    negatives.push({ term: neg.term.trim(), points });
    negativeTotal += points;
  }

  // ---- 5. Lane assignment --------------------------------------------------
  let lane = Object.keys(strategy.lanes)[0] ?? "other";
  let laneBest = -Infinity;
  for (const [key, value] of laneScores) {
    if (value > laneBest) {
      laneBest = value;
      lane = key;
    }
  }
  const laneConfig = strategy.lanes[lane];
  const laneLabel = laneConfig?.label ?? lane;

  // ---- 6. Fit score --------------------------------------------------------
  const rawPositive = [...laneScores.values()].reduce((a, b) => a + b, 0);
  const freshness = freshnessPoints(job.datePosted, policy, now);
  const rawTotal = rawPositive - negativeTotal + freshness;
  const fitScore = clamp(Math.round(rawTotal / policy.scoring.normalize_divisor), 0, 100);

  // ---- 7. Compensation ----------------------------------------------------
  const comp = assessCompensation(
    {
      min: job.salaryMin,
      max: job.salaryMax,
      currency: job.salaryCurrency,
      period: job.salaryPeriod,
      confidence: job.salaryMin != null && job.salaryPeriod != null ? "published" : "none",
      raw: null,
    },
    compTargets(preferences),
  );
  const compensationScore = compBandToScore(comp.band);

  // ---- 8. Competition ------------------------------------------------------
  const openings = ctx.companyJobCounts.get(normalizeForIdentity(job.company)) ?? 0;
  const competitionScore = competitionFromOpenings(openings, policy, job.datePosted, now);

  // ---- 9. Differentiation --------------------------------------------------
  const comboBonus = combosMatched.reduce((a, c) => a + c.bonus, 0);
  const differentiationScore = clamp(Math.round(comboBonus * 2.4), 0, 100);

  // ---- 10. Recency & reachability -----------------------------------------
  const recencyScore = recencyToScore(job.datePosted, now);
  const reachabilityScore = reachability(openings, job);

  // ---- 11. Application ROI -------------------------------------------------
  const w = policy.roi.weights;
  const laneWeight = laneConfig?.weight ?? 0.25;
  // Lane priority nudges ROI within a band rather than dominating it: the
  // multiplier spans roughly 0.9x-1.1x so a truly exceptional role in a
  // lower-priority lane still outranks a mediocre one in the top lane.
  const laneMultiplier = 0.9 + laneWeight * 0.6;

  const roiRaw =
    fitScore * w.fit +
    differentiationScore * w.differentiation +
    compensationScore * w.compensation +
    competitionScore * w.competition +
    recencyScore * w.recency +
    reachabilityScore * w.reachability;

  const applicationRoi = clamp(Math.round(roiRaw * laneMultiplier), 0, 100);

  // ---- 12. Priority --------------------------------------------------------
  const priority = assignPriority(
    { fit: fitScore, roi: applicationRoi, comboCount: combosMatched.length, eligible: filter.passed },
    policy.priority,
  );

  // ---- 13. Explanation -----------------------------------------------------
  const positiveSignals = buildPositiveList(hits, titleMatches, combosMatched);
  const negativeSignals = buildNegativeList(negatives, filter, comp, job);
  const explanation = buildExplanation({
    job,
    fitScore,
    applicationRoi,
    laneLabel,
    positiveSignals,
    negativeSignals,
    comp,
    competitionScore,
    openings,
    combosMatched,
  });

  return {
    fit: fitScore,
    roi: applicationRoi,
    lane,
    laneLabel,
    compensationBand: comp.band,
    compensationNote: comp.reason,
    compensationScore,
    competitionScore,
    positiveSignals,
    negativeSignals,
    combos: combosMatched.map((c) => c.name),
    explanation,
    priority,
  };
}

// ---- helpers ---------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function daysOld(iso: string | null, now: Date): number | null {
  return postingAgeDays(iso, now);
}

/** Fresh postings score points; the value decays linearly to zero. */
function freshnessPoints(datePosted: string | null, policy: EvaluationPolicy, now: Date): number {
  const age = daysOld(datePosted, now);
  if (age == null) return 0;
  const { freshness_full_days: full, freshness_zero_days: zero, freshness_max_points: max } = policy.scoring;
  if (age <= full) return max;
  if (age >= zero) return 0;
  return max * (1 - (age - full) / (zero - full));
}

function recencyToScore(datePosted: string | null, now: Date): number {
  const age = daysOld(datePosted, now);
  if (age == null) return 50; // unknown date is neutral, not penalized
  if (age <= 3) return 100;
  if (age <= 7) return 85;
  if (age <= 14) return 70;
  if (age <= 30) return 50;
  if (age <= 60) return 30;
  return 15;
}

function compBandToScore(band: CompAssessment["band"]): number {
  switch (band) {
    case "GREEN":
      return 90;
    case "YELLOW":
      return 55;
    case "RED":
      return 10;
    default:
      // UNKNOWN sits slightly above neutral on purpose. Most small companies
      // that would value this background do not publish a range, and treating
      // silence as a negative would systematically filter out the best lane.
      return 58;
  }
}

/**
 * Competition proxy. Higher score = less competition = better for us.
 * Openings count is a stand-in for company size and inbound applicant volume.
 */
function competitionFromOpenings(openings: number, policy: EvaluationPolicy, datePosted: string | null, now: Date): number {
  const c = policy.roi.competition;
  let score: number;
  if (openings === 0) score = c.unknown_company_neutral;
  else if (openings >= 300) score = clamp(c.unknown_company_neutral - c.big_tech_penalty, 0, 100);
  else if (openings >= 120) score = clamp(c.unknown_company_neutral - c.big_tech_penalty * 0.6, 0, 100);
  else if (openings >= 40) score = c.unknown_company_neutral;
  else if (openings >= 10) score = clamp(c.unknown_company_neutral + c.small_company_bonus * 0.6, 0, 100);
  else score = clamp(c.unknown_company_neutral + c.small_company_bonus, 0, 100);

  // Applicants accumulate over time; an old posting is a crowded posting.
  const age = daysOld(datePosted, now);
  if (age != null) {
    if (age > 45) score -= 12;
    else if (age > 21) score -= 6;
  }
  return clamp(Math.round(score), 0, 100);
}

/** How plausible is it to reach an actual human here? */
function reachability(openings: number, job: PostingSnapshot): number {
  let score = 50;
  if (openings > 0 && openings < 25) score += 30; // small org, findable people
  else if (openings >= 300) score -= 20; // requisition goes into a black hole
  if (job.department) score += 10; // we know which org owns it
  if (job.provider === "greenhouse" || job.provider === "lever" || job.provider === "ashby") score += 5;
  return clamp(score, 0, 100);
}

function buildPositiveList(
  hits: SignalHit[],
  titleMatches: string[],
  combos: { name: string; why: string }[],
): string[] {
  const out: string[] = [];
  for (const c of combos) out.push(`COMBO: ${c.name}${c.why ? ` - ${c.why}` : ""}`);
  for (const t of titleMatches) out.push(`Title matches target role "${t}"`);

  const ranked = [...hits].sort((a, b) => b.points - a.points).slice(0, 12);
  for (const h of ranked) {
    out.push(`${h.term}${h.inTitle ? " (in title)" : ""}`);
  }
  return out;
}

function buildNegativeList(
  negatives: { term: string; points: number }[],
  filter: Eligibility,
  comp: CompAssessment,
  job: PostingSnapshot,
): string[] {
  const out: string[] = [];
  for (const r of filter.reasons) out.push(`REJECTED: ${r}`);
  for (const w of filter.warnings) out.push(`WARNING: ${w}`);
  if (comp.band === "YELLOW" || comp.band === "RED") out.push(`Compensation ${comp.band}: ${comp.reason}`);
  for (const n of [...negatives].sort((a, b) => b.points - a.points).slice(0, 8)) {
    out.push(`Wants ${n.term} (no direct evidence in profile)`);
  }
  if (job.remoteStatus === "unknown") out.push("Remote status not stated");
  return out;
}

function buildExplanation(args: {
  job: PostingSnapshot;
  fitScore: number;
  applicationRoi: number;
  laneLabel: string;
  positiveSignals: string[];
  negativeSignals: string[];
  comp: CompAssessment;
  competitionScore: number;
  openings: number;
  combosMatched: { name: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`Fit = ${args.fitScore}   Application ROI = ${args.applicationRoi}   Lane: ${args.laneLabel}`);
  lines.push("");
  lines.push("Strong matches:");
  const strong = args.positiveSignals.slice(0, 8);
  if (strong.length === 0) lines.push("  * (none - this scored on title/lane fit alone)");
  for (const s of strong) lines.push(`  * ${s}`);

  lines.push("");
  lines.push("Weaknesses:");
  const weak = args.negativeSignals.slice(0, 8);
  if (weak.length === 0) lines.push("  * (none identified deterministically)");
  for (const s of weak) lines.push(`  * ${s}`);

  lines.push("");
  lines.push(
    `Compensation: ${args.comp.band} - ${args.comp.reason} Posted range: ${formatSalary({
      min: args.job.salaryMin,
      max: args.job.salaryMax,
      currency: args.job.salaryCurrency,
      period: args.job.salaryPeriod,
      confidence: args.job.salaryMin != null ? "published" : "none",
      raw: null,
    })}.`,
  );
  lines.push(
    `Competition proxy: ${args.competitionScore}/100 (${
      args.openings > 0 ? `${args.openings} open roles at this company in the index` : "company not otherwise indexed"
    }).`,
  );
  return lines.join("\n");
}


/** Open-role count per company: the competition proxy. */
export function buildCompanyCounts(companies: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of companies) {
    const key = normalizeForIdentity(c);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
