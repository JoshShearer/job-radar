# Make additive migration backfills recoverable

**Draft:** A09 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R6, architectural review. **Publication:** [JOB-54](https://linear.app/job-radar-app/issue/JOB-54/make-additive-migration-backfills-recoverable), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

A column is added before its one-time backfill. If the backfill fails, the next startup sees the column and can permanently skip initialization.

## Steps to Reproduce

Code-confirmed only. Before fixing, inject failure during a required backfill on an isolated pre-migration database and reopen it; no production migration failure was induced during review.

## Expected Behavior

Column creation and required initialization are atomic or have explicit resumable completion state.

## Actual Behavior

Column existence alone is treated as completion, even after failed initialization.

## Acceptance Criteria

- [ ] Couple column addition/backfill atomically where supported, or track backfill completion independently and retry safely.
- [ ] Existing partially initialized databases have a deterministic recovery path.
- [ ] Completed backfills do not run on every command startup.
- [ ] Failure/reopen/retry tests prove complete initialization with preserved prior data.
- [ ] Full tests/typecheck and an isolated real command opening an old database pass.

## Constraints

Startup migrations are additive only. Destructive actions remain in explicit migration commands with verified backup. Do not loosen material-hash semantics during recovery.

## Blocked by

None (can start immediately).
