# Unify standalone and daily analysis refresh

**Draft:** A16 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R8 and R5, architectural review. **Publication:** [JOB-61](https://linear.app/job-radar-app/issue/JOB-61/unify-standalone-and-daily-analysis-refresh), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Standalone analysis persists verdicts without the ranking refresh performed by daily analysis. Daily also omits the printed analysis summary from its persisted command result.

## Steps to Reproduce

Code-confirmed only; no paid standalone-versus-daily comparison was run. Exercise both entry points using an isolated scored corpus and deterministic fake model responses before implementing.

## Expected Behavior

Both entry points share analysis freshness, budget, receipt, and ranking-refresh semantics.

## Actual Behavior

Current rankings and retained run accounting depend on which command invoked analysis.

## Acceptance Criteria

- [ ] A shared workflow owns eligibility, current-verdict resolution, paid analysis, and necessary deterministic re-scoring.
- [ ] Standalone and daily paths leave equivalent job rankings for equivalent inputs/results.
- [ ] Both retain correct nested receipts and explicit command outcomes; no double-counting with the paid-call ledger.
- [ ] Cache hits, no candidates, dry-run semantics, partial failures, and budget stopping have explicit tests.
- [ ] Read-only/report-only behavior is documented accurately; any existing dry-run writes are addressed deliberately rather than accidentally.
- [ ] Run actual isolated analyze and daily commands; full tests/typecheck pass.

## Constraints

Keep all four cost controls, rank selection, tier separation, deterministic scoring, and calibration-stable reuse. Do not change dossier routing or enable paid scheduled analysis.

## Blocked by

- [JOB-51](https://linear.app/job-radar-app/issue/JOB-51/version-and-validate-attached-analysis-inputs) — Version and validate attached analysis inputs.
- [JOB-53](https://linear.app/job-radar-app/issue/JOB-53/check-analysis-budgets-before-every-paid-call) — Check analysis budgets before every paid call.
- [JOB-57](https://linear.app/job-radar-app/issue/JOB-57/record-truthful-command-lifecycle-outcomes) — Record truthful command lifecycle outcomes.
