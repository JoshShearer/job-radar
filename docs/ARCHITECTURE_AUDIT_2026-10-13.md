# Architecture audit and greenfield target - 2026-10-13

**Baseline:** `0c706fc` (main). **Method:** source-level read of every layer, plus targeted probes run against the real modules under `tsx`. No production database was available in this checkout (`data/` is absent), so nothing here is a measurement of live data.

## 1. Verdict

The product thinking is good and the structural design is poor. They should be judged separately.

The domain rules (determinism boundary, never submit, refusals, nullable unknowns, spend bounded directly, selection-not-generation resumes) are sound and worth keeping verbatim. The structure that carries them is not. It grew by accretion around one mutable table and one large CLI file, and almost every recent change is a patch for an invariant the structure cannot hold on its own. Commits #57 to #66 are all of that kind, and each one added columns, hashes or comments rather than removing a cause. One of them left `main` red (section 3.1).

The two previous reviews (2026-08-24, 2026-09-25) concluded "keep the monolith, fix seams." I agree with the deployment shape (local, single process, SQLite, human-operated browser). I disagree that the remaining problems are seams. The root cause is the data model: facts, derived values, cached model output and human decisions all live as overwritable columns on one `jobs` row. Every class of bug found in three reviews follows from that.

## 2. What is genuinely good (keep in any rebuild)

| Asset | Why it is worth keeping |
|---|---|
| Deterministic parsers: `lib/salary.ts`, `lib/location.ts`, `lib/seniority.ts`, `pipeline/dedupe.ts` | Heavily tested, pure, encode hard-won edge cases |
| `apply/fields.ts` (`decide`, `chooseOption`) | Pure form-answer policy, refusals expressed as data, exact-match tie rule |
| `resume/requirements.ts` | Three-state covered/partial/gap with independent qualifiers |
| Source payload pinning tests, browser refusal harness | Contract tests at the two external boundaries that matter |
| `model/freshness.ts` `planParking` | Pure, guarded, per-board |
| The written domain rules in `CLAUDE.md` / `CONTEXT.md` | The requirements are clear; the implementation is what drifted |

## 3. Defects found in this pass (demonstrated or code-confirmed)

### 3.1 `main` is red, and the gate did not stop two merges

`npm run test:unit`: **2 failed / 1,026 passed**, both in `tests/board-sweeps.test.ts`. Typecheck passes.

Cause: the test freezes `NOW = 2026-09-26` for fixture rows, but `JobRepo.recordBoardSweep` stamps `succeeded_at` with the real clock (`nowIso()`). Once the wall clock passed NOW + 3 days (2026-09-29), the "fresh" fixture job also looks stale, the board's park fraction becomes 100%, and parking is refused. #67 (2026-09-30) and #68 (2026-10-08) merged after that.

This is a test bug, but it points at a design defect: the persistence layer reads the wall clock directly (33 `nowIso()` / `new Date()` call sites in `src/`), so no time-dependent behavior can be tested deterministically end to end.

### 3.2 Resume provenance is a deny-list, so overreach passes

`checkRewrite` (`src/resume/provenance.ts:46`) only flags technologies from a fixed list of about 55 terms and numbers written as digits. I ran it against overreaching rewrites:

| Source bullet | Rewrite | Result |
|---|---|---|
| Built a Next.js marketplace | Led and mentored a team building a Vue, Svelte and Angular marketplace | **passes** |
| Contributed to the checkout flow | Owned and architected the company-wide payments platform end to end | **passes** |
| Senior engineer | Staff engineer and engineering manager with deep distributed-systems and Kafka-scale expertise | **passes** (even though `kafka` is on the list) |
| Ran SEO experiments | Ran two hundred SEO experiments, increasing revenue by forty percent | **passes** |
| Built a Next.js marketplace | Led a 12-person team ... | caught (digit only) |

The same check guards the free-text headline and summary. `CLAUDE.md` says a rewrite that introduces a technology or a number is reverted; in practice only listed technologies and digit-form numbers are, and scope promotion ("contributed" to "owned", "led") is not checked at all.

### 3.3 The text that actually reaches employers has no provenance check

`apply` asks a model for a cover note and form answers (`src/analysis/prepare.ts`). That prose is rendered to a PDF the autofill attaches, and `matchPreparedAnswer` types it into employer forms (`src/apply/autofill.ts:959`). Nothing verifies it against the master resume. The only protection is a prompt instruction, and the facts in that prompt are not the master resume (3.4). The resume, which is checked, is the lower-risk artifact.

