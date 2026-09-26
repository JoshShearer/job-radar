# Make logical job and outcome writes atomic

**Draft:** A02 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R6 and R3, architectural review. **Publication:** [JOB-47](https://linear.app/job-radar-app/issue/JOB-47/make-logical-job-and-outcome-writes-atomic), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Current state, history, and email effects are separate commits. A later write can fail after the visible job state already changed.

## Steps to Reproduce

Executed in an in-memory database during review: install a trigger aborting status-event inserts, then set a job to APPLIED. The operation throws, but the job remains APPLIED without its event. Other multi-write paths were inspected, not fault-injected end-to-end.

## Expected Behavior

A logical operation commits its current-state change and supporting records together, or leaves all of them unchanged.

## Actual Behavior

The state update survives failure to record its transition.

## Acceptance Criteria

- [ ] Status+event, email decision+status+event, analysis attachment+metadata/event, and each upsert's related writes have short transaction owners.
- [ ] Stale automatic callers use current-state/conditional updates and cannot overwrite a newer incompatible state.
- [ ] Parking/reopening history is explicitly specified and recorded consistently with that contract.
- [ ] Fault injection at each write proves rollback and successful replay; use real isolated SQLite rather than a mocked repository.
- [ ] No network or browser waits occur inside database transactions.
- [ ] Full tests/typecheck and isolated affected status/ingest/inbox command checks pass.

## Constraints

Preserve explicit human status choices and never infer submission. Startup schema changes are additive only; destructive migrations remain explicit and backed up. Keep deterministic transition policy.

## Blocked by

None (can start immediately).
