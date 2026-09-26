# Architecture implementation plan

**Source:** [architectural review](ARCHITECTURE_REVIEW_2026-09-25.md) and [C4 map](C4_MAP.md).
**State:** approved and published on 2026-09-26: **JOB-46–JOB-66**.
**Tracker:** Linear, team JOB. All 21 issues and 17 native blocking relationships were read back and verified.

## Goal

Make the application's factual-integrity, freshness, outcome, reuse, and cost guarantees complete at their module interfaces. Keep the local modular monolith, SQLite, deterministic pipeline, static reports, and human submission workflow.

## Completed context

- [x] Map the implemented architecture using C4.
- [x] Review the implementation and record R1–R9 with source evidence.
- [x] Exercise five synthetic failure paths; record limitations of the evidence.
- [x] Run the existing baseline gates: 902 tests, typecheck, CLI help.
- [x] Draft a dependency-aware implementation backlog and individual issue bodies.
- [x] Approve the issue metadata, scope, and blocking edges below.
- [x] Check the live JOB backlog for duplicates and validate current labels/statuses.
- [x] Publish one approved Linear issue per task and record returned identifiers/URLs and native blocking relationships.

## Published issue index

| Plan reference | Linear issue |
|---|---|
| A01 | [JOB-46 — Enforce provenance at final resume composition](https://linear.app/job-radar-app/issue/JOB-46/enforce-provenance-at-final-resume-composition) |
| A02 | [JOB-47 — Make logical job and outcome writes atomic](https://linear.app/job-radar-app/issue/JOB-47/make-logical-job-and-outcome-writes-atomic) |
| A03 | [JOB-48 — Apply mail outcomes against current chronological state](https://linear.app/job-radar-app/issue/JOB-48/apply-mail-outcomes-against-current-chronological-state) |
| A04 | [JOB-49 — Resume mailbox scans without skipping backlog](https://linear.app/job-radar-app/issue/JOB-49/resume-mailbox-scans-without-skipping-backlog) |
| A05 | [JOB-50 — Base posting freshness on successful employer-board sweeps](https://linear.app/job-radar-app/issue/JOB-50/base-posting-freshness-on-successful-employer-board-sweeps) |
| A06 | [JOB-51 — Version and validate attached analysis inputs](https://linear.app/job-radar-app/issue/JOB-51/version-and-validate-attached-analysis-inputs) |
| A07 | [JOB-52 — Persist receipts for every paid model attempt](https://linear.app/job-radar-app/issue/JOB-52/persist-receipts-for-every-paid-model-attempt) |
| A08 | [JOB-53 — Check analysis budgets before every paid call](https://linear.app/job-radar-app/issue/JOB-53/check-analysis-budgets-before-every-paid-call) |
| A09 | [JOB-54 — Make additive migration backfills recoverable](https://linear.app/job-radar-app/issue/JOB-54/make-additive-migration-backfills-recoverable) |
| A10 | [JOB-55 — Create verified SQLite snapshots under concurrent access](https://linear.app/job-radar-app/issue/JOB-55/create-verified-sqlite-snapshots-under-concurrent-access) |
| A11 | [JOB-56 — Publish application artifacts as coherent generations](https://linear.app/job-radar-app/issue/JOB-56/publish-application-artifacts-as-coherent-generations) |
| A12 | [JOB-57 — Record truthful command lifecycle outcomes](https://linear.app/job-radar-app/issue/JOB-57/record-truthful-command-lifecycle-outcomes) |
| A13 | [JOB-58 — Build paid prompts from verified master evidence](https://linear.app/job-radar-app/issue/JOB-58/build-paid-prompts-from-verified-master-evidence) |
| A14 | [JOB-59 — Centralize configurable priority policy](https://linear.app/job-radar-app/issue/JOB-59/centralize-configurable-priority-policy) |
| A15 | [JOB-60 — Own preparation ordering in reusable workflows](https://linear.app/job-radar-app/issue/JOB-60/own-preparation-ordering-in-reusable-workflows) |
| A16 | [JOB-61 — Unify standalone and daily analysis refresh](https://linear.app/job-radar-app/issue/JOB-61/unify-standalone-and-daily-analysis-refresh) |
| A17 | [JOB-62 — Enforce transport delay and Retry-After semantics](https://linear.app/job-radar-app/issue/JOB-62/enforce-transport-delay-and-retry-after-semantics) |
| A18 | [JOB-63 — Preserve source aliases through deduplication](https://linear.app/job-radar-app/issue/JOB-63/preserve-source-aliases-through-deduplication) |
| A19 | [JOB-64 — Back up and restore the irreplaceable local data set](https://linear.app/job-radar-app/issue/JOB-64/back-up-and-restore-the-irreplaceable-local-data-set) |
| A20 | [JOB-65 — Report source and outcome observation freshness](https://linear.app/job-radar-app/issue/JOB-65/report-source-and-outcome-observation-freshness) |
| A21 | [JOB-66 — Reconcile current operational documentation](https://linear.app/job-radar-app/issue/JOB-66/reconcile-current-operational-documentation) |

## Approved issue batch

All tasks: **team JOB; initial status Backlog; assignee Josh Shearer** (the authenticated account). High = Linear priority 2, Normal = 3 (displayed as Medium in Linear), Low = 4. Local IDs `A01`–`A21` remain stable planning aliases for the published issues above. No parent issue was created; this file is the plan.

| ID | Task / draft | Label | Priority | Blocked by | Delivers |
|---|---|---|---|---|---|
| A01 | [Enforce provenance at final resume composition](architecture-issues/01-resume-provenance.md) | Bug | High | None | Every rendered fact and role attribution derives from verified master evidence |
| A02 | [Make logical job and outcome writes atomic](architecture-issues/02-atomic-writes.md) | Bug | Normal | None | State, history, and mail effects commit together or not at all |
| A03 | [Apply mail outcomes against current chronological state](architecture-issues/03-mail-ordering.md) | Bug | High | JOB-47 | Older messages cannot undo newer outcomes |
| A04 | [Resume mailbox scans without skipping backlog](architecture-issues/04-mail-cursors.md) | Bug | High | JOB-48 | Pagination, retry, and cursor advancement preserve unprocessed mail |
| A05 | [Base posting freshness on successful employer-board sweeps](architecture-issues/05-board-sweeps.md) | Bug | High | None | Failed boards cannot be made stale by healthy sibling boards |
| A06 | [Version and validate attached analysis inputs](architecture-issues/06-analysis-freshness.md) | Bug | High | None | Stale verdicts cannot rank or endorse a changed posting |
| A07 | [Persist receipts for every paid model attempt](architecture-issues/07-paid-receipts.md) | Bug | High | None | Billed failures and nested requests remain visible and attributable |
| A08 | [Check analysis budgets before every paid call](architecture-issues/08-call-budgets.md) | Bug | High | JOB-52 | Triage and dossier each respect known spend and explicit unknowns |
| A09 | [Make additive migration backfills recoverable](architecture-issues/09-recoverable-migrations.md) | Bug | Normal | None | Interrupted backfills complete safely on retry |
| A10 | [Create verified SQLite snapshots under concurrent access](architecture-issues/10-sqlite-backups.md) | Improvement | Normal | None | Backups restore consistently with another connection active |
| A11 | [Publish application artifacts as coherent generations](architecture-issues/11-artifact-generations.md) | Bug | Normal | None | Stamps, drafts, and attachments cannot silently mix generations |
| A12 | [Record truthful command lifecycle outcomes](architecture-issues/12-run-lifecycle.md) | Bug | Normal | None | Sync/async failures, refusals, degradation, and interruption remain distinguishable |
| A13 | [Build paid prompts from verified master evidence](architecture-issues/13-candidate-evidence.md) | Bug | High | JOB-51 | Corrected candidate facts reach analysis and new application packs |
| A14 | [Centralize configurable priority policy](architecture-issues/14-priority-policy.md) | Improvement | Normal | None | One validated policy governs raw and projected priority assignment |
| A15 | [Own preparation ordering in reusable workflows](architecture-issues/15-preparation-workflows.md) | Improvement | Normal | JOB-46, JOB-52, JOB-56, JOB-57 | Preparation callers cannot bypass safety, accounting, and publication sequencing |
| A16 | [Unify standalone and daily analysis refresh](architecture-issues/16-analysis-workflow.md) | Bug | Normal | JOB-51, JOB-53, JOB-57 | Both entry points produce current rankings and retained usage |
| A17 | [Enforce transport delay and Retry-After semantics](architecture-issues/17-network-discipline.md) | Bug | Normal | None | Board requests never retry earlier than the server's instruction |
| A18 | [Preserve source aliases through deduplication](architecture-issues/18-source-aliases.md) | Improvement | Low | JOB-50 | Every observed provider identity survives canonical merging |
| A19 | [Back up and restore the irreplaceable local data set](architecture-issues/19-local-recovery.md) | Improvement | Normal | JOB-55, JOB-56 | Recovery restores candidate evidence and saved documents, not only SQLite |
| A20 | [Report source and outcome observation freshness](architecture-issues/20-observation-health.md) | Improvement | Normal | JOB-49, JOB-50, JOB-57 | Reports distinguish measured silence from missing observations |
| A21 | [Reconcile current operational documentation](architecture-issues/21-documentation.md) | Improvement | Low | None | Runtime, test, feature, and budget claims match implemented behavior |

Each local issue document contains its published link, constraints, acceptance criteria, evidence status, and verification requirements. Bug descriptions distinguish the synthetic probes actually run from code-confirmed scenarios that still need reproduction through the user command. Linear is the source of truth for subsequent implementation progress.

## Execution order and genuine blockers

Priorities determine urgency; dependencies determine whether a task can start. File overlap alone is not a blocking edge. Work on one task at a time unless parallel work is explicitly requested.

1. **Factual/state correctness first:** A01, A06, A05; then A02 → A03 → A04. A13 can follow A06 without waiting for unrelated persistence work.
2. **Durability and spend:** A07 → A08, plus A09, A10, A11, A12. These can be taken independently when capacity allows.
3. **Consolidation:** A15 and A16 consume the corrected interfaces. A14 eliminates duplicated policy independently.
4. **Operational follow-ups:** A17–A21. A17 can be pulled forward to protect endpoint compliance. A21 corrects the current baseline immediately; every later ticket owns its own documentation updates.

Why the edges exist:

- A03 consumes A02's atomic email/status/event operation; A04 builds resumability on A03's replay-safe ordering.
- A08 requires A07's durable known/unknown receipts; A16 consumes the corrected freshness, budget, and run-result interfaces.
- A13 uses A06's evidence-version identity so correcting master facts invalidates attached verdicts rather than only changing future prompt text.
- A15 consumes the safe composition, receipt, artifact-generation, and command-result interfaces rather than introducing a second orchestration contract.
- A18 uses A05's explicit employer-board identity. A19 snapshots A10's verified database backup and A11's coherent document generations.
- A20 uses completed mailbox progress, board-sweep health, and truthful run outcomes; it must not infer successful observation from a command merely starting.

## Coverage against the review

| Review area | Tasks |
|---|---|
| R1 provenance | A01 |
| R2 attached-analysis freshness | A06 |
| R3 mail ordering and progress | A02, A03, A04 |
| R4 provider versus employer-board observation | A05, A20 |
| R5 receipts and budgets | A07, A08, A16 |
| R6 atomic writes, migration recovery, backups | A02, A09, A10 |
| R7 document consistency | A11 |
| R8 orchestration and lifecycle | A12, A15, A16 |
| R9 facts and policy | A13, A14 |
| Follow-up: network / aliases / recovery / docs | A17, A18, A19, A21 |
| Follow-up: missing outcome observation | A20 |

Writable UI, distributed processing, performance optimization, and dossier-routing changes remain future decisions requiring their own measurements. They are not implementation tasks approved by this corrective plan. In particular, this plan does not narrow `dossier_for` or claim measured two-tier savings.

## Shared implementation and verification contract

- Each task is a vertical behavior change, including persistence, callers, reports where relevant, and regression tests. Introduce the smallest local seam needed within that task; avoid a standalone horizontal framework rewrite.
- Preserve deterministic parsing/filtering/ranking, three-state requirement matching, hard-filter precedence, and repair-to-master provenance.
- Preserve never-submit/never-send behavior, checkbox/demographic/attestation refusals, nullable unknowns, active-challenge stops, and human confirmation of submission.
- Preserve all four cost controls, material-content identity, tier separation, and unchanged-input reuse. Calibration alone never triggers a paid refresh. No absolute fit gate is reintroduced.
- Startup migrations stay additive. Destructive work stays explicit and backed up; byte-size verification remains load-bearing.
- Use only existing JOB labels. Do not create triage labels or change existing issue statuses during duplicate checking.
- For code changes, `npm test` and `npm run typecheck` must pass, and the affected command must actually be run. Use isolated data and fake provider/model responses for deliberate fault injection; identify synthetic versus live verification honestly.
- Any application-browser implementation change requires the real-browser refusal suite and a human-reviewed live autofill run that stops before submission. Preserve the ban on named functions inside page-side evaluation bodies.
- A21 is documentation-only: verify current statements and links; run commands whose current behavior is being claimed instead of inventing measurements.

## Publication record — 2026-09-26

- The user approved continuation after authenticating Linear. Team, authenticated assignee, labels, and Backlog status were verified live before writing.
- Inspected all 45 existing JOB issues (including archived results); all were Done, with no open duplicate. Read the full relevant predecessor issues JOB-19, JOB-26, JOB-36, JOB-38, JOB-43, and JOB-44 to distinguish the new corrective scope.
- Created JOB-46 through JOB-66 using the approved bodies and metadata, with predecessor context where relevant. Completed predecessor issues retain their state.
- Used native `blockedBy` relationships and real returned issue links in dependency sections. Read every new issue back and verified title, team, assignee, status, priority, type label, required body sections, and all **17** blocking edges.
- URLs above are the values returned by Linear. Implementation has not started as part of publication.