### 3.4 Candidate facts have four homes, and one is hardcoded TypeScript

- `src/analysis/prompt.ts:15` hardcodes the candidate's skills, "verified accomplishments", degree, and pronouns inside `buildSystemPrompt`. Analysis and the application pack both use it.
- `src/model/job.ts:128` hardcodes "against a $160-180k base target" into the analysis schema description sent to the model, while the real bands live in config.
- `config/career-profile.yaml` `identity`, `config/personal.yaml`, and `config/resume.yaml` each hold another slice.

Correcting a claim in `resume.yaml` does not change what the analyst or the pack writer is told. This directly contradicts "`config/resume.yaml` is the only source of resume fact."

### 3.5 GHOSTED is set automatically, contrary to code comments and README

`src/model/status.ts:120` says "Nothing sets GHOSTED automatically." The README says the briefing "still waits for you to confirm it." But `daily` writes GHOSTED unattended (`src/cli.ts:1215`) for any APPLIED/CONTACTED job silent for 30 days, measured from `email_events`.

The installed timer never runs `inbox` (`deploy/job-radar-daily.service`). So the sweep infers silence from a mailbox nobody is reading and writes a terminal outcome into the funnel that the funnel then treats as evidence. This is the same "inference from absence without observer health" class as the board-parking bug that JOB-50 fixed, in a second place.

### 3.6 Spend: two ledgers, the daily path is invisible, and the ceiling is per run

- `spend` reads `runs.stats_json.estimatedCostUsd` (`src/db/repo.ts:1356`). The per-call `model_receipts` table added in JOB-52 is not read by it.
- `daily --analyze` returns `{ jobCount, file, htmlFile, dashFile }` (`src/cli.ts:1292`), so the unattended paid pass records **no spend** in the ledger `spend` reads.
- The budget is checked once per job (`src/analysis/analyzer.ts:439`), not between triage and the dossier it triggers (`:463-469`), and only within one process run. There is no daily or monthly ceiling: three manual `analyze` runs spend three ceilings.

### 3.7 Rate limiting can be configured to zero

`CLAUDE.md` and README say `PoliteFetcher` "cannot be configured to zero delay." `config/schema.ts:188` declares `delay_ms: z.number().int().nonnegative()`, and the constructor spreads it unchecked. `delay_ms: 0` is accepted.

### 3.8 Still-open items from the 2026-09-25 review

| Item | State at `0c706fc` |
|---|---|
| `withRepo` calls `fn()` before `Promise.resolve`, so a synchronous throw skips run finalization (`src/cli.ts:108`) | Open |
| Mail cursor: one Gmail page (`maxResults` 100, no `nextPageToken`), next scan starts at `MAX(received_at)` | Open; backlog past one page can be skipped forever |
| Stamp written before artifacts; PDF failure leaves an older PDF beside a newer plan | Open |
| Priority thresholds duplicated in `score.ts:304` and `rescore.ts:172`, in code not config | Open |
| Candidate evidence in prompts (A13) | Open, see 3.4 |
| Budget between triage and dossier (A08) | Open, see 3.6 |

## 4. Structural root causes

These explain why the defects above keep appearing and why fixing them one at a time has not converged.

### R-A. One mutable row holds four different kinds of data

`jobs` has about 70 columns mixing:

1. **Observations** (title, description, salary, `last_seen`) overwritten on every ingest.
2. **Derived values** (`fit_score`, `application_roi`, `priority`, `lane`) overwritten on every scoring run.
3. **Cached model output** (`analysis_json` plus five snapshot hashes) attached by hand.
4. **Human decisions** (`status`, `notes`).

Consequences seen in the code:

- `fit_score` means three different things depending on `score_confidence`: raw keyword score, a calibration projection, or a 70/30 blend with the analyst (`rescore.ts`). `CONTEXT.md` defines "fit score" as the deterministic score; the column often is not.
- History is a side channel (`job_events`) that every write path must remember to maintain. JOB-47 existed because several did not.
- Staleness has to be bolted on per field: JOB-51 added five snapshot hash columns plus a SQL re-implementation of the same hashes.
- `runScoring` loads every row and rewrites every row, one autocommitted `UPDATE` each, outside a transaction (`rescore.ts:141`). A crash mid-run leaves a ranking that is half old, half new.

### R-B. Identity and invalidation are reinvented per feature

Counting the mechanisms that answer "is this derived thing still about the current input?":

