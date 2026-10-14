# Job Radar — architectural review

**Date:** 2026-09-25 · **Baseline:** `0ff450c` · **Companion:** [C4 map](C4_MAP.md)

## Executive assessment

**Keep the local modular monolith. Strengthen its correctness guarantees at module interfaces before adding new features or a writable dashboard.** Node, SQLite, generated reports, and a human-operated browser are appropriate for this workload. Distributed workers, a message broker, or a framework migration would not address the highest-priority problems found here.

The architecture has strong foundations: deterministic qualification, provider adapters, structured model output, separate analysis tiers, reuse of paid documents, explicit human submission, and a real-browser refusal suite. Its weakness is **fragmented ownership of invariants**: callers must remember when to validate, invalidate, record usage, update status, publish files, and re-score.

Several documented guarantees exceed what the implementation currently enforces:

1. Resume provenance permits uncited summary/headline prose and a verified bullet under the wrong employer.
2. Stored analyses can survive changed inputs even though their cache keys would change.
3. Inbox processing can replace a newer rejection with an older interview invitation in one scan.
4. A failed employer board can be treated as closed because another board on the same provider succeeded.
5. Spend telemetry omits some billed failures and nested calls; the budget is a stop-after threshold, not a strict cap.

These are concrete interface/ownership problems, not reasons to replace the application.

## Scope and evidence

Reviewed the CLI, source adapters, normalization/dedupe/scoring, analysis and cache, resume provenance/rendering, application reuse, browser orchestration, inbox processing, SQLite schema/repository/migrations, reports, configuration, deployment templates, and associated tests.

Evidence labels used below:

- **Demonstrated:** exercised against synthetic candidate/job/mail inputs or an isolated in-memory database.
- **Code-confirmed:** follows directly from current control flow; no claim that it has occurred in production.
- **Design risk:** a failure scenario or maintenance concern, with its preconditions stated.

This is a source-level architecture review, not a new operational or job-search effectiveness audit. The production database, private application artifacts, live mailbox, live employer forms, and installed timer were not inspected. Figures in the [2026-08-24 audit](ARCHITECTURE_AUDIT.md) remain historical; they are not new measurements for this review.

### Verification performed

| Check | Result |
|---|---|
| `npm test` | **902 tests passed across 59 files**, including Chromium harness; final run ~48 seconds |
| `npm run typecheck` | Passed |
| `npm run cli -- --help` | Passed through the actual `tsx` entry point |
| Synthetic architecture probes | Confirmed five failure paths, detailed under R1, R2, R3, R4, R6 |
| Documentation | All five Mermaid diagrams rendered successfully; 53 local file/source links checked |

The first full test run failed because this dependency version's Chromium executable was missing. `npx playwright install chromium` installed it; the subsequent full gate passed. No paid model request or live form fill was needed for these checks. A passing suite does not establish the absent cross-module invariants identified below.

## What is working architecturally

| Decision | Why it fits | Preserve |
|---|---|---|
| Local CLI + embedded SQLite | Small deployment footprint; direct inspectability; appropriate for one user's index | One package and local operational ownership |
| Deterministic core | Reproducible parsing, eligibility, dedupe, ranking arithmetic; cheap to rerun | Keep LLM reasoning out of string comparison and arithmetic |
| Provider adapters returning `SourceJob` | Source quirks are isolated from shared classification | Error recording per adapter and central normalization |
| Separate fit and application ROI | Distinguishes capability overlap from where attention is valuable | Explicit confidence and hard-filter precedence |
| Strict structured model responses | Malformed fresh analysis cannot silently become a valid verdict | JSON Schema + local Zod, distinct triage/full validation |
| Repair-to-master resume selection | Safer than unconstrained model-authored resumes; re-rendering is free | Drop invalid citations; revert overreaching rewrites |
| Human-controlled application workflow | Fill and submit are different operations; status is not inferred from a success-looking page | Refusals, explicit confirmations, no auto-send |
| Generated dashboard | Useful UI without a write server, client bundle, or extra deployment | Static artifact contract and loopback-only CLI viewer |
| Explicit destructive migrations | Separates daily startup from deliberate data removal | Backup verification before destructive work; additive-only startup |
| Real-browser refusal harness | Exercises behavior that pure field-policy tests cannot cover | Keep it in default `npm test`; keep real `tsx` smoke checks for browser changes |

