# Centralize configurable priority policy

**Draft:** A14 · **Team:** JOB · **Label:** Improvement · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R9, architectural review. **Publication:** [JOB-59](https://linear.app/job-radar-app/issue/JOB-59/centralize-configurable-priority-policy), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Make comparable priority thresholds one validated configuration policy used by raw and projected scoring, while keeping analysis reconciliation and confidence rules explicit.

## Why

Priority thresholds are duplicated in implementation code, so tuning can require multiple edits and diverge from the config-over-code contract.

## Impact

Ranking changes become harder to explain and verify consistently across scoring paths.

## Suggested Approach

Preserve current outputs under default configuration, then move tunable thresholds behind one deterministic policy interface. Keep “projected never reaches A” as an explicit invariant, not an accidental threshold trick.

## Acceptance Criteria

- [ ] One config change controls equivalent raw/projected thresholds without TypeScript edits.
- [ ] Invalid threshold ordering/coherence fails configuration loading clearly.
- [ ] Current defaults preserve baseline priority results; analyzed recommendations still reconcile under their own explicit policy.
- [ ] Hard-filter failures remain rejected and projected jobs never become Priority A.
- [ ] Exercise real scoring on an isolated corpus, including changed config, and pass full tests/typecheck.

## Constraints

All parsing, comparisons, and arithmetic remain deterministic. Preserve fit versus ROI distinction, hard-filter precedence, and rank-based paid selection. No absolute fit spend gate.

## Blocked by

None (can start immediately).
