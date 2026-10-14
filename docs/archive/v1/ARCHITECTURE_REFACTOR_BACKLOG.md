# Architecture Refactor Backlog - 2026-08-24

Implementation-ready work items from `docs/ARCHITECTURE_AUDIT.md`. Ordered within each
priority by leverage per hour. Evidence references are to the audit document's findings
(P0-1 etc.) and to measured data as of 2026-08-24.

Priorities: **P0** product failure · **P1** major architectural problem ·
**P2** important improvement · **P3** optimization/hygiene.

---

## P0 - close the outcome loop

### OBS-001 - Backfill and switch on the inbox outcome loop
**Priority:** P0 · **Problem:** `email_events` has 0 rows while 43 applications are in
flight; the one inbox run (2026-08-20) found 2 valid transitions and discarded them
because `--apply` defaults off. Every funnel outcome metric is a null measurement.
**Evidence:** P0-1; `runs` stats `{"fetched":5,"transitioned":2}`.
**Change:** Configure the Gmail env vars (or `inbox.eml_dir`); run
`inbox --all --apply` once to backfill history.
**Components:** none (operational).
**Acceptance:** `SELECT COUNT(*) FROM email_events` > 0; the 2 known transitions
applied; `stats` funnel reflects real outcome data.
**Tests:** existing inbox tests already cover the mechanics.

### OBS-002 - Invert the inbox default: write by default, `--dry-run` to preview
**Priority:** P0 · **Problem:** a read-only-on-the-mailbox scanner whose *local* writes
default off makes silent data loss the happy path; the only real run proved it.
**Change:** `--apply` becomes default-true; add `--dry-run`; keep the mailbox itself
strictly read-only (unchanged).
**Components:** `src/cli.ts` (inbox command).
**Acceptance:** bare `inbox` persists events; `inbox --dry-run` writes nothing and says
so; help text updated.
**Tests:** CLI flag test; scan invoked with apply=true by default.

### OBS-003 - Add inbox to the daily systemd pass with a failure surface
**Priority:** P0 · **Problem:** outcome capture depends on a human remembering a manual
command (P1-4).
**Change:** add `ExecStart=... cli -- inbox` to `deploy/job-radar-daily.service` (after
the radar pass; skip-with-notice when no mail source configured), extending the existing
failure surface from #44.
**Acceptance:** timer run produces inbox summary in journal; a failing inbox marks the
service run failed without blocking backup/ingest.
**Tests:** manual `systemctl --user start` verification documented in the PR.

### MATCH-001 - Gate the apply path on analysis verdict
**Priority:** P0 · **Problem:** 27/43 submitted applications lacked an "apply" verdict
(16 network_or_watch, 11 never analyzed). `src/cli.ts:260` warns and proceeds.
**Change:** `resume tailor`, `apply`, `autofill` refuse when the job has no analysis or
verdict is not apply/apply_and_outreach, unless `--override <reason>` is given; the
reason is persisted (see OBS-005).
**Components:** `src/cli.ts`, shared gate helper (new, ~40 lines).
**Acceptance:** ungated prepare on a watch/skip/unanalyzed job exits non-zero with the
verdict quoted; `--override "reason"` proceeds and records; existing chains documented.
**Tests:** fixtures for each refused case + override path.

### MATCH-002 - Freshness gate at prepare time
**Priority:** P0 · **Problem:** 24/43 applications went to postings >45 days old (mean
250d). `evergreen_days` exists in config and is consulted by the briefing but not by the
apply path.
**Change:** same gate helper: posting age > `scoring.evergreen_days` requires
`--stale-ok` (flag already exists in freshness vocabulary); age printed in every
prepare summary.
**Acceptance:** stale prepare refused without flag; age visible in `apply`/`tailor`
output and in the decision record.
**Tests:** fixture posting with old date_posted; refusal + override.

---

## P1 - portfolio discipline and blind spots

### DISCOVERY-001 - Portfolio caps
**Priority:** P1 · **Problem:** 4x Samsara and 4x Customer.io applications within days;
22 companies for 43 applications; no aggregate constraint exists anywhere.
**Change:** config block (`portfolio:`) with `max_apps_per_company_per_14d` (default 2)
and optional per-lane weekly targets; enforced in the gate helper; shown in `daily`.
**Components:** `config/schema.ts`, gate helper, `report/daily.ts`.
**Acceptance:** third application to a company inside the window is refused without
override; daily briefing shows per-company counts for the rolling window.
**Tests:** cap fixture; config validation test.

