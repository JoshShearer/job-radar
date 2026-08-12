import type { CareerProfile } from "../config/schema.js";
import type { JobRepo } from "../db/repo.js";
import { applyFilters } from "./filters.js";
import { buildCompanyCounts, reconcileWithAnalysis, scoreJob } from "./score.js";
import { log } from "../lib/log.js";

export interface ScoreSummary {
  scored: number;
  passed: number;
  rejected: number;
  byPriority: Record<string, number>;
  topScore: number;
  /** Jobs whose stored analysis overrode the deterministic priority. */
  reconciled: number;
}

/**
 * FILTER -> SCORE over every job in the index.
 *
 * This runs over everything rather than only new jobs, because editing
 * career-profile.yaml must re-rank the whole index. It is cheap - no network,
 * no LLM - so there is no reason to be clever about incrementality.
 */
export function runScoring(repo: JobRepo, profile: CareerProfile): ScoreSummary {
  const jobs = repo.allForScoring();
  const companyJobCounts = buildCompanyCounts(jobs);

  let passed = 0;
  let rejected = 0;
  let topScore = 0;
  let reconciled = 0;
  const byPriority: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };

  for (const job of jobs) {
    const filter = applyFilters(job, profile);
    const base = scoreJob(job, profile, filter, { companyJobCounts });

    // A hard filter rejection stands regardless of what the analysis said -
    // the analysis cannot make an onsite-in-Seattle role workable.
    let score = base.score;
    if (job.analysis && filter.passed) {
      const merged = reconcileWithAnalysis(score, job.analysis);
      if (merged.priority !== score.priority) reconciled++;
      score = merged;
    }

    repo.saveScore(job.id, score, filter, { band: base.comp.band, note: base.comp.reason });

    if (filter.passed) passed++;
    else rejected++;
    byPriority[score.priority] = (byPriority[score.priority] ?? 0) + 1;
    if (filter.passed && score.fitScore > topScore) topScore = score.fitScore;
  }

  log.info(
    `Scored ${jobs.length} jobs: ${passed} passed filters, ${rejected} rejected, ` +
      `A=${byPriority.A} B=${byPriority.B} C=${byPriority.C} D=${byPriority.D}` +
      (reconciled > 0 ? ` (${reconciled} priorities overridden by analysis)` : ""),
  );

  return { scored: jobs.length, passed, rejected, byPriority, topScore, reconciled };
}