| Mechanism | Used for | Defined in |
|---|---|---|
| `description_hash` (bytes) | events, document reuse stamps | normalize, `apply/reuse.ts` |
| `material_hash` (token multiset) | analysis invalidation | `lib/hash.ts` |
| `evidenceVersion` (12 chars of system prompt + stable note) | cache key | `analyzer.ts:185` |
| `evidenceHash` (system prompt only) | attached-analysis staleness | `identity.ts:106` |
| 5 identity hashes, in TypeScript | staleness on read | `identity.ts` |
| The same 5 hashes, re-implemented in SQL | eligibility | `repo.ts:71` |
| Cache key with raw title + company + 3 of the 5 hashes | cache lookup | `repo.ts:1534` |
| `isTriageOnly` = `interviewProbability === null` | tier detection | `model/job.ts` |

Eight overlapping schemes, two of which must stay byte-for-byte equivalent across languages. Documents are invalidated on byte changes while analyses are invalidated on material changes, so the same posting edit regenerates one and not the other.

### R-C. Status conflates three state machines

`STATUSES` mixes the **posting lifecycle** (CLOSED, inferred by a sweep), the candidate's **pursuit** of a posting (NEW, REVIEWED, SAVED, SKIPPED), and a submitted **application's outcome** (APPLIED, SCREEN, INTERVIEW, REJECTED, GHOSTED). That is why parking needs an allowlist, why `upsert` contains `CASE WHEN status = 'CLOSED' THEN 'NEW'`, why a closed posting that you applied to cannot be represented as both, and why funnel math needs `stagesReached` guesses for terminal states.

### R-D. Workflows live in command bodies, gates are called by convention

`src/cli.ts` (2,433 lines) is the application layer. `resume tailor` alone sequences: lint, closed-posting gate, endorsement gate (which may itself buy a dossier), deterministic match, reuse decision, model call, composition, five unatomic file writes, stamp, PDF, and run stats. Safety gates such as `refuseIfClosed` and `refuseIfUnendorsed` are helpers each command must remember to call in the right order. A future web UI would have to duplicate all of it.

### R-E. No dependency direction

`db/repo.ts` imports `analysis/detail.ts` and contains ranking policy, diversity caps, freshness bonuses and benchmark sampling in SQL. `analysis/*`, `pipeline/*`, `resume/*`, `inbox/*` and `report/*` import `JobRepo` directly; `db/receipts.ts` imports `analysis/failures.ts`. There is no pure domain layer, no ports, and no injected clock (3.1).

### R-F. Configuration is organized by file, not by owner

`career-profile.yaml` is 912 lines holding identity facts, compensation preferences, search keywords, scoring weights, parking thresholds, inbox settings, dossier routing and analysis diversity. These change at different rates for different reasons, and derived values do not record which policy version produced them, so "why did this rank change?" has no stored answer.

### R-G. Schemas are written twice

`TailorSchema` (Zod) and `TAILOR_JSON_SCHEMA` are hand-maintained in parallel (`resume/tailor.ts:24,44`), as are `AnalysisSchema` and `buildAnalysisJsonSchema`. Zod 4 can emit JSON Schema directly.

### R-H. Documentation substitutes for mechanism

24% of `src/` lines are comments, much of it ticket history ("JOB-47 PR4: ..."). The README states 489 tests in two places, 902 in another, and "runs offline in under a second" (it takes ~42s and launches Chromium). Invariants are asserted in prose (no zero delay, never auto-GHOSTED, strict ceiling, only one source of fact) and three of them are false today. When a rule matters, it needs to be a type, a constraint, or a test, not a paragraph.

## 5. Greenfield target architecture

Assumptions: same product, same single user, same legal and ethical rules, a fresh codebase.

### 5.1 Shape: unchanged where it was right

- Local-first, single process, TypeScript on Node (Playwright and the Anthropic SDK are first-class there).
- SQLite as the only database. No server, queue, broker or cloud worker; the workload is thousands of rows a day.
- Entry points: CLI, a systemd timer, and a loopback-only local web UI. All three call the same application services.

### 5.2 Style: functional core, append-only facts, memoized derivations

Three kinds of data, kept in different tables and never mixed:

| Kind | Rule | Examples |
|---|---|---|
| **Facts** | Append-only, never updated | posting observations, sweep coverage, mail observations, human decisions, model calls, artifact generations, evidence versions |
| **Derivations** | Pure function of facts + a versioned policy; stored only as memoized results keyed by input hash | normalization, eligibility, score, rank, LLM assessment, priority |
| **Read models** | Disposable, rebuilt from the two above | briefing, dashboard, ranked list |

