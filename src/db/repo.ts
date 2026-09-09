import type { DB } from "./index.js";
import { nowIso } from "./index.js";
import { canonicalUrl, normalizeForIdentity, sha256 } from "../lib/hash.js";
import type { Analysis, AnalysisTier, EnrichedJob, FilterResult, NormalizedJob, ScoreResult } from "../model/job.js";
import type { Period } from "../lib/salary.js";
import type { RemoteStatus } from "../lib/location.js";
import type { EmploymentType, SeniorityLevel } from "../lib/seniority.js";
import { IN_FLIGHT_STATUSES, type Priority, type Status } from "../model/status.js";
import { deservesDossier, type DossierPolicy } from "../analysis/detail.js";

/**
 * How one analysis pass spreads its budget across companies.
 *
 * Mirrors `analysis_diversity` in config/career-profile.yaml. Passed in rather
 * than read from config here so the repo stays a data layer and the rule stays
 * testable without a config file on disk.
 */
export interface AnalysisDiversity {
  /**
   * Attempts a job gets before it stops being offered for paid analysis.
   * Null means no limit, which is what the code did before this existed.
   */
  maxAttempts: number | null;
  perCompanyCap: number;
  backfillCap: number;
  coldAfter: number;
  unexploredBonus: number;
  coldPenalty: number;
  /** Postings newer than this many days get `freshBonus` in the ranking. */
  freshDays: number;
  freshBonus: number;
  /**
   * Age past which a posting is not worth paying to analyze, because it will
   * not be recommended either. Null keeps everything.
   */
  evergreenDays: number | null;
}

export interface UpsertOutcome {
  jobId: string;
  isNew: boolean;
  isDuplicate: boolean;
  descriptionChanged: boolean;
  salaryChanged: boolean;
}

interface JobRow {
  id: string;
  dedupe_key: string;
  external_id: string;
  source: string;
  ats: string | null;
  source_url: string;
  canonical_url: string | null;
  application_url: string | null;
  company: string;
  company_normalized: string;
  title: string;
  title_normalized: string;
  location: string;
  remote_status: string;
  employment_type: string;
  seniority: string;
  department: string | null;
  team: string | null;
  industry: string | null;
  company_stage: string | null;
  company_size_estimate: string | null;
  date_posted: string | null;
  date_discovered: string;
  first_seen: string;
  last_seen: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: string | null;
  description_raw: string;
  description_clean: string;
  description_hash: string;
  fit_score: number | null;
  compensation_score: number | null;
  compensation_band: string | null;
  compensation_note: string | null;
  competition_score: number | null;
  application_roi: number | null;
  lane: string | null;
  priority: string | null;
  score_explanation: string | null;
  positive_signals: string | null;
  negative_signals: string | null;
  filter_passed: number;
  filter_reasons: string | null;
  filter_warnings: string | null;
  scored_at: string | null;
  analysis_json: string | null;
  analysis_model: string | null;
  analyzed_at: string | null;
  status: string;
  status_changed_at: string | null;
  resume_version: string | null;
  research_notes: string | null;
  outreach_priority: number | null;
  notes: string | null;
}

export class JobRepo {
  constructor(private readonly db: DB) {}

