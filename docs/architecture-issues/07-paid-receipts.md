# Persist receipts for every paid model attempt

**Draft:** A07 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R5, architectural review. **Publication:** [JOB-52](https://linear.app/job-radar-app/issue/JOB-52/persist-receipts-for-every-paid-model-attempt), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Usage is captured after output validation and successful workflow completion. Billed invalid responses, successful triage before a failed dossier, and nested requests can disappear from totals.

## Steps to Reproduce

Code-confirmed during review; no billed failure was deliberately generated. Reproduce using a fake model response carrying usage but failing validation, then a successful triage followed by dossier failure, through the real workflow interface.

## Expected Behavior

Each paid attempt has durable known usage or an explicit unknown-usage record even when subsequent work fails.

## Actual Behavior

Thrown validation and later workflow errors can bypass or discard accounting; daily/nested calls are not reliably represented in persisted totals.

## Acceptance Criteria

- [ ] Persist a receipt at the request seam before semantic validation, identified by run, job when available, purpose, model, tier, and attempt.
- [ ] Integrate analysis, promotion, tailoring, packs, import, and benchmarking; retain existing caller behavior while migrating them.
- [ ] Record known usage separately from unknown usage, validation outcome, and estimated price; never fabricate zero for missing receipts.
- [ ] Persist valid triage before dossier promotion; failed promotion can reuse that result later.
- [ ] Spend queries include failed and nested paid calls exactly once; legacy run totals do not double-count migrated receipts.
- [ ] Fault-injection tests cover truncation, refusal, invalid JSON/schema, missing usage, dossier failure, and later file/PDF failure.
- [ ] Full tests/typecheck and isolated spending/paid-workflow command checks pass without requiring actual charges for fault injection.

## Constraints

Keep structured validation, rank-based selection, content/prompt caching, description budgets, unchanged-input reuse, and per-job attempt policy. Additive storage changes only on startup.

## Blocked by

None (can start immediately).
