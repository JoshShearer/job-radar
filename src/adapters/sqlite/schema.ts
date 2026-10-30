/**
 * The schema, as an ordered list of migrations. Each runs once, inside a
 * transaction with its own completion record, so an interrupted migration
 * leaves no trace and is retried whole.
 *
 * Three kinds of table, never mixed:
 *
 *   FACTS        append-only (rows are inserted, never updated or deleted)
 *                blob, posting_version, sweep, pursuit_event, application,
 *                application_event, void_event, override_event, model_call,
 *                mail_message, mail_scan, artifact, artifact_approval,
 *                config_version, interview, run
 *   DERIVATIONS  memoized results of expensive pure functions, keyed by a
 *                hash of their exact inputs: derivation, derivation_use,
 *                assessment_failure
 *   INDEXES      maintained alongside the facts for lookup speed and fully
 *                reconstructible from them: alias, opportunity, ranking,
 *                evaluation
 *
 * Exceptions to "never updated", each because the row is a ledger entry with a
 * two-phase lifecycle: run (finished_at/outcome), model_call (settled), sweep
 * and mail_scan (finished). Their first write records that something started;
 * the second records how it ended.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE run (
  id          INTEGER PRIMARY KEY,
  command     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT NOT NULL DEFAULT 'running',  -- running | ok | degraded | refused | failed
  result_json TEXT,
  error       TEXT
);
CREATE INDEX run_command ON run(command, started_at);

-- Raw provider payloads, content-addressed. Stored once however often seen.
CREATE TABLE blob (hash TEXT PRIMARY KEY, body TEXT NOT NULL);

CREATE TABLE sweep (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER REFERENCES run(id),
  board_id    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | complete | failed
  job_count   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX sweep_board ON sweep(board_id, status, started_at);

-- A new row whenever a posting's payload differs from its previous version.
CREATE TABLE posting_version (
  id            INTEGER PRIMARY KEY,
  board_id      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  payload_hash  TEXT NOT NULL REFERENCES blob(hash),
  observed_at   TEXT NOT NULL,
  sweep_id      INTEGER REFERENCES sweep(id)
);
CREATE INDEX posting_version_alias ON posting_version(board_id, external_id, id);

-- INDEX: one row per opportunity, keys for resolution.
CREATE TABLE opportunity (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  company      TEXT NOT NULL,
  title        TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  content_key  TEXT,
  group_key    TEXT NOT NULL
);
CREATE INDEX opportunity_dedupe ON opportunity(dedupe_key);
CREATE INDEX opportunity_content ON opportunity(content_key);
CREATE INDEX opportunity_group ON opportunity(group_key);

-- INDEX: every (board, external id) an opportunity was seen as. Never deleted.
CREATE TABLE alias (
  board_id        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  opportunity_id  TEXT NOT NULL REFERENCES opportunity(id),
  provider        TEXT NOT NULL,
  url             TEXT NOT NULL,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  resolved_how    TEXT NOT NULL,
  -- memo of the normalized snapshot; valid only while snapshot_key matches
  snapshot_key    TEXT,
  snapshot_json   TEXT,
  PRIMARY KEY (board_id, external_id)
);
CREATE INDEX alias_opportunity ON alias(opportunity_id);

CREATE TABLE pursuit_event (
  id             INTEGER PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  to_state       TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  actor          TEXT NOT NULL,
  note           TEXT,
  run_id         INTEGER
);
CREATE INDEX pursuit_event_opp ON pursuit_event(opportunity_id);

CREATE TABLE application (
  id             TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunity(id),
  submitted_at   TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  note           TEXT
);
CREATE INDEX application_opp ON application(opportunity_id);

CREATE TABLE application_event (
  id              INTEGER PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES application(id),
  to_state        TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  actor           TEXT NOT NULL,
  note            TEXT,
  mail_message_id TEXT,
  run_id          INTEGER
);
CREATE INDEX application_event_app ON application_event(application_id);

CREATE TABLE void_event (
  id           INTEGER PRIMARY KEY,
  target_table TEXT NOT NULL,   -- pursuit_event | application_event
  target_id    INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

-- A human overruling a gate (closed posting, unendorsed verdict). Auditable.
CREATE TABLE override_event (
  id             INTEGER PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  gate           TEXT NOT NULL,
  detail         TEXT,
  recorded_at    TEXT NOT NULL,
  run_id         INTEGER
);

-- Every paid call: reserved before it is made, settled after.
CREATE TABLE model_call (
  id                 INTEGER PRIMARY KEY,
  run_id             INTEGER,
  purpose            TEXT NOT NULL,
  subject_id         TEXT,
  request_key        TEXT NOT NULL,
  model              TEXT NOT NULL,
  effort             TEXT NOT NULL,
  reserved_usd       REAL NOT NULL,
  status             TEXT NOT NULL,   -- reserved | settled
  outcome            TEXT,            -- success | refusal | truncated | invalid_json | schema | api_error
  usage_known        INTEGER,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  actual_usd         REAL,
  error              TEXT,
  created_at         TEXT NOT NULL,
  settled_at         TEXT
);
CREATE INDEX model_call_created ON model_call(created_at);
CREATE INDEX model_call_run ON model_call(run_id);
CREATE INDEX model_call_subject ON model_call(subject_id);

-- Memoized expensive derivations (model outputs), addressed by their inputs.
CREATE TABLE derivation (
  kind          TEXT NOT NULL,
  input_key     TEXT NOT NULL,
  output_json   TEXT NOT NULL,
  model_call_id INTEGER REFERENCES model_call(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (kind, input_key)
);

-- Which subject asked for which derivation, so "a stale one exists" is answerable.
CREATE TABLE derivation_use (
  kind       TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  input_key  TEXT NOT NULL,
  at         TEXT NOT NULL,
  PRIMARY KEY (kind, subject_id, input_key)
);
CREATE INDEX derivation_use_subject ON derivation_use(subject_id);

-- Failed attempts per INPUT: a changed posting gets fresh attempts by construction.
CREATE TABLE assessment_failure (
  id             INTEGER PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  input_key      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  counts         INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  at             TEXT NOT NULL
);
CREATE INDEX assessment_failure_key ON assessment_failure(input_key);

CREATE TABLE artifact (
  id               TEXT PRIMARY KEY,
  opportunity_id   TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- resume | pack
  plan_key         TEXT NOT NULL,
  posting_material TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  dir              TEXT NOT NULL,
  manifest_json    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  run_id           INTEGER
);
CREATE INDEX artifact_opp ON artifact(opportunity_id, kind, created_at);

CREATE TABLE artifact_approval (
  id          INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  approved_at TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE mail_scan (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER,
  mailbox     TEXT NOT NULL,
  query       TEXT NOT NULL,
  range_from  TEXT NOT NULL,
  range_to    TEXT NOT NULL,
  status      TEXT NOT NULL,   -- running | complete | partial | failed
  pages       INTEGER NOT NULL DEFAULT 0,
  messages    INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  error       TEXT
);
CREATE INDEX mail_scan_box ON mail_scan(mailbox, status, range_to);

CREATE TABLE mail_message (
  message_id     TEXT PRIMARY KEY,
  mailbox        TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  kinds          TEXT NOT NULL,
  evidence       TEXT,
  resolution     TEXT NOT NULL,   -- applied | refused | matched | ambiguous | unmatched | ignored
  application_id TEXT,
  note           TEXT,
  observed_at    TEXT NOT NULL,
  run_id         INTEGER
);
CREATE INDEX mail_message_app ON mail_message(application_id);
CREATE INDEX mail_message_res ON mail_message(resolution);

CREATE TABLE config_version (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  body_json  TEXT NOT NULL,
  first_seen TEXT NOT NULL
);

CREATE TABLE interview (
  id             INTEGER PRIMARY KEY,
  application_id TEXT,
  company        TEXT NOT NULL,
  role           TEXT NOT NULL,
  stage          TEXT NOT NULL,
  occurred_on    TEXT NOT NULL,
  questions_json TEXT NOT NULL DEFAULT '[]',
  topics_json    TEXT NOT NULL DEFAULT '[]',
  self_rating    INTEGER,
  comp_discussed INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  recorded_at    TEXT NOT NULL
);

-- READ MODEL: rebuilt in full by every evaluation, in one transaction.
CREATE TABLE ranking (
  opportunity_id TEXT PRIMARY KEY,
  company        TEXT NOT NULL,
  title          TEXT NOT NULL,
  location       TEXT NOT NULL,
  remote_status  TEXT NOT NULL,
  date_posted    TEXT,
  lane           TEXT NOT NULL,
  eligible       INTEGER NOT NULL,
  evergreen      INTEGER NOT NULL,
  posting_state  TEXT NOT NULL,
  pursuit_state  TEXT NOT NULL,
  raw_fit        REAL NOT NULL,
  raw_roi        REAL NOT NULL,
  raw_priority   TEXT NOT NULL,
  proj_fit       REAL,
  proj_roi       REAL,
  analyst_fit    REAL,
  analyst_roi    REAL,
  analyst_rec    TEXT,
  analyst_tier   TEXT,
  stale_assessment INTEGER NOT NULL DEFAULT 0,
  fit            REAL NOT NULL,
  roi            REAL NOT NULL,
  priority       TEXT NOT NULL,
  confidence     TEXT NOT NULL,
  comp_band      TEXT NOT NULL,
  detail_json    TEXT NOT NULL,
  evaluated_at   TEXT NOT NULL
);
CREATE INDEX ranking_order ON ranking(eligible, roi DESC, fit DESC);

CREATE TABLE evaluation (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER,
  at               TEXT NOT NULL,
  policy_version   TEXT NOT NULL,
  calibration_json TEXT NOT NULL,
  summary_json     TEXT NOT NULL
);
`,
  },
  {
    // Which ModelClient made each paid call, so spend can label subscription
    // (claude-cli, list-price equivalent) apart from API dollars, including in
    // mixed history. Written once at reservation; NULL is a receipt from before
    // provider tracking, when only the api existed.
    version: 2,
    name: "model_call_provider",
    sql: `ALTER TABLE model_call ADD COLUMN provider TEXT;`,
  },
];
