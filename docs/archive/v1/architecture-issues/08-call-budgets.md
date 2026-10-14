# Check analysis budgets before every paid call

**Draft:** A08 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R5, architectural review. **Publication:** [JOB-53](https://linear.app/job-radar-app/issue/JOB-53/check-analysis-budgets-before-every-paid-call), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

The budget is checked once per job using successful recorded spend, with no intermediate gate before buying a dossier. Documentation describes a stronger ceiling than implemented.

## Steps to Reproduce

Code-confirmed only; no overspending run was executed. Use fake priced receipts near the ceiling, then return triage that earns a dossier and observe the second request.

## Expected Behavior

Every analysis purchase, including promotion, checks the same explicit budget using durable spend and a defined unknown-usage policy.

## Actual Behavior

A job-level check can allow two purchases and failed/unknown usage can understate the running total.

## Acceptance Criteria

- [ ] Check before each triage/full request and endorsed promotion, with per-run scope explicit.
- [ ] Preserve stop-after semantics unless a verified conservative reservation can support a strict cap; describe any possible one-call overrun accurately.
- [ ] Missing usage causes an explicit budget decision, not assumed-free continuation.
- [ ] Paid validation failures count known usage toward stopping; cached results cost zero and remain reusable.
- [ ] Test exact-ceiling, zero budget, triage-crosses-limit, unknown usage, and failure cases.
- [ ] CLI/help/deployment guidance matches the implemented budget contract; full tests/typecheck and isolated analysis commands pass.

## Constraints

Never use an absolute fit threshold to bound spend. Preserve all four cost controls and tier separation. This task does not enable unattended paid analysis or change dossier routing policy.

## Blocked by

- [JOB-52](https://linear.app/job-radar-app/issue/JOB-52/persist-receipts-for-every-paid-model-attempt) — Persist receipts for every paid model attempt.
