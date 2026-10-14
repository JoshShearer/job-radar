import type { EvaluationPolicy } from "../config/schema.js";

/**
 * Measure how far the keyword engine drifts from the analyst, from postings
 * that have both, and project that correction onto postings that have only the
 * keyword score so one ranking compares like with like.
 *
 * Median ratio, not mean (one 8-vs-60 outlier must not drag the correction).
 * Below `min_sample` the correction is reported and NOT applied.
 */
export interface Calibration {
  sampleSize: number;
  fitRatio: number;
  roiRatio: number;
  fitBias: number;
  roiBias: number;
  usable: boolean;
  /** How many of the pairs came from imported (pre-migration) assessments. */
  fromLegacy: number;
}

export interface CalibrationPair {
  detFit: number;
  llmFit: number;
  detRoi: number;
  llmRoi: number;
}

export const NO_CALIBRATION: Calibration = { sampleSize: 0, fitRatio: 1, roiRatio: 1, fitBias: 0, roiBias: 0, usable: false, fromLegacy: 0 };

export function calibrate(pairs: readonly CalibrationPair[], policy: EvaluationPolicy["calibration"]): Calibration {
  const usablePairs = pairs.filter((p) => p.detFit > 0);
  if (usablePairs.length === 0) return NO_CALIBRATION;
  const fitRatio = median(usablePairs.map((p) => p.llmFit / p.detFit));
  const roiPairs = usablePairs.filter((p) => p.detRoi > 0);
  const roiRatio = roiPairs.length ? median(roiPairs.map((p) => p.llmRoi / p.detRoi)) : fitRatio;
  return {
    sampleSize: usablePairs.length,
    fitRatio: clamp(fitRatio, policy.min_ratio, policy.max_ratio),
    roiRatio: clamp(roiRatio, policy.min_ratio, policy.max_ratio),
    fitBias: mean(usablePairs.map((p) => p.detFit - p.llmFit)),
    roiBias: roiPairs.length ? mean(roiPairs.map((p) => p.detRoi - p.llmRoi)) : 0,
    usable: usablePairs.length >= policy.min_sample,
    fromLegacy: 0,
  };
}

/**
 * Calibrate on current assessments, topped up with imported ones only while
 * the current sample is below the floor. A legacy assessment is never a
 * current verdict on its posting, but as a (keyword, analyst) pair it is still
 * evidence of how far the keyword engine drifts. Without it, every migrated
 * index ranks on raw keyword scores until enough fresh assessments are bought.
 */
export function calibrateWithLegacy(
  current: readonly CalibrationPair[],
  legacy: readonly CalibrationPair[],
  policy: EvaluationPolicy["calibration"],
): Calibration {
  const now = calibrate(current, policy);
  if (now.usable || legacy.length === 0) return now;
  const both = calibrate([...current, ...legacy], policy);
  return { ...both, fromLegacy: both.sampleSize - now.sampleSize };
}

export function project(raw: { fit: number; roi: number }, cal: Calibration): { fit: number; roi: number } | null {
  if (!cal.usable) return null;
  return {
    fit: clamp(Math.round(raw.fit * cal.fitRatio), 0, 100),
    roi: clamp(Math.round(raw.roi * cal.roiRatio), 0, 100),
  };
}

export function describeCalibration(cal: Calibration, minSample: number): string {
  if (cal.sampleSize === 0) return "No calibration yet: no posting has both a keyword score and a current assessment.";
  if (!cal.usable) {
    return (
      `Calibration measured on ${cal.sampleSize} posting(s) but NOT applied (below the ${minSample}-sample floor). ` +
      `Keyword fit runs ${cal.fitBias > 0 ? "high" : "low"} by ${Math.abs(Math.round(cal.fitBias))} points so far.`
    );
  }
  const legacy = cal.fromLegacy ? ` (${cal.fromLegacy} of them imported, pre-migration assessments)` : "";
  return (
    `Calibrated on ${cal.sampleSize} assessed postings${legacy}: keyword fit runs ${cal.fitBias >= 0 ? "high" : "low"} by ` +
    `${Math.abs(Math.round(cal.fitBias))} points, so unassessed postings are projected at ` +
    `${cal.fitRatio.toFixed(2)}x fit / ${cal.roiRatio.toFixed(2)}x ROI.`
  );
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