  /**
   * Insert a job, or merge it into an existing canonical record.
   *
   * Merge rules:
   *  - Same (source, external_id) -> same job; refresh volatile fields.
   *  - Same dedupe_key from a different source -> syndicated duplicate; record
   *    the extra URL, do not create a second row.
   *  - Description/salary changes append an event and update the row, so we
   *    keep both current state and the fact that it moved.
   */
  upsert(job: NormalizedJob, dedupeKey: string): UpsertOutcome {
    const now = nowIso();
    const canonical = canonicalUrl(job.sourceUrl);

    const bySource = this.db
      .prepare("SELECT * FROM jobs WHERE source = ? AND external_id = ?")
      .get(job.source, job.externalId) as JobRow | undefined;

    const byDedupe = bySource
      ? undefined
      : (this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as JobRow | undefined);

    const existing = bySource ?? byDedupe;

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO jobs (
            id, dedupe_key, external_id, source, ats, source_url, canonical_url, application_url,
            company, company_normalized, title, title_normalized, location, remote_status,
            employment_type, seniority, department, team, industry, company_stage, company_size_estimate,
            date_posted, date_discovered, first_seen, last_seen,
            salary_min, salary_max, salary_currency, salary_period,
            description_raw, description_clean, description_hash, status
          ) VALUES (
            @id, @dedupe_key, @external_id, @source, @ats, @source_url, @canonical_url, @application_url,
            @company, @company_normalized, @title, @title_normalized, @location, @remote_status,
            @employment_type, @seniority, @department, @team, @industry, @company_stage, @company_size_estimate,
            @date_posted, @date_discovered, @first_seen, @last_seen,
            @salary_min, @salary_max, @salary_currency, @salary_period,
            @description_raw, @description_clean, @description_hash, 'NEW'
          )`,
        )
        .run({
          id: job.id,
          dedupe_key: dedupeKey,
          external_id: job.externalId,
          source: job.source,
          ats: job.ats,
          source_url: job.sourceUrl,
          canonical_url: canonical,
          application_url: job.applicationUrl,
          company: job.company,
          company_normalized: normalizeForIdentity(job.company),
          title: job.title,
          title_normalized: normalizeForIdentity(job.title),
          location: job.location,
          remote_status: job.remoteStatus,
          employment_type: job.employmentType,
          seniority: job.seniority,
          department: job.department,
          team: job.team,
          industry: job.industry,
          company_stage: job.companyStage,
          company_size_estimate: job.companySizeEstimate,
          date_posted: job.datePosted,
          date_discovered: job.dateDiscovered,
          first_seen: now,
          last_seen: now,
          salary_min: job.salaryMin,
          salary_max: job.salaryMax,
          salary_currency: job.salaryCurrency,
          salary_period: job.salaryPeriod,
          description_raw: job.descriptionRaw,
          description_clean: job.descriptionClean,
          description_hash: job.descriptionHash,
        });

      this.recordSource(job.id, job.source, job.externalId, job.sourceUrl, now);
      this.addEvent(job.id, "discovered", { source: job.source, title: job.title, company: job.company });

      return { jobId: job.id, isNew: true, isDuplicate: false, descriptionChanged: false, salaryChanged: false };
    }

    // Existing record: detect meaningful change before overwriting.
    const descriptionChanged = existing.description_hash !== job.descriptionHash;
    const salaryChanged =
      existing.salary_min !== job.salaryMin ||
      existing.salary_max !== job.salaryMax ||
      existing.salary_period !== job.salaryPeriod;

    this.db
      .prepare(
        `UPDATE jobs SET
          last_seen = @last_seen,
          title = @title,
          title_normalized = @title_normalized,
          location = @location,
          remote_status = @remote_status,
          employment_type = @employment_type,
          seniority = @seniority,
          application_url = COALESCE(@application_url, application_url),
          date_posted = COALESCE(@date_posted, date_posted),
          salary_min = @salary_min,
          salary_max = @salary_max,
          salary_currency = @salary_currency,
          salary_period = @salary_period,
          description_raw = @description_raw,
          description_clean = @description_clean,
          description_hash = @description_hash,
          -- Seeing the posting again undoes a park, and only a park. CLOSED is
          -- the one status a sweep sets on its own, so it is the one status a
          -- sweep may clear. Anything a person recorded is left alone.
          status = CASE WHEN status = 'CLOSED' THEN 'NEW' ELSE status END,
          status_changed_at = CASE WHEN status = 'CLOSED' THEN @last_seen ELSE status_changed_at END
        WHERE id = @id`,
      )
      .run({
        id: existing.id,
        last_seen: now,
        title: job.title,
        title_normalized: normalizeForIdentity(job.title),
        location: job.location,
        remote_status: job.remoteStatus,
        employment_type: job.employmentType,
        seniority: job.seniority,
        application_url: job.applicationUrl,
        date_posted: job.datePosted,
        salary_min: job.salaryMin,
        salary_max: job.salaryMax,
        salary_currency: job.salaryCurrency,
        salary_period: job.salaryPeriod,
        description_raw: job.descriptionRaw,
        description_clean: job.descriptionClean,
        description_hash: job.descriptionHash,
      });

    this.recordSource(existing.id, job.source, job.externalId, job.sourceUrl, now);

    if (descriptionChanged) {
      this.addEvent(existing.id, "description_changed", {
        from_hash: existing.description_hash,
        to_hash: job.descriptionHash,
      });
      // Content moved, so any cached analysis no longer describes this job.
      //
      // The failure record is cleared with it, and that is the point rather
      // than tidiness: a posting whose description changed is a different
      // input. Whatever made the model choke on the old text may be gone, so
      // a job parked after two failures earns a fresh pair of attempts.
      this.db
        .prepare(
          `UPDATE jobs SET analysis_json = NULL, analyzed_at = NULL, scored_at = NULL,
             analysis_failures = 0, analysis_failure_reason = NULL,
             analysis_failure_kind = NULL, analysis_failed_at = NULL
           WHERE id = ?`,
        )
        .run(existing.id);
    }
    if (salaryChanged) {
      this.addEvent(existing.id, "salary_changed", {
        from: { min: existing.salary_min, max: existing.salary_max, period: existing.salary_period },
        to: { min: job.salaryMin, max: job.salaryMax, period: job.salaryPeriod },
      });
    }

    return {
      jobId: existing.id,
      isNew: false,
      isDuplicate: !bySource,
      descriptionChanged,
      salaryChanged,
    };
  }

  private recordSource(jobId: string, source: string, externalId: string, url: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO job_sources (job_id, source, external_id, url, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, source, external_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(jobId, source, externalId, url, now, now);
  }

  addEvent(jobId: string, type: string, detail?: unknown): void {
    this.db
      .prepare("INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(jobId, type, detail === undefined ? null : JSON.stringify(detail), nowIso());
  }

  saveScore(
    jobId: string,
    score: ScoreResult,
    filter: FilterResult,
    comp: { band: string; note: string },
    meta: { confidence: string; rawFit: number },
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET
          fit_score = @fit_score,
          raw_fit_score = @raw_fit_score,
          score_confidence = @score_confidence,
          compensation_score = @compensation_score,
          compensation_band = @compensation_band,
          compensation_note = @compensation_note,
          competition_score = @competition_score,
          application_roi = @application_roi,
          lane = @lane,
          priority = @priority,
          score_explanation = @score_explanation,
          positive_signals = @positive_signals,
          negative_signals = @negative_signals,
          filter_passed = @filter_passed,
          filter_reasons = @filter_reasons,
          filter_warnings = @filter_warnings,
          scored_at = @scored_at
        WHERE id = @id`,
      )
      .run({
        id: jobId,
        fit_score: score.fitScore,
        raw_fit_score: meta.rawFit,
        score_confidence: meta.confidence,
        compensation_score: score.compensationScore,
        compensation_band: comp.band,
        compensation_note: comp.note,
        competition_score: score.competitionScore,
        application_roi: score.applicationRoi,
        lane: score.lane,
        priority: score.priority,
        score_explanation: score.explanation,
        positive_signals: JSON.stringify(score.positiveSignals),
        negative_signals: JSON.stringify(score.negativeSignals),
        filter_passed: filter.passed ? 1 : 0,
        filter_reasons: JSON.stringify(filter.reasons),
        filter_warnings: JSON.stringify(filter.warnings),
        scored_at: nowIso(),
      });
  }

  saveAnalysis(jobId: string, analysis: Analysis, model: string): void {
    this.db
      .prepare("UPDATE jobs SET analysis_json = ?, analysis_model = ?, analyzed_at = ? WHERE id = ?")
      .run(JSON.stringify(analysis), model, nowIso(), jobId);
    this.addEvent(jobId, "analyzed", { model, recommendation: analysis.recommendation });
  }

  setStatus(jobId: string, status: Status, note?: string): boolean {
    const existing = this.db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as
      | { status: string }
      | undefined;
    if (!existing) return false;
    this.db
      .prepare("UPDATE jobs SET status = ?, status_changed_at = ?, notes = COALESCE(?, notes) WHERE id = ?")
      .run(status, nowIso(), note ?? null, jobId);
    this.addEvent(jobId, "status_changed", { from: existing.status, to: status, note: note ?? null });
    return true;
  }

  // ---- Reads --------------------------------------------------------------

  get(idOrPrefix: string): EnrichedJob | null {
    const exact = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(idOrPrefix) as JobRow | undefined;
    if (exact) return toEnriched(exact);
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE id LIKE ? LIMIT 2")
      .all(`${idOrPrefix}%`) as JobRow[];
    if (rows.length === 1 && rows[0]) return toEnriched(rows[0]);
    return null;
  }

  /**
   * Jobs at a company whose name starts with `query`, in-flight ones first.
   *
   * Typing a company name is the low-friction path for moving a job along; an
   * id has to be copied from somewhere. The caller decides what to do with more
   * than one hit - this deliberately returns every match rather than picking,
   * so an ambiguous name can be refused instead of guessed at.
   *
   * The query is normalized the same way the stored column was. `company` is
   * "Acme Corp, Inc." and `company_normalized` is "acme", so matching the raw
   * input against that column finds nothing at all. Normalizing also strips the
   * characters LIKE would treat as wildcards, so the prefix is literal.
   */
  findByCompany(query: string, limit = 20): EnrichedJob[] {
    const normalized = normalizeForIdentity(query);
    if (!normalized) return [];
    const placeholders = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE company_normalized LIKE ?
         ORDER BY status IN (${placeholders}) DESC, status_changed_at DESC, application_roi DESC
         LIMIT ?`,
      )
      .all(`${normalized}%`, ...IN_FLIGHT_STATUSES, limit) as JobRow[];
    return rows.map(toEnriched);
  }

  /** Jobs that need scoring: never scored, or scored before the last content change. */
  needingScore(): NormalizedJob[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE scored_at IS NULL").all() as JobRow[];
    return rows.map(toNormalized);
  }

  /**
   * Every job, with any stored analysis attached. Scoring needs the analysis
   * so it can reconcile the two layers - see reconcileWithAnalysis.
   */
  allForScoring(): EnrichedJob[] {
    const rows = this.db.prepare("SELECT * FROM jobs").all() as JobRow[];
    return rows.map(toEnriched);
  }

  /**
   * Jobs eligible for the (paid) LLM analysis stage.
   *
   * Selection is spread across companies, because the obvious ordering - best
   * ROI first - concentrates the entire budget on whichever employers happen to
   * post the most. Measured on the first 362 analyses: 175 went to 15 companies,
   * ClickUp took 16 and Cresta 14 for zero `apply` results between them, and 245
   * companies with filter-passing jobs had never had a single job looked at.
   *
   * There was already a per-company cap here. It did not hold, because the
   * backfill below it ran with no cap at all: whenever the eligible pool was
   * narrow, unspent budget was refilled from the same companies and the limit
   * silently vanished. ClickUp took 3 in one minute that way. A cap with an
   * uncapped escape hatch is not a cap.
   *
   * Two mechanisms now, both deterministic:
   *
   *   1. Ranking nudge. A company never analyzed gets `unexplored_bonus` ROI
   *      points; one that has spent `cold_after` analyses without ever coming
   *      back `apply` loses `cold_penalty`. This is a nudge, not a sort key - a
   *      strong role at a proven employer must still beat a weak role at a new
   *      name, or the fix is worse than the bug.
   *   2. Two caps. `perCompanyCap` on the first pass, and `backfillCap` as a
   *      hard ceiling on the pass that fills leftover budget.
   *
   * Deprioritised is not excluded. A cold company's next posting can still win
   * on ROI; it just stops crowding out companies nobody has looked at yet.
   *
   * ---------------------------------------------------------------------------
   *
   * SELECTION IS BY RANK, NOT BY AN ABSOLUTE SCORE
   *
   * `minFit` is optional and defaults to no floor. It used to be required, fed
   * from `scoring.analysis_threshold`, and that was the wrong shape: the
   * keyword engine's absolute score is not accurate enough to gate on. Its mean
   * absolute error against the analyst is 26.6 points on a 0-100 scale, and
   * measured over 406 analyzed jobs the hit rate is not even monotonic in the
   * 40-75 range - the 40-49 band returns 8.1% while 50-59 returns 6.5% and
   * 60-74 returns 6.8%.
   *
   * The RANK is reliable even though the score is not, so ordering by it and
   * taking the top K spends the same money on strictly better-chosen jobs.
   *
   * A gate set above what the scorer could produce also made `analyze` report
   * an exhausted index when the index was full - the message was describing the
   * gate rather than the jobs - and that misreading cost an afternoon of adding
   * job boards that were never the constraint.
   *
   * What bounds spend now is `limit` and the spend ceiling, both of which
   * bound it directly instead of by proxy. What bounds *eligibility* is
   * `filter_passed`, which encodes the real constraints (salary floor,
   * location, seniority). A caller can still pass `minFit` for one pass via
   * `--min-fit`, which is a deliberate human choice rather than a standing
   * default nobody re-derives.
   */
  needingAnalysis(limit: number, diversity: AnalysisDiversity, minFit?: number | null): EnrichedJob[] {
    const {
      perCompanyCap, backfillCap, coldAfter, unexploredBonus, coldPenalty,
      freshDays, freshBonus, evergreenDays, maxAttempts,
    } = diversity;

    // Eligibility is gated on the RAW deterministic score, not the calibrated
    // one. Calibration deliberately scales scores down, so gating on the
    // projected value would shrink the candidate pool every time the
    // correction got stronger - the pool collapsed from 20 candidates to 2 the
    // first time this was wired the other way round.
    //
    // The two numbers answer different questions: the raw score asks "is this
    // worth spending an API call on?", the projected score asks "where does it
    // belong in the ranking?". Ordering still uses the projected value.
    //
    // The nudge is applied in SQL rather than after the fact so that `LIMIT`
    // sees the adjusted order. Ranking in JS after a LIMIT would truncate away
    // the unexplored companies before they could ever be promoted - which is
    // the exact bug being fixed, one layer up.
    const rows = this.db
      .prepare(
        `WITH company_state AS (
           SELECT company_normalized AS cn,
                  COUNT(*) AS analyzed,
                  SUM(CASE WHEN json_extract(analysis_json, '$.recommendation')
                             IN ('apply','apply_and_outreach') THEN 1 ELSE 0 END) AS hits
             FROM jobs
            WHERE analysis_json IS NOT NULL
            GROUP BY company_normalized
         )
         SELECT j.* FROM jobs j
           LEFT JOIN company_state cs ON cs.cn = j.company_normalized
          WHERE j.analysis_json IS NULL
            AND j.filter_passed = 1
            AND j.fit_score IS NOT NULL
            AND (? IS NULL OR COALESCE(j.raw_fit_score, j.fit_score) >= ?)
            AND j.status NOT IN ('SKIPPED','REJECTED','WITHDRAWN','CLOSED')
            -- Do not pay to analyze what will not be recommended. An evergreen
            -- posting is excluded from the top list and the daily report, so
            -- buying a verdict on it is money for nothing. NULL date is kept:
            -- unknown age is not old age.
            AND (? IS NULL OR j.date_posted IS NULL
                 OR julianday('now') - julianday(j.date_posted) <= ?)
            -- A job that has already failed this many times is not bought
            -- again. If the failure is deterministic for this posting, paying
            -- for it a third time cannot end differently.
            AND (? IS NULL OR COALESCE(j.analysis_failures, 0) < ?)
          ORDER BY (
            j.application_roi
            + CASE WHEN cs.analyzed IS NULL THEN ? ELSE 0 END
            - CASE WHEN cs.analyzed >= ? AND COALESCE(cs.hits, 0) = 0 THEN ? ELSE 0 END
            -- Freshness-first spend. A nudge inside the ranking, not a sort
            -- key: a clearly better older posting still wins. What this stops
            -- is spending the day's budget on four-month-old listings while
            -- this week's sit unread. Median posting age at apply was 55 days.
            + CASE WHEN j.date_posted IS NOT NULL
                    AND julianday('now') - julianday(j.date_posted) <= ?
                   THEN ? ELSE 0 END
          ) DESC, j.fit_score DESC
          LIMIT ?`,
      )
      .all(
        minFit ?? null,
        minFit ?? null,
        evergreenDays,
        evergreenDays,
        maxAttempts,
        maxAttempts,
        unexploredBonus,
        coldAfter,
        coldPenalty,
        freshDays,
        freshBonus,
        limit * 8,
      ) as JobRow[];

    const perCompany = new Map<string, number>();
    const picked: JobRow[] = [];
    const overflow: JobRow[] = [];

    for (const row of rows) {
      if (picked.length >= limit) break;
      const seen = perCompany.get(row.company_normalized) ?? 0;
      if (seen < perCompanyCap) {
        perCompany.set(row.company_normalized, seen + 1);
        picked.push(row);
      } else {
        overflow.push(row);
      }
    }

    // If the cap left budget unspent (few distinct companies clear the bar),
    // fill from the overflow - but still under a ceiling. Filling without one
    // is what let a single employer take a whole pass.
    for (const row of overflow) {
      if (picked.length >= limit) break;
      const seen = perCompany.get(row.company_normalized) ?? 0;
      if (seen >= backfillCap) continue;
      perCompany.set(row.company_normalized, seen + 1);
      picked.push(row);
    }

    return picked.map(toEnriched);
  }

  /**
   * Every job's source and last sighting, for closed-posting detection.
   *
   * Two columns over the whole index rather than hydrating rows: this is called
   * to colour a listing, and pulling full descriptions to answer "when did each
   * board last see this" would read hundreds of megabytes to print a flag.
   */
  /**
   * Everything a sweep needs to decide what has left the board.
   *
   * Status comes along because the decision depends on it: an inference must
   * never move a posting a person has already acted on.
   */
  parkCandidates(): Array<{ id: string; source: string; lastSeen: string | null; status: string }> {
    return this.db
      .prepare("SELECT id, source, last_seen AS lastSeen, status FROM jobs")
      .all() as Array<{ id: string; source: string; lastSeen: string | null; status: string }>;
  }

  /**
   * Move postings to CLOSED.
   *
   * Guarded in SQL as well as in `planParking`, because this writes status and
   * the guarantee that it never touches a human-set state should not depend on
   * the caller having filtered correctly.
   */
  parkJobs(ids: ReadonlyArray<string>): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE jobs SET status = 'CLOSED', status_changed_at = ?
        WHERE id = ? AND status IN ('NEW','REVIEWED')`,
    );
    const now = new Date().toISOString();
    const run = this.db.transaction((batch: ReadonlyArray<string>) => {
      let n = 0;
      for (const id of batch) n += stmt.run(now, id).changes;
      return n;
    });
    return run(ids);
  }

  /**
   * Record that an analysis attempt failed.
   *
   * Stored rather than logged because the console is not a database. Ten
   * failures cost roughly $0.46 and recurred, and the reasons existed only as
   * warn lines that were gone the moment the run ended - so nothing could say
   * whether they were the same failure ten times or ten different ones.
   */
  recordAnalysisFailure(jobId: string, kind: string, reason: string, spendsAttempt = true): number {
    // The reason and kind are always stored - an API failure is still worth
    // seeing in `failures`. The COUNTER is what decides re-eligibility, so it
    // moves only when the failure is about this posting.
    //
    // Splitting these is load-bearing, not tidiness. With a single counter the
    // log said "not counted against the job" while `needingAnalysis` counted
    // it anyway, so a couple of dropped connections would have parked a
    // perfectly analysable job while insisting it had not.
    this.db
      .prepare(
        `UPDATE jobs SET
           analysis_failures = COALESCE(analysis_failures, 0) + ?,
           analysis_failure_kind = ?,
           analysis_failure_reason = ?,
           analysis_failed_at = ?
         WHERE id = ?`,
      )
      .run(spendsAttempt ? 1 : 0, kind, reason.slice(0, 500), new Date().toISOString(), jobId);
    const row = this.db.prepare("SELECT analysis_failures AS n FROM jobs WHERE id = ?").get(jobId) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * Jobs that have failed analysis, newest first. Queryable, which was the point.
   *
   * Includes jobs whose only failures were API-level, so `analysis_failures`
   * can legitimately read 0 here - the row exists because something went wrong,
   * not because the job spent an attempt.
   */
  analysisFailures(limit = 50): Array<{
    id: string;
    company: string;
    title: string;
    failures: number;
    kind: string | null;
    reason: string | null;
    failedAt: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, company, title,
                COALESCE(analysis_failures, 0) AS failures,
                analysis_failure_kind AS kind,
                analysis_failure_reason AS reason,
                analysis_failed_at AS failedAt
           FROM jobs
          WHERE analysis_failed_at IS NOT NULL
          ORDER BY analysis_failed_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      company: string;
      title: string;
      failures: number;
      kind: string | null;
      reason: string | null;
      failedAt: string | null;
    }>;
  }

  /**
   * Jobs that already carry a full analysis, for benchmarking a cheaper form
   * against the verdicts they hold.
   *
   * BALANCED between apply and non-apply baselines, and that balance is the
   * whole design.
   *
   * Neither extreme works. A uniform sample is ~77% skips, so an agreement rate
   * computed from it would look excellent while saying almost nothing about the
   * decision that matters. But an apply-only sample - which is what the first
   * version of this returned - can only ever measure MISSED applies. It reports
   * "invented applies: 0" because there was no skip baseline to invent one
   * from, which reads as a clean result and is really an untested direction.
   *
   * Both failure modes are real and they cost differently: a missed apply hides
   * a role forever, an invented apply wastes an afternoon. So the sample takes
   * half from each side.
   */
  analyzedSample(
    limit: number,
    opts: { split?: "apply" | "dossier"; policy?: DossierPolicy } = {},
  ): Array<{ job: EnrichedJob; analysis: Analysis }> {
    const split = opts.split ?? "apply";
    const half = Math.max(1, Math.floor(limit / 2));

    // A BASELINE MUST BE A DOSSIER. Once `two_stage` is on, triage stubs land
    // in `analysis_json` too - and a stub drawn as a baseline would have the
    // benchmark comparing the triage form against the triage form, reporting
    // near-perfect agreement while measuring nothing at all. `analysisSchemaFor`
    // guarantees a full response carries these scalars, so a null one is
    // exactly and only a stub.
    const DOSSIER_ONLY = "json_extract(analysis_json, '$.interviewProbability') IS NOT NULL";

    if (split === "dossier") {
      // Partitioned in JS by `deservesDossier` itself, NOT by a SQL IN list
      // against `dossier_for`. The function also routes on
      // `fitScore >= dossier_min_fit`, and a gate that disagrees with the
      // function it gates measures nothing.
      const policy = opts.policy;
      if (!policy) throw new Error('analyzedSample: split "dossier" requires a DossierPolicy.');

      const all = this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE analysis_json IS NOT NULL AND filter_passed = 1 AND ${DOSSIER_ONLY}
            ORDER BY application_roi DESC`,
        )
        .all() as JobRow[];

      const parsed = all.map((r) => ({ row: r, analysis: JSON.parse(r.analysis_json as string) as Analysis }));
      const earns = parsed.filter((p) => deservesDossier(p.analysis, policy));
      const doesNot = parsed.filter((p) => !deservesDossier(p.analysis, policy));

      const picked = [...earns.slice(0, half)];
      picked.push(...doesNot.slice(0, limit - picked.length));
      // Top up from whichever side still has rows, so a lopsided corpus still
      // returns `limit` rather than silently halving the sample.
      if (picked.length < limit) picked.push(...earns.slice(half, half + (limit - picked.length)));

      return picked.map((p) => ({ job: toEnriched(p.row), analysis: p.analysis }));
    }

    const pick = (applyish: boolean, n: number): JobRow[] =>
      this.db
        .prepare(
          `SELECT * FROM jobs
            WHERE analysis_json IS NOT NULL AND filter_passed = 1 AND ${DOSSIER_ONLY}
              AND json_extract(analysis_json, '$.recommendation')
                  ${applyish ? "IN" : "NOT IN"} ('apply','apply_and_outreach')
            ORDER BY application_roi DESC
            LIMIT ?`,
        )
        .all(n) as JobRow[];

    const applies = pick(true, half);
    // Top up from the other side if one is short, so a small corpus still
    // returns `limit` rows rather than silently halving the sample.
    const others = pick(false, limit - applies.length);
    const rows = [...applies, ...others];
    if (rows.length < limit) rows.push(...pick(true, limit - rows.length).slice(applies.length));

    return rows.map((r) => ({
      job: toEnriched(r),
      analysis: JSON.parse(r.analysis_json as string) as Analysis,
    }));
  }

  /* ---- application mail ------------------------------------------------ */

  /** Has this message already been processed? Keeps a re-scan idempotent. */
  emailSeen(messageId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM email_events WHERE message_id = ?").get(messageId) !== undefined
    );
  }

  /** The newest email we have processed, so a scan can narrow its query. */
  lastEmailAt(): string | null {
    const row = this.db.prepare("SELECT MAX(received_at) AS m FROM email_events").get() as { m: string | null };
    return row?.m ?? null;
  }

  recordEmailEvent(e: {
    messageId: string;
    source: string;
    from: string;
    subject: string;
    receivedAt: string;
    kinds: string[];
    evidence: string[];
    resolution: string;
    jobId: string | null;
    appliedStatus: string | null;
    note: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO email_events
           (message_id, source, from_address, subject, received_at, kinds, evidence,
            resolution, job_id, applied_status, note, seen_at)
         VALUES (@messageId, @source, @from, @subject, @receivedAt, @kinds, @evidence,
                 @resolution, @jobId, @appliedStatus, @note, @seenAt)`,
      )
      .run({
        ...e,
        kinds: e.kinds.join(","),
        evidence: e.evidence.slice(0, 5).join(" | ").slice(0, 500),
        seenAt: new Date().toISOString(),
      });
  }

  /** Emails that could not be resolved to exactly one job. The review queue. */
  emailsNeedingReview(limit = 50): Array<{
    messageId: string;
    from: string;
    subject: string;
    receivedAt: string;
    kinds: string;
    resolution: string;
    note: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT message_id AS messageId, from_address AS "from", subject, received_at AS receivedAt,
                kinds, resolution, note
           FROM email_events
          WHERE resolution IN ('ambiguous','unmatched')
          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(limit) as never;
  }

  /** In-flight applications an incoming email could plausibly be about. */
  inFlightApplications(): Array<{
    id: string;
    company: string;
    title: string;
    status: string;
    statusChangedAt: string | null;
    applicationUrl: string | null;
  }> {
    const marks = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT id, company, title, status, status_changed_at AS statusChangedAt,
                application_url AS applicationUrl
           FROM jobs WHERE status IN (${marks})`,
      )
      .all(...IN_FLIGHT_STATUSES) as never;
  }

  /** Applications plus their most recent matched email, for the ghost sweep. */
  ghostCandidates(): Array<{
    id: string;
    company: string;
    title: string;
    status: string;
    statusChangedAt: string | null;
    lastEmailAt: string | null;
  }> {
    const marks = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT j.id, j.company, j.title, j.status,
                j.status_changed_at AS statusChangedAt,
                (SELECT MAX(e.received_at) FROM email_events e WHERE e.job_id = j.id) AS lastEmailAt
           FROM jobs j WHERE j.status IN (${marks})`,
      )
      .all(...IN_FLIGHT_STATUSES) as never;
  }

  /**
   * Runs that failed recently.
   *
   * The point of an unattended schedule is that nobody is watching it, so a
   * failure has to arrive somewhere a person already looks. The briefing is
   * that place; `systemctl --user status` is not.
   */
  recentFailedRuns(days: number): Array<{ command: string; startedAt: string; error: string | null }> {
    return this.db
      .prepare(
        `SELECT command, started_at AS startedAt,
                json_extract(stats_json, '$.error') AS error
           FROM runs
          WHERE ok = 0 AND started_at >= datetime('now', ?)
          ORDER BY started_at DESC
          LIMIT 10`,
      )
      .all(`-${Math.max(1, Math.floor(days))} days`) as never;
  }

  /** When each command last completed successfully. Shows a silent scheduler. */
  lastSuccessfulRun(command: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(started_at) AS m FROM runs WHERE command = ? AND ok = 1")
      .get(command) as { m: string | null } | undefined;
    return row?.m ?? null;
  }

  /** The per-source funnel: in, passed, analyzed, applies out. */
  sourceScorecard(): Array<{
    source: string; ingested: number; passed: number; analyzed: number;
    applies: number; appliedTo: number; closed: number;
  }> {
    return this.db
      .prepare(
        `SELECT source,
                COUNT(*) AS ingested,
                SUM(CASE WHEN filter_passed = 1 THEN 1 ELSE 0 END) AS passed,
                SUM(CASE WHEN analysis_json IS NOT NULL THEN 1 ELSE 0 END) AS analyzed,
                SUM(CASE WHEN json_extract(analysis_json,'$.recommendation')
                              IN ('apply','apply_and_outreach') THEN 1 ELSE 0 END) AS applies,
                SUM(CASE WHEN status IN ('APPLIED','SCREEN','INTERVIEW','FINAL','OFFER')
                         THEN 1 ELSE 0 END) AS appliedTo,
                SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS closed
           FROM jobs
          GROUP BY source`,
      )
      .all() as never;
  }

  allSightings(): Array<{ id: string; source: string; lastSeen: string | null }> {
    return this.db
      .prepare("SELECT id, source, last_seen AS lastSeen FROM jobs")
      .all() as Array<{ id: string; source: string; lastSeen: string | null }>;
  }

  /** Top actionable jobs for the daily report. */
  /**
   * The recommendation list.
   *
   * `evergreenDays` drops postings older than that many days. Null or
   * undefined keeps everything, which is what `--include-evergreen` passes.
   *
   * `date_posted IS NULL` is deliberately kept, not dropped. A board that
   * publishes no date tells us nothing about the posting, and treating missing
   * data as disqualifying data is the same defect as rejecting a location
   * field that only reads "Hybrid".
   */
  top(opts: {
    minFit: number;
    limit: number;
    since?: string;
    includeReviewed?: boolean;
    evergreenDays?: number | null;
  }): EnrichedJob[] {
    const statusClause = opts.includeReviewed
      ? "status NOT IN ('SKIPPED','REJECTED','WITHDRAWN','GHOSTED','CLOSED')"
      : "status = 'NEW'";
    const sinceClause = opts.since ? "AND last_seen >= @since" : "";
    const evergreenClause =
      opts.evergreenDays == null
        ? ""
        : "AND (date_posted IS NULL OR julianday('now') - julianday(date_posted) <= @evergreenDays)";
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE filter_passed = 1
           AND fit_score >= @minFit
           AND ${statusClause}
           ${sinceClause}
           ${evergreenClause}
         ORDER BY application_roi DESC, fit_score DESC
         LIMIT @limit`,
      )
      .all({
        minFit: opts.minFit,
        limit: opts.limit,
        since: opts.since ?? null,
        evergreenDays: opts.evergreenDays ?? null,
      }) as JobRow[];
    return rows.map(toEnriched);
  }

  /**
   * Recorded spend per command.
   *
   * Reads the run log rather than any provider API: this is what THIS tool
   * believes it spent, which is the number a person can act on. Runs that
   * reused a saved document report a real zero, and are counted separately so
   * "30 runs" never reads as "30 charges".
   */
  spendByCommand(days: number): Array<{ command: string; runs: number; paid: number; usd: number }> {
    const rows = this.db
      .prepare(
        `SELECT command,
                COUNT(*) AS runs,
                SUM(CASE WHEN COALESCE(json_extract(stats_json,'$.estimatedCostUsd'),0) > 0 THEN 1 ELSE 0 END) AS paid,
                SUM(COALESCE(json_extract(stats_json,'$.estimatedCostUsd'),0)) AS usd
         FROM runs
         WHERE started_at >= datetime('now', ?)
         GROUP BY command
         HAVING usd > 0
         ORDER BY usd DESC`,
      )
      .all(`-${Math.max(1, Math.floor(days))} days`) as Array<{
      command: string;
      runs: number;
      paid: number;
      usd: number;
    }>;
    return rows;
  }

  /**
   * How many unanalyzed jobs sit just below a threshold, and how high the best
   * of them scores.
   *
   * Exists because "nothing above the threshold" and "nothing worth looking at"
   * are different statements, and the tool reported the first as if it meant
   * the second. With the gate at 55 and the whole remaining pool topping out at
   * 44, `analyze` said "nothing to analyze" every time - which reads as an
   * exhausted index rather than a gate set above what the scorer produces.
   */
  belowThreshold(minFit: number): { count: number; best: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(COALESCE(raw_fit_score, fit_score)) AS best
         FROM jobs
         WHERE analysis_json IS NULL
           AND filter_passed = 1
           AND fit_score IS NOT NULL
           AND COALESCE(raw_fit_score, fit_score) < ?
           AND status NOT IN ('SKIPPED','REJECTED','WITHDRAWN','CLOSED')`,
      )
      .get(minFit) as { count: number; best: number | null };
    return { count: row?.count ?? 0, best: row?.best ?? null };
  }

  /**
   * Everything live and waiting on someone, most recently moved first.
   *
   * The daily slate deliberately shows only NEW jobs, so an application
   * disappears from the briefing the moment its status changes. That is
   * correct for the slate and wrong for the report as a whole: what is in
   * flight is the part of a job search that actually needs attention.
   */
  inFlight(): EnrichedJob[] {
    const placeholders = IN_FLIGHT_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN (${placeholders})
         ORDER BY status_changed_at DESC, application_roi DESC`,
      )
      .all(...IN_FLIGHT_STATUSES) as JobRow[];
    return rows.map(toEnriched);
  }

  /**
   * Every recorded status transition, oldest first.
   *
   * `job_events` is append-only, so this is the history the trend view is built
   * from - the `jobs` row only knows where something ended up. Rows whose
   * `detail` will not parse are dropped rather than guessed at: an event we
   * cannot read is not evidence of a transition.
   */
  statusTransitions(): { jobId: string; from: string | null; to: string; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT job_id, detail, created_at FROM job_events
         WHERE event_type = 'status_changed'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as { job_id: string; detail: string | null; created_at: string }[];

    const out: { jobId: string; from: string | null; to: string; at: string }[] = [];
    for (const r of rows) {
      if (!r.detail) continue;
      let parsed: { from?: unknown; to?: unknown };
      try {
        parsed = JSON.parse(r.detail) as { from?: unknown; to?: unknown };
      } catch {
        continue;
      }
      if (typeof parsed.to !== "string") continue;
      out.push({
        jobId: r.job_id,
        from: typeof parsed.from === "string" ? parsed.from : null,
        to: parsed.to,
        at: r.created_at,
      });
    }
    return out;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    out.total = (this.db.prepare("SELECT COUNT(*) c FROM jobs").get() as { c: number }).c;
    out.passedFilters = (
      this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE filter_passed = 1").get() as { c: number }
    ).c;
    out.scored = (this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE scored_at IS NOT NULL").get() as { c: number }).c;
    out.analyzed = (
      this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE analysis_json IS NOT NULL").get() as { c: number }
    ).c;
    out.score80 = (
      this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE fit_score >= 80 AND filter_passed = 1").get() as {
        c: number;
      }
    ).c;
    for (const p of ["A", "B", "C", "D"]) {
      out[`priority${p}`] = (
        this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE priority = ? AND filter_passed = 1").get(p) as {
          c: number;
        }
      ).c;
    }
    return out;
  }

  statusCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) c FROM jobs GROUP BY status").all() as {
      status: string;
      c: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  discoveredSince(iso: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE first_seen >= ?").get(iso) as { c: number }
    ).c;
  }

  // ---- Analysis cache -----------------------------------------------------

  /**
   * The content address of one analysis.
   *
   * `tier` is part of the key, not decoration. Without it a cheap triage stub
   * and a full dossier for the same posting collide on one row: the two-stage
   * pass writes the stub, and every later read - including one that wants the
   * dossier - gets the stub back forever. That defect was latent only because
   * `two_stage` had never been switched on.
   *
   * Adding `tier` changes every existing key, so the pre-existing cache rows
   * are invalidated once. That is cheap here: the lifetime hit rate is 0.7%
   * (3 hits on 430 rows) and 89 of those rows are already orphaned.
   */
  cacheKey(
    descriptionHash: string,
    title: string,
    company: string,
    model: string,
    profileVersion: string,
    tier: AnalysisTier,
  ): string {
    return sha256([descriptionHash, title, company, model, profileVersion, tier].join("|"));
  }

  getCachedAnalysis(key: string): Analysis | null {
    const row = this.db.prepare("SELECT analysis_json FROM analysis_cache WHERE cache_key = ?").get(key) as
      | { analysis_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.analysis_json) as Analysis;
    } catch {
      return null;
    }
  }

  putCachedAnalysis(
    key: string,
    descriptionHash: string,
    model: string,
    analysis: Analysis,
    usage: { input?: number; output?: number },
    // Required, deliberately. A default of "full" would mean a caller that
    // forgets it silently files a triage stub under the dossier's tier - which
    // is defect 1 all over again, and just as invisible.
    tier: AnalysisTier,
  ): void {
    this.db
      .prepare(
        `INSERT INTO analysis_cache (cache_key, description_hash, model, analysis_json, input_tokens, output_tokens, created_at, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET analysis_json = excluded.analysis_json, tier = excluded.tier`,
      )
      .run(
        key,
        descriptionHash,
        model,
        JSON.stringify(analysis),
        usage.input ?? null,
        usage.output ?? null,
        nowIso(),
        tier,
      );
  }

  // ---- Runs ---------------------------------------------------------------

  startRun(command: string): number {
    const info = this.db
      .prepare("INSERT INTO runs (command, started_at) VALUES (?, ?)")
      .run(command, nowIso());
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, stats: unknown, ok: boolean): void {
    this.db
      .prepare("UPDATE runs SET finished_at = ?, stats_json = ?, ok = ? WHERE id = ?")
      .run(nowIso(), JSON.stringify(stats), ok ? 1 : 0, id);
  }

  // ---- Interviews ---------------------------------------------------------

  addInterview(entry: {
    jobId?: string | null;
    company: string;
    role: string;
    stage: string;
    occurredOn: string;
    interviewer?: string | null;
    questions?: string[];
    technicalTopics?: string[];
    behavioralTopics?: string[];
    answerQuality?: number | null;
    uncertaintyAreas?: string | null;
    compDiscussed?: boolean;
    compIRequested?: number | null;
    compTheyStatedMin?: number | null;
    compTheyStatedMax?: number | null;
    signals?: string | null;
    result?: string | null;
    resultReason?: string | null;
    notes?: string | null;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO interviews (
          job_id, company, role, stage, occurred_on, interviewer, questions, technical_topics,
          behavioral_topics, answer_quality, uncertainty_areas, comp_discussed, comp_i_requested,
          comp_they_stated_min, comp_they_stated_max, signals, result, result_reason, notes, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.jobId ?? null,
        entry.company,
        entry.role,
        entry.stage,
        entry.occurredOn,
        entry.interviewer ?? null,
        JSON.stringify(entry.questions ?? []),
        JSON.stringify(entry.technicalTopics ?? []),
        JSON.stringify(entry.behavioralTopics ?? []),
        entry.answerQuality ?? null,
        entry.uncertaintyAreas ?? null,
        entry.compDiscussed ? 1 : 0,
        entry.compIRequested ?? null,
        entry.compTheyStatedMin ?? null,
        entry.compTheyStatedMax ?? null,
        entry.signals ?? null,
        entry.result ?? null,
        entry.resultReason ?? null,
        entry.notes ?? null,
        nowIso(),
      );
    return Number(info.lastInsertRowid);
  }

  interviewStageCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT stage, COUNT(*) c FROM interviews GROUP BY stage").all() as {
      stage: string;
      c: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.stage, r.c]));
  }

  listInterviews(company?: string): Record<string, unknown>[] {
    const sql = company
      ? "SELECT * FROM interviews WHERE company LIKE ? ORDER BY occurred_on DESC"
      : "SELECT * FROM interviews ORDER BY occurred_on DESC";
    return (company
      ? this.db.prepare(sql).all(`%${company}%`)
      : this.db.prepare(sql).all()) as Record<string, unknown>[];
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function toNormalized(r: JobRow): NormalizedJob {
  return {
    id: r.id,
    externalId: r.external_id,
    source: r.source,
    ats: r.ats,
    sourceUrl: r.source_url,
    applicationUrl: r.application_url,
    company: r.company,
    title: r.title,
    location: r.location,
    remoteStatus: r.remote_status as RemoteStatus,
    employmentType: r.employment_type as EmploymentType,
    seniority: r.seniority as SeniorityLevel,
    datePosted: r.date_posted,
    dateDiscovered: r.date_discovered,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    salaryCurrency: r.salary_currency,
    salaryPeriod: r.salary_period as Period | null,
    descriptionRaw: r.description_raw,
    descriptionClean: r.description_clean,
    descriptionHash: r.description_hash,
    department: r.department,
    team: r.team,
    companySizeEstimate: r.company_size_estimate,
    companyStage: r.company_stage,
    industry: r.industry,
  };
}

function toEnriched(r: JobRow): EnrichedJob {
  let analysis: Analysis | null = null;
  if (r.analysis_json) {
    try {
      analysis = JSON.parse(r.analysis_json) as Analysis;
    } catch {
      analysis = null;
    }
  }
  return {
    ...toNormalized(r),
    status: r.status as Status,
    statusChangedAt: r.status_changed_at,
    fitScore: r.fit_score,
    applicationRoi: r.application_roi,
    lane: r.lane,
    priority: (r.priority as Priority | null) ?? null,
    compensationBand: r.compensation_band,
    compensationNote: r.compensation_note,
    scoreExplanation: r.score_explanation,
    positiveSignals: parseJsonArray(r.positive_signals),
    negativeSignals: parseJsonArray(r.negative_signals),
    analysis,
    analyzedAt: r.analyzed_at,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    notes: r.notes,
  };
}
