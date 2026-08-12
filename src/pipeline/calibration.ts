import type { DB } from "../db/index.js";

/**
 * Score calibration — the "learn from results" loop.
 *
 * The deterministic engine systematically over-scores, and the bias is large:
 * measured across real analyses it rated a Sr. Staff role demanding org-wide
 * technical leadership at 96 where the analysis said 33. Keyword matching
 * cannot read level, company type, or whether a differentiator is actually
 * valued, so it counts every matching word as a point in your favour.
 *
 * That bias makes the ranking incoherent once some jobs are analyzed and
 * others are not: an unanalyzed job carrying an inflated 90 outranks an
 * analyzed job honestly assessed at 70. This module measures the bias from
 * jobs where BOTH numbers exist, then applies it to the ones where only the
 * deterministic number exists, so everything is on one comparable scale.
 *
 * It is a linear correction fitted to observed data, not a guess. And like the
 * funnel diagnosis, it refuses to act on a sample too small to mean anything.
 */

/** Below this many analyzed jobs, the correction is noise. Do not apply it. */
export const MIN_CALIBRATION_SAMPLE = 8;

export interface Calibration {
  sampleSize: number;
  /** Multiply a deterministic fit score by this to project the analyzed value. */
  fitRatio: number;
  /** Same, for Application ROI. */
  roiRatio: number;
  /** Mean signed error (deterministic - analyzed). Positive = over-scoring. */
  fitBias: number;
  roiBias: number;
  computedAt: string;
  /** True when sampleSize >= MIN_CALIBRATION_SAMPLE. */
  usable: boolean;
}

export interface CalibrationPair {
  detFit: number;
  llmFit: number;
  detRoi: number;
  llmRoi: number;
}

type Pair = CalibrationPair;

/**
 * Fit the correction from observation pairs held in memory.
 *
 * This is the real entry point. Deriving the correction from freshly-computed
 * deterministic scores avoids an ordering trap: reading them back from the
 * database means calibration sees whatever the *previous* run persisted, and on
 * the first run after the column is introduced it sees nothing at all.
 */
export function calibrateFromPairs(pairs: Pair[]): Calibration {
  const now = new Date().toISOString();
  if (pairs.length === 0) {
    return { sampleSize: 0, fitRatio: 1, roiRatio: 1, fitBias: 0, roiBias: 0, computedAt: now, usable: false };
  }

  const fitRatio = median(pairs.map((p) => p.llmFit / p.detFit));
  const roiPairs = pairs.filter((p) => p.detRoi > 0);
  const roiRatio = roiPairs.length ? median(roiPairs.map((p) => p.llmRoi / p.detRoi)) : fitRatio;

  return {
    sampleSize: pairs.length,
    // Clamp to a sane band. A correction outside this range means something
    // other than scoring bias is wrong, and silently applying it would be worse
    // than applying nothing.
    fitRatio: clamp(fitRatio, 0.25, 1.5),
    roiRatio: clamp(roiRatio, 0.25, 1.5),
    fitBias: mean(pairs.map((p) => p.detFit - p.llmFit)),
    roiBias: roiPairs.length ? mean(roiPairs.map((p) => p.detRoi - p.llmRoi)) : 0,
    computedAt: now,
    usable: pairs.length >= MIN_CALIBRATION_SAMPLE,
  };
}

/**
 * Fit the correction from every job that has both a deterministic score and an
 * analysis.
 *
 * Uses the MEDIAN ratio rather than the mean. One role scored 8 by the analysis
 * against a deterministic 60 produces a ratio of 0.13, and a handful of those
 * would drag a mean correction far below what the typical job deserves. The
 * median is unmoved by that tail.
 */
export function computeCalibration(db: DB): Calibration {
  const rows = db
    .prepare(
      `SELECT raw_fit_score, fit_score, application_roi, analysis_json
       FROM jobs
       WHERE analysis_json IS NOT NULL AND fit_score IS NOT NULL`,
    )
    .all() as {
    raw_fit_score: number | null;
    fit_score: number | null;
    application_roi: number | null;
    analysis_json: string;
  }[];

  const pairs: Pair[] = [];
  for (const r of rows) {
    let analysis: { fitScore?: number; applicationRoi?: number };
    try {
      analysis = JSON.parse(r.analysis_json);
    } catch {
      continue;
    }
    // Prefer the stored raw score. Fall back to fit_score for rows written
    // before raw_fit_score existed - after reconciliation that column holds the
    // analyzed value, which would yield a useless ratio of 1.0, so those are
    // skipped rather than silently flattening the correction toward no-op.
    const detFit = r.raw_fit_score;
    if (detFit == null || detFit <= 0) continue;
    if (analysis.fitScore == null || analysis.applicationRoi == null) continue;

    pairs.push({
      detFit,
      llmFit: analysis.fitScore,
      detRoi: r.application_roi ?? 0,
      llmRoi: analysis.applicationRoi,
    });
  }

  return calibrateFromPairs(pairs);
}

/** Apply the correction to an unanalyzed job's scores. */
export function project(
  raw: { fitScore: number; applicationRoi: number },
  cal: Calibration,
): { fitScore: number; applicationRoi: number } {
  if (!cal.usable) return raw;
  return {
    fitScore: clamp(Math.round(raw.fitScore * cal.fitRatio), 0, 100),
    applicationRoi: clamp(Math.round(raw.applicationRoi * cal.roiRatio), 0, 100),
  };
}

const CALIBRATION_KEY = "calibration";

export function saveCalibration(db: DB, cal: Calibration): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CALIBRATION_KEY, JSON.stringify(cal));
}

export function loadCalibration(db: DB): Calibration | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(CALIBRATION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Calibration;
  } catch {
    return null;
  }
}

export function describeCalibration(cal: Calibration): string {
  if (cal.sampleSize === 0) {
    return "No calibration yet: no job has both a deterministic score and an analysis. Run `analyze`.";
  }
  if (!cal.usable) {
    return (
      `Calibration measured on ${cal.sampleSize} job(s) but NOT applied - below the ` +
      `${MIN_CALIBRATION_SAMPLE}-sample floor, the correction would be noise. ` +
      `Observed so far: keyword fit runs ${cal.fitBias > 0 ? "high" : "low"} by ` +
      `${Math.abs(Math.round(cal.fitBias))} points.`
    );
  }
  const pct = Math.round((1 - cal.fitRatio) * 100);
  return (
    `Calibrated on ${cal.sampleSize} analyzed jobs. The keyword engine over-scores fit by ` +
    `${Math.round(cal.fitBias)} points on average (${pct}% high), so unanalyzed jobs are ` +
    `projected at ${cal.fitRatio.toFixed(2)}x fit / ${cal.roiRatio.toFixed(2)}x ROI to keep the ` +
    `ranking comparable.`
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
