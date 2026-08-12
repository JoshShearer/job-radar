import type { CareerProfile } from "../config/schema.js";
import type { FilterResult, NormalizedJob, ScoreResult } from "../model/job.js";
import type { Priority } from "../model/status.js";
import { assessCompensation, formatSalary, type CompAssessment } from "../lib/salary.js";
import { searchable } from "../lib/html.js";
import { normalizeForIdentity } from "../lib/hash.js";

/**
 * Deterministic, explainable scoring.
 *
 * Two numbers come out of here and they answer different questions:
 *
 *   fitScore        - "how well does this role match what I can actually do?"
 *                     Honest match quality. Lane priorities are NOT applied,
 *                     so a great proptech role still reads as a great role.
 *
 *   applicationRoi  - "is this worth my time this week?" This is where lane
 *                     priorities, applicant competition, compensation
 *                     probability, and recency get folded in. A 95% match at a
 *                     famous company with 5,000 applicants can and should rank
 *                     below an 88% match at a 40-person company.
 *
 * Nothing here calls an LLM. Scoring must be reproducible, cheap enough to run
 * over every job on every pass, and auditable when a ranking looks wrong.
 */

export interface ScoringContext {
  /**
   * Open-role count per normalized company name, taken from what we have
   * ingested. This is the competition proxy: a company with 800 open listings
   * is a large employer with heavy inbound applicant flow, and a company with
   * 12 is not. It is imperfect but it is real data we already hold, which
   * beats guessing at headcount.
   */
  companyJobCounts: Map<string, number>;
}

interface SignalHit {
  term: string;
  lane: string;
  points: number;
  inTitle: boolean;
}

export function scoreJob(
  job: NormalizedJob,
  profile: CareerProfile,
  filter: FilterResult,
  ctx: ScoringContext,
): { score: ScoreResult; comp: CompAssessment } {
  const titleText = searchable(job.title);
  const bodyText = searchable(job.descriptionClean, job.department, job.team);
  const allText = `${titleText} \n ${bodyText}`;

  // ---- 1. Positive signals -------------------------------------------------
  const hits: SignalHit[] = [];
  const laneScores = new Map<string, number>();
  for (const laneKey of Object.keys(profile.lanes)) laneScores.set(laneKey, 0);

  for (const signal of profile.signals) {
    const term = signal.term.toLowerCase();
    const inTitle = titleText.includes(term);
    const inBody = bodyText.includes(term);
    if (!inTitle && !inBody) continue;

    // Take the stronger of the two placements rather than summing, so a term
    // repeated in both title and body does not double-count.
    const points = inTitle ? signal.weight * profile.scoring.title_multiplier : signal.weight;
    hits.push({ term: signal.term, lane: signal.lane, points, inTitle });
    laneScores.set(signal.lane, (laneScores.get(signal.lane) ?? 0) + points);
  }

  // ---- 2. Title matches a target role family ------------------------------
  const titleMatches: string[] = [];
  for (const [laneKey, titles] of Object.entries(profile.target_titles)) {
    for (const t of titles) {
      if (titleText.includes(t.toLowerCase())) {
        titleMatches.push(t);
        laneScores.set(laneKey, (laneScores.get(laneKey) ?? 0) + profile.scoring.title_match_bonus);
        break; // one bonus per lane, not per matching phrase
      }
    }
  }

  // ---- 3. Combination bonuses (the differentiation engine) -----------------
  const combosMatched: { name: string; why: string; bonus: number }[] = [];
  for (const combo of profile.combos) {
    const allPresent = combo.all.every((term) => allText.includes(term.toLowerCase()));
    if (!allPresent) continue;
    combosMatched.push({ name: combo.name, why: combo.why, bonus: combo.bonus });
    laneScores.set(combo.lane, (laneScores.get(combo.lane) ?? 0) + combo.bonus);
  }

  // ---- 4. Negative signals -------------------------------------------------
  const negatives: { term: string; points: number }[] = [];
  let negativeTotal = 0;
  for (const neg of profile.negative_signals) {
    const term = neg.term.toLowerCase();
    if (!allText.includes(term)) continue;
    // Weight it up when the unwanted technology is in the title - that means
    // it is the job, not an adjacent nice-to-have.
    const points = titleText.includes(term) ? neg.weight * 2 : neg.weight;
    negatives.push({ term: neg.term.trim(), points });
    negativeTotal += points;
  }

  // ---- 5. Lane assignment --------------------------------------------------
  let lane = "full_stack";
  let laneBest = -Infinity;
  for (const [key, value] of laneScores) {
    if (value > laneBest) {
      laneBest = value;
      lane = key;
    }
  }
  const laneConfig = profile.lanes[lane];
  const laneLabel = laneConfig?.label ?? lane;

  // ---- 6. Fit score --------------------------------------------------------
  const rawPositive = [...laneScores.values()].reduce((a, b) => a + b, 0);
  const freshness = freshnessPoints(job.datePosted, profile);
  const rawTotal = rawPositive - negativeTotal + freshness;
  const fitScore = clamp(Math.round(rawTotal / profile.scoring.normalize_divisor), 0, 100);

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
    {
      targetMin: profile.compensation.target_min,
      targetMax: profile.compensation.target_max,
      acceptableMin: profile.compensation.acceptable_min,
      rejectBelowMax: profile.compensation.reject_below_max,
      stretchMin: profile.compensation.stretch_min,
    },
  );
  const compensationScore = compBandToScore(comp.band);

  // ---- 8. Competition ------------------------------------------------------
  const openings = ctx.companyJobCounts.get(normalizeForIdentity(job.company)) ?? 0;
  const competitionScore = competitionFromOpenings(openings, profile, job.datePosted);

  // ---- 9. Differentiation --------------------------------------------------
  const comboBonus = combosMatched.reduce((a, c) => a + c.bonus, 0);
  const differentiationScore = clamp(Math.round(comboBonus * 2.4), 0, 100);

  // ---- 10. Recency & reachability -----------------------------------------
  const recencyScore = recencyToScore(job.datePosted);
  const reachabilityScore = reachability(openings, job);

  // ---- 11. Application ROI -------------------------------------------------
  const w = profile.roi.weights;
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
  const priority = assignPriority(fitScore, applicationRoi, combosMatched.length, filter);

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
    score: {
      fitScore,
      lane,
      laneLabel,
      compensationScore,
      compensationConfidence: comp.band,
      competitionScore,
      applicationRoi,
      positiveSignals,
      negativeSignals,
      combos: combosMatched.map((c) => c.name),
      explanation,
      priority,
    },
    comp,
  };
}