The single most important mechanism is a **derivation store**:

```
derivation(kind, subject_id, fn_version, input_hash) -> output_json, created_at
```

- `input_hash` is computed in exactly one place per derivation kind, from a canonical serialization of every input the function reads (posting snapshot, candidate evidence version, policy version).
- "Current value" = the row whose `input_hash` matches the current inputs. Staleness is not a feature anyone implements; it falls out of the lookup.
- The paid LLM assessment is just an expensive derivation. The analysis cache, the attached analysis, the freshness check and invalidation all collapse into this one mechanism, replacing the eight in R-B.
- Changing calibration does not change an assessment's inputs, so it never re-buys one. Changing the posting materially or the evidence does.
- Every displayed number can answer "computed by which function version, from which inputs."

### 5.3 Bounded contexts

```
                    +-------------------+
 timer / CLI / UI ->| Application layer |  use cases, gates, transactions
                    +---------+---------+
                              |
   +-----------+-----------+--+--------+-----------+-----------+
   | Sourcing  | Catalog   | Evaluation| Candidate | Materials |
   | Outcomes  | Pursuit   | (pure domain modules, no I/O)     |
   +-----------+-----------+-----------+-----------+-----------+
                              |
        ports: Clock, Store, ModelGateway, Transport, Browser, Mailbox
                              |
   adapters: SQLite, Anthropic, PoliteTransport, Playwright, Gmail/.eml, ATS
```

1. **Sourcing.** ATS adapters return raw postings. A transport port enforces a minimum delay in its type (`delayMs >= 500`, not configurable lower), `Retry-After` including HTTP dates, and one limiter per host shared process-wide. Every sweep writes a **coverage record**: board, window, complete/partial/failed, count.
2. **Catalog.** Pure normalization (carry over the current parsers). Opportunity resolution keeps every alias (source, external id, URL) and is versioned. Posting lifecycle (open, presumed closed, reopened) is derived from coverage records only. Absence can only be inferred over a window with complete coverage.
3. **Evaluation.** Eligibility rules, deterministic score, rank, calibration and the LLM assessment as derivations. Policy (weights, thresholds, priority bands, dossier routing) is a versioned config object. Raw score, calibrated projection and analyst score are three separate fields, never one column with three meanings.
4. **Candidate.** One **evidence ledger**: every claim has an id, text, `verified`, skills, and explicit scope qualifiers (led, owned, contributed, used, scale, OSS). Preferences (compensation, location) and personal facts (nullable unknowns) are separate files. Every prompt that mentions the candidate is rendered from the ledger, so correcting a claim changes every future output. Nothing about the candidate lives in code.
5. **Materials.** Every outbound document (resume, cover letter, form answers, outreach) is a structured composition of **claim-cited segments**: `{ text, cites: [claimId...] }`. A verifier runs on all of it, not just resume bullets, and it is allowlist-based: technologies, numbers (including spelled-out ones), and scope verbs in a segment must appear in the cited claims, or the segment reverts to the claim's own wording. Text that cannot be verified (for example a cover-note opener) is marked unverified and shown for human approval. Artifacts are immutable, content-addressed generations with a manifest row in SQLite, published atomically; a human approval is a fact recorded against a specific generation hash.
6. **Pursuit and Application.** Separate the three state machines from R-C:
   - Posting lifecycle (machine-derived, Catalog).
   - Pursuit per opportunity: `new -> reviewed -> shortlisted -> preparing -> skipped`. Human-owned.
   - Application, created only when the human says they submitted: `submitted -> screen -> interview -> final -> offer | rejected | withdrawn | ghosted`. State is a fold over transition events with a defined chronological rule (event time, late events cannot regress a terminal state).
7. **Outcomes.** Mail ingestion with a persisted cursor per mailbox range, full pagination, idempotent message ids, and coverage records. The classifier and matcher stay deterministic; ambiguity goes to a review queue. "Ghosted" is a **suggestion** derived from silence over a window the mailbox coverage actually spans, never written automatically. If inbox coverage is stale, the briefing says the funnel is unobserved instead of silent.
8. **Model gateway.** The only code that talks to a paid API. Every call: purpose, subject, prompt template id and version, schema (one Zod definition, JSON Schema generated from it), max tokens. Before the call it **reserves** the worst-case cost against run, daily and monthly budgets; after it, it settles the actual usage into one ledger, including refusals, truncations and validation failures. `spend` and the dashboard read only this ledger.
9. **Browser assist.** Keep the pure decision policy (`fields.ts`) as a domain module; the Playwright driver is an adapter. Refusals (no submit, no checkbox, no attestation, no demographics, no default for unknown) stay pure functions with exhaustive tests plus the real-browser harness.

