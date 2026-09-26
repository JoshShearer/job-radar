# Version and validate attached analysis inputs

**Draft:** A06 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R2, architectural review. **Publication:** [JOB-51](https://linear.app/job-radar-app/issue/JOB-51/version-and-validate-attached-analysis-inputs), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

An attached verdict bypasses cache-identity checks because selection considers only rows without analysis. Title and other meaningful input changes can retain an obsolete endorsement.

## Steps to Reproduce

Executed in memory during review: normalize/upsert Senior Engineer, attach a valid synthetic verdict, then upsert the same external posting as Director of Engineering with unchanged description tokens. The new title retains the old verdict. No paid end-to-end analysis command was run.

## Expected Behavior

Only verdicts matching the current material inputs, evidence, supported schema, and required tier can rank or endorse the job.

## Actual Behavior

Title-only changes retain analysis and exclude that job from normal analysis selection.

## Acceptance Criteria

- [ ] Persist a versioned analysis-input identity with attached verdicts and validate it for selection, reconciliation, and preparation.
- [ ] Include materially relevant structured inputs and stable evidence; document inclusion/exclusion decisions.
- [ ] Changed title, location/employment/compensation evidence, or candidate evidence marks affected verdicts stale.
- [ ] Cosmetic description changes and calibration-only fit/ROI changes preserve reuse.
- [ ] Validate cached schema/tier; stale or legacy-unverifiable results are visibly pending, not silently endorsed or automatically repurchased.
- [ ] Rank and explicit budgets still govern replacement calls; tests cover unchanged-input reuse and tier promotion.
- [ ] Run isolated score/analyze/preparation gate checks, full tests, and typecheck.

## Constraints

Preserve material hashing, tier separation, all four cost controls, and hard-filter precedence. Do not broaden immaterial changes or reintroduce absolute fit gating. Startup migrations stay additive.

## Blocked by

None (can start immediately).
