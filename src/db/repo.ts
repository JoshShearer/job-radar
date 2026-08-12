import type { DB } from "./index.js";
import { nowIso } from "./index.js";
import { canonicalUrl, normalizeForIdentity, sha256 } from "../lib/hash.js";
import type { Analysis, EnrichedJob, FilterResult, NormalizedJob, ScoreResult } from "../model/job.js";
import type { Period } from "../lib/salary.js";
import type { RemoteStatus } from "../lib/location.js";
import type { EmploymentType, SeniorityLevel } from "../lib/seniority.js";
import type { Priority, Status } from "../model/status.js";

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
          description_hash = @description_hash
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
      this.db
        .prepare("UPDATE jobs SET analysis_json = NULL, analyzed_at = NULL, scored_at = NULL WHERE id = ?")
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
   * Selection is capped per company. Without that, a single employer with many
   * open roles consumes the entire analysis budget on near-identical postings -
   * observed in practice, where five Samsara reqs took half a pass and returned
   * five variations of the same verdict. Spending the budget across more
   * companies is strictly more informative for the same money.
   */
  needingAnalysis(minFit: number, limit: number, perCompanyCap = 2): EnrichedJob[] {
    // Eligibility is gated on the RAW deterministic score, not the calibrated
    // one. Calibration deliberately scales scores down, so gating on the
    // projected value would shrink the candidate pool every time the
    // correction got stronger - the pool collapsed from 20 candidates to 2 the
    // first time this was wired the other way round.
    //
    // The two numbers answer different questions: the raw score asks "is this
    // worth spending an API call on?", the projected score asks "where does it
    // belong in the ranking?". Ordering still uses the projected value.
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE analysis_json IS NULL
           AND filter_passed = 1
           AND fit_score IS NOT NULL
           AND COALESCE(raw_fit_score, fit_score) >= ?
           AND status NOT IN ('SKIPPED','REJECTED','WITHDRAWN')
         ORDER BY application_roi DESC, fit_score DESC
         LIMIT ?`,
      )
      .all(minFit, limit * 8) as JobRow[];

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
    // fill from the overflow rather than wasting the pass.
    for (const row of overflow) {
      if (picked.length >= limit) break;
      picked.push(row);
    }

    return picked.map(toEnriched);
  }

  /** Top actionable jobs for the daily report. */
  top(opts: { minFit: number; limit: number; since?: string; includeReviewed?: boolean }): EnrichedJob[] {
    const statusClause = opts.includeReviewed
      ? "status NOT IN ('SKIPPED','REJECTED','WITHDRAWN','GHOSTED')"
      : "status = 'NEW'";
    const sinceClause = opts.since ? "AND last_seen >= @since" : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE filter_passed = 1
           AND fit_score >= @minFit
           AND ${statusClause}
           ${sinceClause}
         ORDER BY application_roi DESC, fit_score DESC
         LIMIT @limit`,
      )
      .all({ minFit: opts.minFit, limit: opts.limit, since: opts.since ?? null }) as JobRow[];
    return rows.map(toEnriched);
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

  cacheKey(descriptionHash: string, title: string, company: string, model: string, profileVersion: string): string {
    return sha256([descriptionHash, title, company, model, profileVersion].join("|"));
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
    usage: { input?: number; output?: number } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO analysis_cache (cache_key, description_hash, model, analysis_json, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET analysis_json = excluded.analysis_json`,
      )
      .run(key, descriptionHash, model, JSON.stringify(analysis), usage.input ?? null, usage.output ?? null, nowIso());
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
