# Own preparation ordering in reusable workflows

**Draft:** A15 · **Team:** JOB · **Label:** Improvement · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R8, architectural review. **Publication:** [JOB-60](https://linear.app/job-radar-app/issue/JOB-60/own-preparation-ordering-in-reusable-workflows), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Make application-pack and resume preparation cohesive workflows whose callers cannot forget endorsement, reuse, provenance, receipts, publication, or status ordering.

## Why

The CLI currently owns those rules directly. Splitting command registration alone would preserve the same large caller-visible interface and risk.

## Impact

Independent entry points and future interfaces are likely to duplicate or bypass critical sequencing.

## Suggested Approach

Use the corrected interfaces delivered by blockers. Keep command parsing, presentation, and human prompts at the CLI. Integrate existing commands with workflows that return explicit outcomes and own their ordering; retain actual SQLite integration tests rather than adding speculative storage adapters.

## Acceptance Criteria

- [ ] Pack/tailor workflows can be exercised without Commander and use the same implementation as their CLI commands.
- [ ] Endorsement and closed-posting overrides remain explicit/auditable; cached reuse never silently buys another plan.
- [ ] Safe composition, durable receipts, and coherent artifact publication cannot be skipped by a caller.
- [ ] Preparation advances only allowed early statuses to APPLY, never APPLIED or backwards.
- [ ] Failure and refusal return explicit lifecycle outcomes; no paid work disappears after a later failure.
- [ ] Command-level parity tests and actual isolated prepare/render invocations pass alongside full tests/typecheck.

## Constraints

Never submit/send; preserve human confirmations and all autofill refusals. Keep provenance repair, four cost controls, and deliberate `--force`/override behavior. Any changed browser path requires the real harness and live human-reviewed autofill; avoid named page-side functions.

## Blocked by

- [JOB-46](https://linear.app/job-radar-app/issue/JOB-46/enforce-provenance-at-final-resume-composition) — Enforce provenance at final resume composition.
- [JOB-52](https://linear.app/job-radar-app/issue/JOB-52/persist-receipts-for-every-paid-model-attempt) — Persist receipts for every paid model attempt.
- [JOB-56](https://linear.app/job-radar-app/issue/JOB-56/publish-application-artifacts-as-coherent-generations) — Publish application artifacts as coherent generations.
- [JOB-57](https://linear.app/job-radar-app/issue/JOB-57/record-truthful-command-lifecycle-outcomes) — Record truthful command lifecycle outcomes.
