import type { CareerProfile } from "../config/schema.js";
import type { DB } from "../db/index.js";
import type { JobRepo } from "../db/repo.js";
import { applyFilters } from "./filters.js";
import { buildCompanyCounts, reconcileWithAnalysis, scoreJob } from "./score.js";
import {
  calibrateFromPairs,
  describeCalibration,
  project,
  saveCalibration,
  type Calibration,
  type CalibrationPair,
} from "./calibration.js";
import { computeAnalysisIdentity, staleAnalysisFields } from "../analysis/identity.js";
import { analysisSchemaFor, isTriageOnly, triageSchemaFor } from "../model/job.js";
import { log } from "../lib/log.js";

export interface ScoreSummary {
  scored: number;
  passed: number;
  rejected: number;
  byPriority: Record<string, number>;
  topScore: number;
  /** Jobs whose stored analysis overrode the deterministic priority. */
  reconciled: number;
  /** Jobs whose score was projected using the measured calibration. */
  projected: number;
  /**
   * Jobs that carry an `analysis_json` too stale to trust (JOB-51): one of
   * its snapshotted inputs has moved, or it no longer matches the live
   * schema for its tier. Excluded from `reconciled`, folded into `projected`
   * instead - the same treatment a never-analyzed job gets.
   */
  staleAnalysis: number;
  calibration: Calibration;
}

/**
 * FILTER -> SCORE over every job in the index.
 *
 * This runs over everything rather than only new jobs, because editing
 * career-profile.yaml must re-rank the whole index. It is cheap - no network,
 * no LLM - so there is no reason to be clever about incrementality.
 */
export function runScoring(repo: JobRepo, profile: CareerProfile, db: DB): ScoreSummary {
  const jobs = repo.allForScoring();
  const companyJobCounts = buildCompanyCounts(jobs);

  // ---- Pass 1: deterministic scores, plus calibration observations --------
  // Computing every deterministic score first means calibration is measured
  // against this run's numbers rather than whatever a previous run persisted.
  // Reading them back from the database instead would make the correction a
  // run behind, and on the very first run after the column is introduced it
  // would find nothing at all and silently skip projection entirely.
  const scored = jobs.map((job) => {
    const filter = applyFilters(job, profile);
    const base = scoreJob(job, profile, filter, { companyJobCounts });
    return { job, filter, base, rawFit: base.score.fitScore };
  });

  const pairs: CalibrationPair[] = [];
  for (const s of scored) {
    if (!s.job.analysis) continue;
    pairs.push({
      detFit: s.rawFit,
      llmFit: s.job.analysis.fitScore,
      detRoi: s.base.score.applicationRoi,
      llmRoi: s.job.analysis.applicationRoi,
    });
  }

  const calibration = calibrateFromPairs(pairs);
  saveCalibration(db, calibration);
  log.info(describeCalibration(calibration));

  // ---- Pass 2: reconcile, project, persist --------------------------------
  let passed = 0;
  let rejected = 0;
  let topScore = 0;
  let reconciled = 0;
  let projected = 0;
  const byPriority: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  const laneKeys = Object.keys(profile.lanes);
  let staleAnalysis = 0;

  for (const { job, filter, base, rawFit } of scored) {
    let score = base.score;
    let confidence = "raw";

    // JOB-51: an attached `analysis_json` is trusted for reconciliation only
    // when it still describes THIS job. `upsert()` overwrites
    // title/location/employment/salary unconditionally and `material_hash`
    // only tracks the description, so a re-titled or re-leveled posting could
    // otherwise keep reconciling against a verdict formed for a different
    // role - reading a corrected keyword score as "the analyst agreed" when
    // the analyst never saw the current posting.
    //
    // A schema mismatch is folded into the same "cannot be trusted" bucket
    // (decision: AC bullet 5) rather than a new state - CLAUDE.md wants three
    // states for `resume match`, not six here. Either way the job falls
    // through to the calibration-projection branch below, exactly as if it
    // had never been analyzed.
    const isStale = (): boolean => {
      if (!job.analysis) return false;
      const current = computeAnalysisIdentity(job, profile);
      if (staleAnalysisFields(job.analysisIdentity, current).length > 0) return true;
      const schema = isTriageOnly(job.analysis) ? triageSchemaFor(laneKeys) : analysisSchemaFor(laneKeys);
      return !schema.safeParse(job.analysis).success;
    };

    if (job.analysis && filter.passed && !isStale()) {
      // A hard-filter rejection stands regardless of what the analysis said -
      // the analysis cannot make an onsite-in-Seattle role workable.
      const merged = reconcileWithAnalysis(score, job.analysis);
      if (merged.priority !== score.priority) reconciled++;
      score = merged;
      confidence = "analyzed";
    } else if (job.analysis && filter.passed) {
      staleAnalysis++;
    }

    if (confidence !== "analyzed" && filter.passed && calibration.usable) {
      // No analysis yet. Project what an analysis would most likely say, so
      // this job is comparable to the analyzed ones in the same ranking
      // instead of sitting above them on an uncorrected number.
      const p = project({ fitScore: score.fitScore, applicationRoi: score.applicationRoi }, calibration);
      score = {
        ...score,
        fitScore: p.fitScore,
        applicationRoi: p.applicationRoi,
        priority: reprioritize(p.fitScore, p.applicationRoi, score.combos.length),
        explanation:
          `${score.explanation}\n\nNot yet analyzed. Keyword fit was ${rawFit}; projected to ` +
          `${p.fitScore} using the ${calibration.fitRatio.toFixed(2)}x correction measured across ` +
          `${calibration.sampleSize} analyzed jobs. Run \`analyze\` for a real read.`,
      };
      confidence = "projected";
      projected++;
    }

    repo.saveScore(
      job.id,
      score,
      filter,
      { band: base.comp.band, note: base.comp.reason },
      { confidence, rawFit },
    );

    if (filter.passed) passed++;
    else rejected++;
    byPriority[score.priority] = (byPriority[score.priority] ?? 0) + 1;
    if (filter.passed && score.fitScore > topScore) topScore = score.fitScore;
  }

  log.info(
    `Scored ${jobs.length} jobs: ${passed} passed filters, ${rejected} rejected, ` +
      `A=${byPriority.A} B=${byPriority.B} C=${byPriority.C} D=${byPriority.D}` +
      (reconciled > 0 ? ` | ${reconciled} priorities overridden by analysis` : "") +
      (projected > 0 ? ` | ${projected} projected from calibration` : "") +
      (staleAnalysis > 0 ? ` | ${staleAnalysis} standing analyses stale, treated as unanalyzed` : ""),
  );

  return { scored: jobs.length, passed, rejected, byPriority, topScore, reconciled, projected, staleAnalysis, calibration };
}

/**
 * Re-derive priority after projection. Uses the same thresholds as the initial
 * assignment, but a projected job can never reach A: A means "apply and reach
 * out to a human today", and that should rest on an actual analysis rather than
 * on a statistical correction of a keyword count.
 */
function reprioritize(fit: number, roi: number, comboCount: number): "A" | "B" | "C" | "D" {
  if (fit >= 78 && roi >= 72 && (comboCount > 0 || fit >= 88)) return "B";
  if (fit >= 65 && roi >= 55) return "B";
  if (fit >= 45) return "C";
  return "D";
}