### DISCOVERY-002 - Cool the discovery pool: mid-market board expansion
**Priority:** P1 · **Problem:** top-10 companies are 34.5% of the index and are the
highest-competition employers in tech (P1-1); the v1 lesson in `discover.ts` says
exactly this.
**Change:** curate and add 50+ on-lane mid-size employers via `job-radar discover`
(TODO Phase 2 already lists candidates and the missing-ATS watchlist path); tag each
source with a `heat` estimate; surface competition mix of the daily slate.
**Acceptance:** top-10 companies < 25% of new-jobs-last-30d; slate shows mix; sources
command reports per-board yield (mechanism from #43 already exists).
**Tests:** none beyond existing source tests (config change), plus one for slate mix math.

### OBS-004 - Application decision record
**Priority:** P1 · **Problem:** "why did we apply to this job" is currently
unanswerable after the fact; verdict-override behavior (MATCH-001) needs an audit trail.
**Change:** at prepare/submit, append `job_events` row `application_decision` carrying
verdict, fit, posting age, company 14d count, gates passed/overridden + reason.
**Components:** gate helper, `db/repo.ts`.
**Acceptance:** every new APPLIED job has a decision event; `show <id>` prints it.
**Tests:** event written in gate tests; show rendering.

### OBS-005 - Dark-loop alarm
**Priority:** P1 · **Problem:** the system ran 10 days with applications in flight and
zero outcome rows without any banner saying so (P0-1).
**Change:** `stats` and the daily briefing print a warning block when
`APPLIED+ in-flight > 0` and no email_event in 7 days: "outcome loop is dark".
**Acceptance:** warning appears against current DB state until OBS-001 lands; disappears
after.
**Tests:** unit test on the predicate.

### RESUME-001 - Backfill generation stamps for pre-stamp application dirs
**Priority:** P1 · **Problem:** 16/47 dirs lack `generation.json`; a re-run would
silently regenerate and replace potentially submitted documents (P1-3) - the exact
failure reuse was built to prevent.
**Change:** one-off script stamping existing dirs from current file hashes + posting
description_hash (marked `backfilled: true`).
**Acceptance:** 47/47 dirs stamped; `tailor`/`apply` on all existing dirs report
"reused".
**Tests:** reuse tests already cover stamp reading; add backfill-flag tolerance.

### OBS-006 - Verified-submission state from confirmation email
**Priority:** P1 · **Problem:** confirmation emails are classified but produce no
persistent verification (P2-2); the mission's SUBMITTED vs CONFIRMED distinction, done
honestly for a human-submits system.
**Change:** on `confirmation` kind matched to an APPLIED job, set
`application_confirmed_at` (new nullable column) + event; funnel shows
applied-vs-confirmed.
**Components:** `db/schema.ts` migration, `inbox/scan.ts`, `stats/funnel.ts`.
**Acceptance:** confirmation .eml fixture yields confirmed flag; funnel splits the two.
**Tests:** end-to-end eml fixture (see TEST-001).

---

## P2 - learning and structure

### OBS-007 - Per-application spend rollup
**Priority:** P2 · **Problem:** run stats carry cost but not job id as a field; no
`spend --per-application`; historical per-app attribution impossible (P1-2 is permanent;
this stops the bleeding).
**Change:** add `jobId` to tailor/apply run stats; `spend --per-app` joins runs +
analysis_cache by job.
**Acceptance:** new prepared app shows itemized cost; command output documents the
pre-08-19 blind spot.
**Tests:** stats-shape unit test.

### MATCH-003 - Typed required-vs-preferred requirements
**Priority:** P2 · **Problem:** MANDATORY DOMAIN / LEARNABLE TOOL lives as prose inside
`missingRequirements` strings; not queryable, not scoreable (P2-1).
**Change:** extend `AnalysisSchema` with
`requirements: [{skill, kind: required|preferred, evidence: met|partial|missing}]`;
keep prose for humans; cache key already includes profile/model so old cache entries
regenerate naturally on next analysis.
**Acceptance:** new analyses carry the array; a missing-required count is shown in
`top`/`show`; no re-analysis storm (only on natural invalidation or --force).
**Tests:** schema validation fixtures; analyzer contract test.

### OBS-008 - 21-day cohort outcome report
**Priority:** P2 · **Problem:** no mechanism exists to answer "is this working" at the
right time horizon; conclusions get drawn at day 6 (P1-5).
**Change:** `job-radar cohorts`: applications grouped by week, response/screen rates at
21d+, segmented by verdict, posting age bucket, competition, lane; explicit
`insufficient data (n<20 or age<21d)` states instead of percentages.
**Acceptance:** command runs against current data and says "insufficient data" honestly;
first real report due ~2026-09-09 for the Aug 18-19 cohort.
**Tests:** segmentation math unit tests on fixtures.

### MATCH-004 - Calibrate interviewProbability against outcomes
**Priority:** P2 (blocked on OBS-001/008, n>=30) · **Problem:** analyst probabilities
are uncalibrated guesses; `calibration.ts` already solves this for the keyword engine.
**Change:** extend calibration to compare analyst interviewProbability vs realized
response/screen rates by bucket; report only, no auto-adjustment.
**Acceptance:** calibration table in `cohorts` once thresholds met.

### RESUME-002 - Role-archetype resume variants
**Priority:** P2 · **Problem:** every tailor starts from the full master; TODO Phase 2
variant design (Senior Full-Stack, Technical SEO/Growth, AI Product, Proptech/3D) is
unbuilt; variant-level outcome measurement impossible.
**Change:** implement variants as vetted bullet-id subsets + summary per archetype
(data, not prose - provenance still enforced); tailor selects variant then deltas;
record variant in decision record.
**Acceptance:** variant named + explained in tailor output; stored per application;
cohort report can segment by variant.
**Tests:** variant selection unit tests; provenance unaffected (existing tests).

### RESUME-003 - Deterministic keyword-coverage report
**Priority:** P2 · **Problem:** no check that the rendered resume contains the
posting's stated required terms; ATS keyword risk currently unmeasured (audit sec. 6.5).
**Change:** in `resume match` output: % of posting required/preferred terms present in
the rendered document, listing absentees; deterministic string work, no model.
**Acceptance:** report lists coverage; zero API cost.
**Tests:** fixture posting + resume with known coverage.

### COST-001 - Enforce usage logging on every paid call
**Priority:** P2 · **Problem:** the $17-day class of failure (paid calls recording $0)
is prevented by convention, not by code (P1-2).
**Change:** wrap the Anthropic client call sites in a helper that throws (or loudly
flags the run) when a response carries no usage; run stats always include tokens.
**Acceptance:** a stubbed usage-less response fails the run visibly.
**Tests:** unit test on the wrapper.

### TEST-001 - Regression corpus: gates and inbox end-to-end
**Priority:** P2 · **Change:** `tests/fixtures/jobs/` corpus (>=10): apply-verdict,
watch-verdict, unanalyzed, stale-evergreen, over-company-cap, missing-required-skill,
salary-below-floor, clearance-blocked, duplicate, confirmation-email; plus an
`.eml` directory fixture driving inbox -> email_events -> status -> funnel.
**Acceptance:** corpus asserted in CI; same inputs keep producing same decisions.

---

## P3 - hygiene and optional optimization

### COST-002 - Sonnet-5 dossier agreement benchmark
**Priority:** P3 · **Problem:** all paid calls run Opus-5; a ~40% analysis cost cut is
available if a cheaper model reaches the same apply-vs-not verdicts. The triage
benchmark (`analysis/benchmark.ts`, JOB-31 gate) is the exact pattern: measure
agreement before switching, and respect its precedent that a failed benchmark blocks
the switch.
**Acceptance:** benchmark report committed; switch only on agreement >= the JOB-31
threshold. Note: at ~$5/month current analysis spend this is optional until volume grows.

### ARCH-001 - Delete strays
**Priority:** P3 · **Change:** remove empty `data/jobs.db`; move
`config/personal.yaml.*.bak` (13 files) into `data/backups/` and teach whatever writes
them to back up there instead.
**Acceptance:** config dir contains only live config + examples.

### ARCH-002 - Documentation drift
**Priority:** P3 · **Change:** README still lists RemoteOK as active (retired #43);
add the outcome-loop and gate behavior to README once P0 lands; decide whether
`src/sources/remoteok.ts` is deleted or kept dormant (if deleted, the attribution
requirement dies with it - per CLAUDE.md it must never be re-enabled without
attribution).
**Acceptance:** README matches `sources.yaml` reality.

### DISCOVERY-003 - `discover --add` writes config directly
**Priority:** P3 · TODO Phase 2 item, unchanged. Reduces the cost of DISCOVERY-002
curation.

---

## Explicitly rejected (from the mission brief, with reasons)

- **Queue/worker architecture:** single-user local CLI on a hardened systemd timer;
  a queue adds failure modes, not reliability, at this scale.
- **New application state machine:** one exists (`model/status.ts`, 15 states, guarded
  transitions, event-logged). OBS-006 extends it; nothing replaces it.
- **Centralized `prompts/` registry:** prompts live in dedicated modules beside their
  schemas and are content-addressed into the cache key (model + profile versioned).
  Moving files is cosmetics, not architecture.
- **Embedding/vector reuse:** nothing in the measured cost profile justifies it;
  analysis is $0.044/job and cached.
- **Auto-submission + browser verification:** never. CLAUDE.md non-negotiable; the
  refusal harness is the most valuable test in the suite. Verification is OBS-006.
- **Wholesale resume-generation redesign:** the provenance architecture is the
  strongest subsystem in the codebase and already matches the mission's target design.