### 5.4 Application layer

One module per use case: `sweep`, `evaluate`, `assess`, `prepareApplication`, `fillForm`, `recordSubmission`, `ingestMail`, `buildBriefing`. Each returns a typed result (`ok | degraded | refused | failed`) and owns its ordering, transaction and gates. Gates are declared in the use case, not remembered by callers:

```
prepareApplication(opportunityId, { override }):
  require  postingOpen(coverage)        or refused("closed")
  require  assessmentCurrent(endorsed)  or refused("unendorsed")   // override recorded as a fact
  reserve  budget(purpose: "pack")
  compose  from evidence ledger -> verify -> publish generation
  record   pursuit transition
```

Commands, the timer and the web UI become thin adapters that parse input and print results.

### 5.5 Data model sketch

```
-- facts
posting_observation(id, board_id, external_id, observed_at, payload_hash, snapshot_json)
sweep_coverage(id, board_id, started_at, finished_at, status, job_count)
opportunity(id, created_at)            opportunity_alias(opportunity_id, board_id, external_id, url)
mail_observation(message_id, mailbox, received_at, ...)   mailbox_coverage(mailbox, from, to, status)
decision_event(id, subject_type, subject_id, kind, payload_json, actor, at)   -- human and machine transitions
model_call(id, purpose, subject_id, template, model, reserved_usd, actual_usage_json, outcome, at)
artifact_generation(id, opportunity_id, kind, content_hash, inputs_hash, path, approved_at)
evidence_version(id, content_hash, at)

-- derivations
derivation(kind, subject_id, fn_version, input_hash, output_json, created_at)
  PRIMARY KEY (kind, subject_id, fn_version, input_hash)

-- read models: views or rebuildable tables, never written by hand
```

Startup migrations stay additive; destructive changes stay behind an explicit command with a verified backup, as today.

### 5.6 Cross-cutting rules, enforced rather than documented

- `Clock` and `IdGenerator` are injected everywhere; no module reads the wall clock.
- Dependency direction is checked in CI (for example `dependency-cruiser`): domain imports nothing from adapters or the application layer.
- Each "never" in `CLAUDE.md` has a test named after it: transport delay floor, no automatic terminal outcome, budget reservation, unverified segment never published unapproved, no submit.
- Schemas are defined once in Zod.
- Comments explain why something non-obvious is true; ticket history lives in git and ADRs.

### 5.7 What not to build

- No distributed workers, queue, or cloud deployment.
- No ORM; typed SQL against SQLite is enough and keeps queries auditable.
- No general event-sourcing framework. Append-only fact tables plus the derivation store give the benefits at this scale without replay infrastructure.
- No model in deterministic paths (unchanged rule).

### 5.8 Testing strategy

- Pure domain modules: unit and property tests (dedupe stability, parser fuzzing, state machine invariants: no regression from terminal states, chronological rule).
- Use cases: run against in-memory SQLite with a fake clock, fake gateway and fake transport, covering refusal, degradation and failure results.
- Golden corpus: about 20 real postings with expected eligibility, rank band and requirement states.
- Adversarial provenance corpus: the rewrites in 3.2 and similar must all be reverted or flagged.
- Boundary contracts: pinned ATS payloads, `.eml` fixtures, and the Chromium refusal harness.

## 6. If this is actually rebuilt

Carry over as libraries, with their tests: the parsers in `lib/`, `pipeline/dedupe.ts`, `resume/requirements.ts`, `apply/fields.ts`, `model/freshness.ts` `planParking`, `inbox/classify.ts` and `inbox/match.ts`, the source adapters' mapping code, and the fixtures. That is roughly a third of the current code and most of the hard-won domain knowledge.

Rewrite: the schema, the repository, the CLI, the analysis orchestration, the prompts (rendered from the evidence ledger), the materials pipeline, and run/spend accounting.

Data migration: posting observations can be reconstructed from current rows plus `job_events`; human decisions from `status_changed` events; model spend from `model_receipts` where present and `runs.stats_json` otherwise, labeled as lower-bound. Existing analyses can be imported as derivations with an unknown input hash, which correctly makes them stale.

Two things are worth doing on the current code regardless of the rebuild decision, because they are small and affect real outcomes now: fix the test clock so `main` is green, and stop `daily` from writing GHOSTED while the timer never runs `inbox`.
