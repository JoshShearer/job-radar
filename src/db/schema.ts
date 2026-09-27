/**
 * SQLite schema.
 *
 * Kept as a TypeScript string rather than a .sql file so that running from
 * source (tsx) and any future compiled build resolve it identically - no
 * asset-copying step, no path guessing.
 *
 * Retention rule: nothing here overwrites history. Description and salary
 * changes append to job_events; the jobs row holds current state and the
 * event log holds how it got there.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per canonical opportunity. Syndicated duplicates collapse into this
-- row and record their own URL in job_sources.
CREATE TABLE IF NOT EXISTS jobs (
  id                       TEXT PRIMARY KEY,
  dedupe_key               TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  source                   TEXT NOT NULL,
  ats                      TEXT,
  source_url               TEXT NOT NULL,
  canonical_url            TEXT,
  application_url          TEXT,

  company                  TEXT NOT NULL,
  company_normalized       TEXT NOT NULL,
  title                    TEXT NOT NULL,
  title_normalized         TEXT NOT NULL,
  location                 TEXT NOT NULL DEFAULT '',
  remote_status            TEXT NOT NULL DEFAULT 'unknown',
  employment_type          TEXT NOT NULL DEFAULT 'unknown',
  seniority                TEXT NOT NULL DEFAULT 'unknown',
  department               TEXT,
  team                     TEXT,
  industry                 TEXT,
  company_stage            TEXT,
  company_size_estimate    TEXT,

  date_posted              TEXT,
  date_discovered          TEXT NOT NULL,
  first_seen               TEXT NOT NULL,
  last_seen                TEXT NOT NULL,

  salary_min               INTEGER,
  salary_max               INTEGER,
  salary_currency          TEXT NOT NULL DEFAULT 'USD',
  salary_period            TEXT,

  description_clean        TEXT NOT NULL DEFAULT '',
  description_hash         TEXT NOT NULL,

  -- Deterministic scoring output
  fit_score                REAL,
  compensation_score       REAL,
  compensation_band        TEXT,
  compensation_note        TEXT,
  competition_score        REAL,
  application_roi          REAL,
  lane                     TEXT,
  priority                 TEXT,
  score_explanation        TEXT,
  positive_signals         TEXT,   -- JSON array
  negative_signals         TEXT,   -- JSON array
  filter_passed            INTEGER NOT NULL DEFAULT 1,
  filter_reasons           TEXT,   -- JSON array
  filter_warnings          TEXT,   -- JSON array
  scored_at                TEXT,

  -- LLM analysis output (validated JSON blob)
  analysis_json            TEXT,
  analysis_model           TEXT,
  analyzed_at              TEXT,

  -- Human workflow
  status                   TEXT NOT NULL DEFAULT 'NEW',
  status_changed_at        TEXT,
  resume_version           TEXT,
  research_notes           TEXT,
  outreach_priority        INTEGER,
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_dedupe   ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority);
CREATE INDEX IF NOT EXISTS idx_jobs_roi      ON jobs(application_roi DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_fit      ON jobs(fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company  ON jobs(company_normalized);
CREATE INDEX IF NOT EXISTS idx_jobs_lastseen ON jobs(last_seen);

-- Every URL a canonical job was seen at. Syndication is the norm, so we keep
-- all of them and never discard a source pointer.
CREATE TABLE IF NOT EXISTS job_sources (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url         TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  PRIMARY KEY (job_id, source, external_id)
);

-- Append-only history. This is what makes hiring behavior visible: a role
-- whose salary quietly moved, or whose description was rewritten, is a signal.
CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,  -- discovered | description_changed | salary_changed | status_changed | reposted | analyzed
  detail     TEXT,           -- JSON payload
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_job  ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON job_events(event_type);

-- Cache of LLM analyses keyed by content, so unchanged jobs are never
-- re-analyzed and re-paid for.
CREATE TABLE IF NOT EXISTS analysis_cache (
  cache_key        TEXT PRIMARY KEY,  -- hash(description_hash + title + company + model + profile_version + tier)
  description_hash TEXT NOT NULL,
  model            TEXT NOT NULL,
  analysis_json    TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  created_at       TEXT NOT NULL,
  -- 'triage' (cheap verdict) or 'full' (verdict + dossier). Defaulting to
  -- 'full' is provable rather than assumed: every row predates the two-stage
  -- flag, and SUM(json_extract(stats_json,'$.triageOnly')) over the whole runs
  -- table is 0 lifetime.
  tier             TEXT NOT NULL DEFAULT 'full'
);

-- Interview intelligence: one row per stage of one process.
CREATE TABLE IF NOT EXISTS interviews (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id               TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  company              TEXT NOT NULL,
  role                 TEXT NOT NULL,
  stage                TEXT NOT NULL,
  occurred_on          TEXT NOT NULL,
  interviewer          TEXT,
  questions            TEXT,   -- JSON array
  technical_topics     TEXT,   -- JSON array
  behavioral_topics    TEXT,   -- JSON array
  answer_quality       INTEGER, -- 1-5 self-rating
  uncertainty_areas    TEXT,
  comp_discussed       INTEGER NOT NULL DEFAULT 0,
  comp_i_requested     INTEGER,
  comp_they_stated_min INTEGER,
  comp_they_stated_max INTEGER,
  signals              TEXT,
  result               TEXT,
  result_reason        TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interviews_company ON interviews(company);
CREATE INDEX IF NOT EXISTS idx_interviews_job     ON interviews(job_id);

-- One row per pipeline run, for operational visibility and funnel math.
-- Application mail that has been seen, and what was done about it.
--
-- Every row is kept, including the ones that resolved to nothing. An email
-- that could not be matched is the review queue; an email that was matched is
-- the audit trail for a status change nobody made by hand.
CREATE TABLE IF NOT EXISTS email_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     TEXT NOT NULL UNIQUE,
  source         TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  -- Comma-separated kinds from classifyEmail. More than one means ambiguous.
  kinds          TEXT NOT NULL,
  evidence       TEXT,
  -- matched | ambiguous | unmatched | ignored
  resolution     TEXT NOT NULL,
  job_id         TEXT,
  -- Status this email caused, or NULL when it caused none.
  applied_status TEXT,
  note           TEXT,
  seen_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_events_job ON email_events(job_id);
CREATE INDEX IF NOT EXISTS idx_email_events_res ON email_events(resolution);

-- One row per employer board (greenhouse:acme, lever:acme, ..., or bare
-- provider name for a single-feed source), updated once per ingest run.
--
-- Freshness/parking key on this table rather than on jobs.last_seen alone
-- because a board that succeeds but returns zero jobs (a legitimate empty
-- catalogue) must be told apart from a board that failed outright - and
-- last_seen on the jobs table cannot make that distinction, since neither
-- case touches any job row. succeeded_at only ever advances on a successful
-- attempt, so a board that is currently failing keeps its own old high-water
-- mark and nothing on it looks freshly closed.
CREATE TABLE IF NOT EXISTS board_sweeps (
  board_id     TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  status       TEXT NOT NULL,  -- 'ok' | 'failed'
  job_count    INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT NOT NULL,
  succeeded_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats_json  TEXT,
  ok          INTEGER NOT NULL DEFAULT 1
);

-- JOB-52. One row per PAID MODEL ATTEMPT, written at the request seam - the
-- instant client.messages.create()/.stream().finalMessage() returns - before
-- any semantic validation (refusal/truncation/JSON-parse/schema checks) can
-- throw and discard the fact that a billed call happened. See
-- src/db/receipts.ts.
--
-- Purely additive and NOT summed into runs.stats_json anywhere: this is the
-- receipt of a call, not a substitute for the per-run summary the "spend"
-- command reads. No backfill, deliberately - legacy runs correctly have zero
-- receipts here.
CREATE TABLE IF NOT EXISTS model_receipts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  job_id             TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  purpose            TEXT NOT NULL,   -- 'analyze' | 'apply-dossier' | 'apply-pack' | 'tailor' | 'import' | 'benchmark'
  model              TEXT NOT NULL,
  tier               TEXT,            -- 'triage' | 'full' | NULL
  attempt            INTEGER NOT NULL DEFAULT 1,
  usage_known        INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  -- 'success' | 'refusal' | 'truncated' | 'invalid_json' | 'schema' | 'api_error' | 'unknown'
  -- Reuses classifyAnalysisFailure's vocabulary (src/analysis/failures.ts),
  -- with its 'api' kind renamed to 'api_error' here for clarity against a
  -- column that also has to say 'success'.
  validation_outcome   TEXT NOT NULL,
  estimated_price_usd  REAL NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_run     ON model_receipts(run_id);
CREATE INDEX IF NOT EXISTS idx_receipts_job     ON model_receipts(job_id);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON model_receipts(created_at);
`;

export const SCHEMA_VERSION = "1";