// ---- helpers ---------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function daysOld(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/** Fresh postings score points; the value decays linearly to zero. */
function freshnessPoints(datePosted: string | null, profile: CareerProfile): number {
  const age = daysOld(datePosted);
  if (age == null) return 0;
  const { freshness_full_days: full, freshness_zero_days: zero, freshness_max_points: max } = profile.scoring;
  if (age <= full) return max;
  if (age >= zero) return 0;
  return max * (1 - (age - full) / (zero - full));
}

function recencyToScore(datePosted: string | null): number {
  const age = daysOld(datePosted);
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
function competitionFromOpenings(openings: number, profile: CareerProfile, datePosted: string | null): number {
  const c = profile.roi.competition;
  let score: number;
  if (openings === 0) score = c.unknown_company_neutral;
  else if (openings >= 300) score = clamp(c.unknown_company_neutral - c.big_tech_penalty, 0, 100);
  else if (openings >= 120) score = clamp(c.unknown_company_neutral - c.big_tech_penalty * 0.6, 0, 100);
  else if (openings >= 40) score = c.unknown_company_neutral;
  else if (openings >= 10) score = clamp(c.unknown_company_neutral + c.small_company_bonus * 0.6, 0, 100);
  else score = clamp(c.unknown_company_neutral + c.small_company_bonus, 0, 100);

  // Applicants accumulate over time; an old posting is a crowded posting.
  const age = daysOld(datePosted);
  if (age != null) {
    if (age > 45) score -= 12;
    else if (age > 21) score -= 6;
  }
  return clamp(Math.round(score), 0, 100);
}

/** How plausible is it to reach an actual human here? */
function reachability(openings: number, job: NormalizedJob): number {
  let score = 50;
  if (openings > 0 && openings < 25) score += 30; // small org, findable people
  else if (openings >= 300) score -= 20; // requisition goes into a black hole
  if (job.department) score += 10; // we know which org owns it
  if (job.ats === "greenhouse" || job.ats === "lever" || job.ats === "ashby") score += 5;
  return clamp(score, 0, 100);
}

function assignPriority(
  fit: number,
  roi: number,
  comboCount: number,
  filter: FilterResult,
): Priority {
  if (!filter.passed) return "D";
  if (fit >= 78 && roi >= 72 && (comboCount > 0 || fit >= 88)) return "A";
  if (fit >= 65 && roi >= 55) return "B";
  if (fit >= 45) return "C";
  return "D";
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
  filter: FilterResult,
  comp: CompAssessment,
  job: NormalizedJob,
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
  job: NormalizedJob;
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

/** Build the company-openings map used as the competition proxy. */
export function buildCompanyCounts(jobs: NormalizedJob[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const j of jobs) {
    const key = normalizeForIdentity(j.company);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