The deepest existing modules are the deterministic parsers, requirement matcher, form-answer policy, and source/mail adapters. Their interfaces hide substantial behavior. The weakest locality is around orchestration and persistence: the CLI and `JobRepo` each own several unrelated policies, while important multi-step operations have no single owner.

## Prioritized findings

**P1:** correctness/trust issue to fix before feature expansion. **P2:** reliability or maintainability work to schedule next. Priorities describe engineering urgency, not a claim of an observed production incident.

| ID | Priority | Finding | Evidence |
|---|---|---|---|
| R1 | P1 | Provenance is incomplete at the final resume interface | Demonstrated + code-confirmed |
| R2 | P1 | Cached result identity and attached-analysis freshness are disconnected | Demonstrated + code-confirmed |
| R3 | P1 | Inbox sequencing and cursor ownership can corrupt or omit outcomes | Demonstrated + code-confirmed |
| R4 | P1 | Observation health is tracked at the wrong granularity | Demonstrated + code-confirmed |
| R5 | P1 | Paid-call receipts are subordinate to successful workflow completion | Code-confirmed |
| R6 | P2 | Related state changes lack atomic persistence | Demonstrated + design risk |
| R7 | P2 | Artifact stamps and rendered files are not published as one generation | Code-confirmed failure scenario |
| R8 | P2 | CLI orchestration owns too many caller-visible rules | Code-confirmed |
| R9 | P2 | Candidate evidence and policy have competing definitions | Code-confirmed |

### R1 — Make provenance the final rendering interface

**Evidence**

