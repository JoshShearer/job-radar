import type { CareerProfile } from "../config/schema.js";
import type { JobRepo } from "../db/repo.js";
import { applyFilters } from "./filters.js";
import { buildCompanyCounts, scoreJob } from "./score.js";
import { log } from "../lib/log.js";

export interface ScoreSummary {
  scored: number;
  passed: number;
  rejected: number;
  byPriority: Record<string, number>;
  topScore: number;
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
  const byPriority: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };

  for (const job of jobs) {
    const filter = applyFilters(job, profile);
    const { score, comp } = scoreJob(job, profile, filter, { companyJobCounts });

    repo.saveScore(job.id, score, filter, { band: comp.band, note: comp.reason });

    if (filter.passed) passed++;
    else rejected++;
    byPriority[score.priority] = (byPriority[score.priority] ?? 0) + 1;
    if (filter.passed && score.fitScore > topScore) topScore = score.fitScore;
  }

  log.info(
    `Scored ${jobs.length} jobs: ${passed} passed filters, ${rejected} rejected, ` +
      `A=${byPriority.A} B=${byPriority.B} C=${byPriority.C} D=${byPriority.D}`,
  );

  return { scored: jobs.length, passed, rejected, byPriority, topScore };
}