- [`src/resume/tailor.ts:21–37`](../src/resume/tailor.ts#L21) accepts free-string `headline` and `summary`.
- [`enforceProvenance`, lines 212–256](../src/resume/tailor.ts#L212) validates globally known/verified bullet IDs and selected rewrites, but does not validate those prose fields or require a bullet to belong to its selected role.
- [`composeResume`, lines 40–85](../src/resume/render.ts#L40) resolves bullets from a global index, places them under the selected role's employer, and copies the plan's headline and summary directly into the rendered model.
- [`checkRewrite`, lines 62–96](../src/resume/provenance.ts#L62) checks a finite technology vocabulary and numeric claims. It permits a technology from the global master skill list even when absent from the source bullet; scope changes such as contributor → leader are not mechanically checked.

**Demonstration:** a synthetic plan containing an invented headline/summary and a verified bullet from employer B selected under employer A produced **zero provenance violations**. `composeResume` retained all three. This exercised `enforceProvenance` first, so the defect does not depend on bypassing the checker.

**Impact:** the architecture's strongest promise—rendered resume facts trace to master evidence—is not true for every output field or employment attribution. Schema-valid text is not evidence-backed text. The checks remain valuable, but they are not a semantic proof of arbitrary paraphrases.

**Recommendation:** expose one final composition interface that accepts untrusted plans and always repairs them against the current master. Return a validated/composed result, rather than requiring every caller to remember a separate mutating check. Select headlines/summaries from master-authored facts or approved variants; reject cross-role citations; scope technology evidence to the source bullet. Where a rewrite's claim cannot be established deterministically, retain master wording. Do not weaken the current technology/number checks or substitute a model's approval for evidence.

**Acceptance:** adversarial plans cannot introduce uncited prose, relocate a bullet to another employer, promote unsupported scope, or attach another role's technology to a bullet. Fresh generation, reuse, and `resume render` cross the same final interface. Existing repair behavior remains available.

### R2 — Treat analysis freshness as an explicit stored contract

**Evidence**

- [`JobRepo.upsert`, lines 193–278](../src/db/repo.ts#L193) clears the attached analysis only when `material_hash` changes. Title, salary, location, and employment updates can leave it attached.
- [`eligibleForAnalysis` / `needingAnalysis`, lines 498–597](../src/db/repo.ts#L498) select only `analysis_json IS NULL`. Already-attached analyses never reach the cache freshness check.
- [`cacheKey`, lines 1209–1217](../src/db/repo.ts#L1209) includes title, company, model, evidence version, material hash, and tier; the `jobs` row does not record the corresponding input signature for its attached analysis.
- [`buildUserPrompt`, lines 81–115](../src/analysis/prompt.ts#L81) sends structured location, employment type, department, date, salary, source, and URL too. [`evidenceVersion`](../src/analysis/analyzer.ts#L183) only hashes the system prefix and calibration-stable note. Some meaningful structured inputs are therefore absent from the current address.

**Demonstration:** insert and analyze a synthetic “Senior Engineer”; upsert the same external posting as “Director of Engineering” with unchanged description tokens. The new title is stored and the old analysis remains attached. A future `analyze` pass excludes it before considering its different cache key.

**Impact:** scores and endorsement gates can use a verdict formed against a different title or candidate evidence. Changing the cache address is not sufficient if the attached result bypasses lookup entirely. The same issue affects moving from triage policy to a policy that now requires a dossier.

**Recommendation:** own `AnalysisInputIdentity` in the analysis module. Store the identity/schema version/tier alongside the attached verdict and compare it when selecting, reconciling, or preparing. Include materially relevant structured inputs using deterministic canonicalization. Preserve the material-hash behavior and the intentional exclusion of calibration-varying fit/ROI. An invalidated verdict becomes pending; rank and explicit budgets govern any replacement call. Never re-buy an unchanged input merely because calibration moved.

**Acceptance:** title/evidence/meaningful structured-input changes mark a verdict stale; pure formatting or calibration changes do not. Stale verdicts cannot silently endorse preparation. Cache reads validate supported schema/tier, and unchanged inputs remain free.

### R3 — Own inbox ordering, state transitions, and scan progress together

**Evidence**

- [`MailSource.fetch`](../src/inbox/source.ts#L23) declares most-recent-first ordering.
- [`scanInbox`, lines 60–135](../src/inbox/scan.ts#L60) loads candidates once, then tests every email against the original `job.status`. It does not update that snapshot after a transition.
- [`GmailSource.fetch`, lines 81–110](../src/inbox/source.ts#L81) fetches one page capped at 100 and ignores `nextPageToken`.
- [`lastEmailAt`](../src/db/repo.ts#L837) uses maximum recorded email time as the next scan's lower bound, even though an older backlog may remain unfetched.

**Demonstration:** one `APPLIED` job and two mails ordered as the interface specifies: newer rejection, then older interview invitation. The scan records `REJECTED`, then accepts `APPLIED → SCREEN` using its stale snapshot. Final stored status: **`SCREEN`**, overriding the rejection.

**Additional failure scenario:** a mailbox query returns more than one page. Recording the newest page advances the timestamp used by the next scan past older unprocessed pages. The normal incremental path can omit that backlog indefinitely.

**Recommendation:** create an outcome-ingestion module that owns a scan cursor, complete-page progress, message idempotency, and transitions against current state. Apply a defined chronological policy with event time and explicit handling for late/out-of-order messages. Atomically record an email decision with any status effect. Advance the watermark only after the corresponding range has been traversed; preserve ambiguous matches for human review.

**Acceptance:** newer rejection cannot be undone by an older invitation; replay is idempotent; terminal statuses remain protected; pagination, partial fetch failures, late mail, and interrupted scans lose no messages. Neither mailbox mutation nor automatic submission is introduced.

### R4 — Distinguish provider, employer board, and completed sweep

**Evidence**

- [`GreenhouseSource`, lines 44–76](../src/sources/greenhouse.ts#L44) fetches and catches failures per board, but emits `source: "greenhouse"` for every board. Board identity is embedded in the external ID, not in the freshness contract.
- [`newestBySource` / `isStale`](../src/model/freshness.ts#L20) compare sightings by that provider string.
- [`runIngest`, lines 124–150](../src/pipeline/ingest.ts#L124) parks against provider-level high-water marks, rather than explicit successful board sweeps.
- Although the ingestion comment says an all-source failure aborts, [`runIngest`, lines 71–173](../src/pipeline/ingest.ts#L71) records errors and returns a summary even if all sources fail. `withRepo` sees a resolved callback and can record success.

**Demonstration:** one old job from a failed board plus two fresh jobs from successful sibling boards, all `source: greenhouse`. The old job becomes stale and passes parking when below the provider-wide fraction guard. Fetch-time isolation does not extend to freshness decisions.

**Impact:** transient or sustained failure of a small board can suppress live jobs and block preparation. Conversely, “successful run” can mean no usable source was refreshed, undermining scheduler diagnostics.

**Recommendation:** introduce explicit `BoardId` and `BoardSweep` records: provider, board token, start/completion, success/partial/failure, observed IDs, and count. Infer absence only from a successful complete sweep of that same board. Record successful empty boards explicitly. Report pipeline results as success/degraded/failed, retaining useful work from healthy boards.

**Acceptance:** failure of board A cannot close A's jobs because B succeeded; an empty but successful A sweep is distinguishable from failed A; all-source failure reports failure; partial success retains jobs and exposes degradation. Keep parking allowlists and suspicious-drop guards.

### R5 — Persist receipts at the paid-call seam

**Evidence**

- [`analyzeOne`, lines 655–694](../src/analysis/analyzer.ts#L655) can throw for refusal, truncation, parsing, or validation before `readUsage` runs.
- [`runAnalysis`, lines 443–490](../src/analysis/analyzer.ts#L443) adds usage only after the full job path succeeds. A successful paid triage followed by a failed dossier loses the triage receipt from the run summary and does not retain that triage result for reuse.
- [`daily --analyze`, lines 1158–1202](../src/cli.ts#L1158) prints the analysis summary but returns only report paths and job count to `withRepo`. Its paid analysis usage is absent from the persisted daily run statistics.
- [`refuseIfUnendorsed`](../src/cli.ts#L831) can fetch a dossier but returns only a boolean, so usage is not merged into the preparation result. This path is normally unreachable under today's eager dossier routing; it matters if that policy changes.
- [`shouldStopForBudget`, lines 556–580](../src/analysis/analyzer.ts#L556) compares already-recorded spend. Two-stage processing has no check between triage and dossier. Missing receipts or billed validation failures can understate that spend further.

**Impact:** telemetry measures successful workflow returns, not every paid request. This affects debugging, per-application attribution, and budget enforcement. `readUsage` standardizes a shape but is not yet a durable receipt mechanism. The claimed strict ceiling in deployment documentation is stronger than this code's explicitly documented stop-after behavior.

**Recommendation:** introduce a paid-call module used by analysis, tailoring, packs, import, and benchmarking. Capture a receipt immediately after each response, before semantic validation, with run ID, job ID when available, purpose, model, tier, usage, and validation outcome. Retain it if a later render/write/dossier step fails. Persist reusable triage before promotion. Check budget at each individual call; use conservative reservation if a genuinely hard ceiling is required, otherwise label the stop-after limit accurately.

An API failure without a provider receipt remains **unknown usage**, not invented zero usage. Do not reintroduce an absolute fit threshold as a spend proxy.

**Acceptance:** refusal/truncation/schema failure, successful triage + failed dossier, paid daily analysis, missing usage, and post-generation PDF failure all retain correct known receipts and explicit unknowns. Failed work cannot silently disappear from the spending ledger.

### R6 — Give logical writes transaction ownership

**Evidence**

- [`JobRepo.setStatus`, lines 369–378](../src/db/repo.ts#L369) reads status, updates the row, and inserts its event without a transaction.
- [`saveAnalysis`](../src/db/repo.ts#L362) and [`upsert`](../src/db/repo.ts#L119) also perform related writes separately; inbox status changes and message records are separate calls.
- [`parkJobs`](../src/db/repo.ts#L654) is transactional, but parking and reopening in `upsert` do not emit matching status events. The log is a partial audit trail, not complete state history.
- [`applyColumnMigrations`](../src/db/index.ts#L115) adds a column before running its one-time backfill, outside a transaction covering both. If backfill fails after ALTER succeeds, next startup sees the column and skips the backfill.

**Demonstration:** in an in-memory database, install a trigger that aborts insertion of `status_changed`, then call `setStatus`. The call throws, but the job is already `APPLIED` and no transition event exists.

**Impact:** interruption or a later write failure leaves current state and history inconsistent. The schema cannot protect invariants spread across separate auto-commits. Multiple local processes are possible even for one user: timer, manual CLI, and dashboard watcher.

**Recommendation:** make status+event, email+status+event, analysis attachment+metadata, and each upsert's related changes short atomic operations. Prefer conditional updates where stale callers must not overwrite a newer state. Keep network/browser work outside transactions. Make additive column creation plus required backfill recoverable atomically, or persist explicit backfill completion separately.

**Related design risk:** [`backup` / `migrate`](../src/cli.ts#L2233) checkpoint, close, then copy the main SQLite file; checkpoint status is not checked and no coordination prevents another writer. A reader can block checkpoint completion, and another writer can change state around the copy. Use SQLite's supported backup mechanism with integrity verification; keep existing byte-size checks and deliberate destructive migration ordering. This concurrency scenario was not reproduced here.

**Acceptance:** injected failure leaves either the entire logical change or none; migration retry completes an interrupted backfill; backup/restore integrity is verified with another connection active. Decide and document whether automatic park/reopen transitions belong in history, rather than implying complete history while omitting them.

### R7 — Publish reusable artifacts as a consistent generation

**Evidence**

- [`apply`, lines 318–338](../src/cli.ts#L318) writes the new generation stamp before `writePack` publishes the pack.
- [`writeStamp`](../src/apply/reuse.ts#L76) overwrites a shared JSON file directly; it is not tied to artifact bytes.
- [`decideReuse`](../src/apply/reuse.ts#L117) uses file existence and stamp input hashes. It deliberately permits unstamped legacy artifacts with a warning.
- [`autofill`, lines 964–1005](../src/cli.ts#L964) loads the pack and selects PDFs by existence/name; it does not compare their generation to the current posting or master.

**Failure scenario:** an old pack exists; a changed posting triggers regeneration; the new stamp writes; the process stops before the pack is replaced. Next run finds the old pack and the new matching stamp and treats it as current. A failed PDF render can similarly leave an older PDF beside newer plan/HTML output, and autofill can attach it.

**Recommendation:** create one artifact-store module with a small `loadGeneration` / `publishGeneration` interface. Write into a generation-specific temporary directory, record content hashes and rendering status, then atomically switch a manifest/reference to the completed generation. Keep historical generations that may have been reviewed or submitted. Attachment selection should expose whether the file belongs to that generation and whether it needs re-rendering.

Preserve the intentional rule that a master change reuses selection and re-checks provenance, while `--force` deliberately reselects. Correctness should not require automatically buying a new plan. Also preserve honest handling of legacy artifacts whose provenance stamps are unavailable.

**Acceptance:** interruption at each publication step cannot pair old content with new stamps. A failed PDF render cannot silently designate the prior PDF as freshly tailored. Byte-level document invalidation versus material-level analysis invalidation is explicit and tested.

### R8 — Extract workflows, not a collection of thin command wrappers

[`src/cli.ts`](../src/cli.ts) is 2,334 lines at this baseline. Size alone is not the problem: it owns endorsement checks, optional dossier promotion, artifact reuse, file publication, resume assembly, browser lifecycle, learned answers, status updates, spending aggregation, backup, and command formatting.

The caller-visible interface is therefore much larger than the function signatures suggest. Preparing a job correctly requires knowing several ordering rules. This explains the defects above and makes a future writable dashboard likely to duplicate them.

Additional code-confirmed examples:

- [`withRepo`, lines 107–120](../src/cli.ts#L107) invokes `fn(repo, db)` before `Promise.resolve` receives its value. A synchronous throw bypasses its `.catch`/`.finally`; a returned `{ok:false}` is recorded as a successful run. The run table also starts with `ok=1`, so interrupted runs require interpretation beyond that flag.
- Standalone `analyze` saves verdicts but does not re-score; `daily --analyze` knows to do so. Correct current rankings depend on which entry point invoked analysis.
- `JobRepo` mixes CRUD, SQL selection/diversity policy, benchmark sampling, mail processing records, run telemetry, and interview storage; scoring separately receives both `JobRepo` and a raw `DB` handle.

**Recommendation:** extract cohesive use-case modules behind existing commands, starting with the interfaces needed to repair R1–R7. Keep Commander responsible for arguments, output, confirmation, and exit codes. A workflow should own its ordering, returned result, and expected failure states. Use `try/finally`-owned lifecycle and explicit succeeded/degraded/refused/failed run outcomes.

Do not mechanically split every SQL method into a new abstraction. SQLite is currently the real storage adapter; retain direct in-memory SQLite integration tests. Add narrow interfaces only where they buy substitution or hide a meaningful invariant.

**Acceptance:** the same preparation workflow can be exercised without launching Commander; sync and async errors finalize/close correctly; refusal is distinguishable from success; CLI and daily share analysis-refresh semantics; no caller reconstructs provenance/publication ordering.

### R9 — Separate candidate facts from search policy consistently

**Evidence**

- [`buildSystemPrompt`, lines 23–45](../src/analysis/prompt.ts#L23) embeds candidate skills, career background, and numeric accomplishments in TypeScript.
- [`prepareApplication`](../src/analysis/prepare.ts#L55) receives a career profile, not the master resume, and uses that system prompt for cover-note/form-answer drafting.
- Resume selection uses `config/resume.yaml`. These fact sets can diverge when the human corrects a master claim; pack generation does not read the corrected master.
- Priority thresholds are duplicated between [`assignPriority`](../src/pipeline/score.ts#L297) and [`reprioritize`](../src/pipeline/rescore.ts#L135), despite the documented config-over-code policy.

**Impact:** correcting one source does not necessarily correct everything said about the candidate. Updating a search policy can require code changes at multiple sites. This is especially important because free-prose packs rely on prompt constraints and human review rather than the resume's citation mechanism.

**Recommendation:** build a versioned candidate-evidence view from verified master data; let career-profile YAML own preferences, lanes, and search strategy. Have analysis and pack prompts consume that view, with references where claims are drafted. Put configurable priority policy in one validated definition and retain the explicit “projected cannot be A” rule as a separate invariant.

**Acceptance:** editing/removing a verified master claim changes the evidence consumed by new analysis and pack requests without a TypeScript edit. Saved packs remain visibly tied to their generation evidence and reviewed intentionally; do not silently rewrite submitted material. One config change controls comparable priority thresholds across scoring paths.

## Target module shape

These are proposed internal interfaces in the **existing process**, not new deployments.

| Proposed module | Small caller-facing interface | Complexity owned inside |
|---|---|---|
| Candidate evidence / resume composition | Build evidence; compose a safe resume from a plan | Master facts, citation ownership, repair/revert, all rendered fields |
| Board observation | Record completed sweep; derive presence/absence | Board identity, partial failure, observation timestamps, parking eligibility |
| Analysis lifecycle | Get current verdict; ensure requested tier within budget | Input identity, schema version, cache, tier promotion, stale-result handling |
| Paid-call accounting | Execute a purpose-labelled request and record receipt | Attempt attribution, known/unknown usage, validation result, spend reservation |
| Outcome ingestion | Scan/apply a mail range | Pagination, cursor progress, ordering, idempotency, current-state transitions |
| Application artifacts | Load/publish a generation; select attachment | Plans/stamps/files, atomic publication, historical generations, render freshness |
| Command workflows | Discover, analyze, prepare, record outcome | Ordering across the above modules, explicit results, run lifecycle |

The design goal is **depth**: a caller should ask for a correct operation, not orchestrate every safety step itself. Depth improves **locality**: a provenance, ordering, or accounting fix should live in one implementation and benefit every entry point.

## Evolution plan

### 1. Restore factual and state correctness

Address R1, R2, R3, and R4 in small vertical changes. Add focused regression tests at the actual interfaces for the demonstrated cases. Start with R1 because it contradicts the primary factual-integrity guarantee.

**Exit criteria:** all demonstrated counterexamples are prevented, while unchanged-input reuse, explicit overrides, source isolation, and human submission semantics remain intact.

### 2. Make persistence and expenditure durable

Address R5–R7: per-call receipts, transaction-owned logical writes, recoverable migration/backfill, consistent artifact publication, and verified backups. Use additive schema changes by default; keep destructive actions in the explicit migration command.

**Exit criteria:** injected failures at response validation, event insertion, artifact writing, and PDF generation leave traceable, recoverable state and spending records.

### 3. Consolidate orchestration and evidence

Address R8–R9 while moving existing command behavior behind cohesive workflows. Avoid a broad rewrite: each extraction should eliminate a specific caller obligation or duplicated policy.

**Exit criteria:** preparation and analysis can be integration-tested through workflow interfaces; candidate facts flow from one maintained evidence source; run results faithfully describe success, degradation, refusal, and failure.

### 4. Revisit growth only after measuring it

- **Writable dashboard:** reuse the workflows; separately design request validation, local access controls, and concurrent writes when implementing it. Keep the existing static viewer useful meanwhile.
- **Larger index:** measure `runScoring` memory/time before optimizing. It currently hydrates all jobs and descriptions and rewrites scores per row. Batching prepared writes and slimmer projections should precede distributed processing.
- **Two-stage analysis:** keep savings labelled unproven. Current routing includes every endorsed verdict, making dossier-on-intent normally unreachable. Changing that is a measured policy change requiring a new routing evaluation, not an architectural cleanup.
- **Outcome quality:** the checked-in timer does not run inbox; ghosting can operate without fresh mailbox observations. Expose outcome-observation freshness before interpreting funnel silence as employer behavior. Do not assume the live installation matches the template.

## Follow-up concerns outside the first implementation slice

These are worth tracking, but are lower priority than the demonstrated failures:

- **History and identity:** within-batch duplicates are collapsed before persistence, so not every original sighting necessarily reaches `job_sources`. Cross-run identity primarily checks canonical source/external ID and exact dedupe key, with no full cross-run fuzzy merge. Define source-alias ownership before extending dedupe.
- **Network discipline:** `PoliteFetcher` serializes by host within one instance. Its constructor does not enforce a minimum delay, and `Retry-After` handling accepts numeric values only and caps them at 30 seconds ([`src/lib/http.ts:29–75`](../src/lib/http.ts#L29)). Honor documented retry delays, including HTTP dates, and validate at the transport interface without weakening configured rate limiting. Multiple processes do not share a limiter.
- **Backup coverage:** database backups do not include master/personal YAML, generated plans, or other irreplaceable local evidence. Define a restorable local-data set; avoid assuming reports and master evidence have the same retention needs.
- **Documentation drift:** README still contains stale test counts, a sub-second-suite claim, a Node 20 requirement, and “not implemented” entries that now exist. The new C4 map records current structure; historical audits should stay dated, and operational claims should name their measurement date.

## Reproducing the demonstrated findings

The probes used synthetic fixtures and the existing `tests/helpers/db.ts` in-memory database helper under `node --import tsx`; they did not touch the operational database. These recipes are suitable regression tests when implementing fixes:

| Finding | Setup and call | Observed result before fixes |
|---|---|---|
| R1 | Master with roles A/B and one verified bullet each. Plan: role A selects B's bullet; arbitrary invented summary/headline. Run `enforceProvenance`, then `composeResume`. | Zero violations; invented text and wrong-employer attribution survive |
| R2 | Normalize/upsert a job, attach valid synthetic analysis, upsert same external ID and description with a different title. Read it back. | New title, old attached analysis |
| R3 | One APPLIED job; `MailSource` returns newer rejection then older invitation. Call `scanInbox(..., {apply:true})`. | REJECTED followed by SCREEN using stale APPLIED snapshot |
| R4 | Three NEW sightings with same provider; one nine days older than two sibling-board sightings. Run `newestBySource`, `isStale`, `planParking` with 3-day threshold and 0.5 fraction cap. | Old failed-board job marked stale and selected for parking |
| R6 | Create SQLite trigger that aborts `status_changed` event inserts. Call `setStatus(id, 'APPLIED')`. | Call throws; row remains APPLIED without event |

**Bottom line:** this application has the right deployment shape and many good domain mechanisms. The highest-return architectural work is to turn its strongest stated guarantees into complete, single-owner interfaces—and test the failure paths across those interfaces.
