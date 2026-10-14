# Enforce provenance at final resume composition

**Draft:** A01 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R1, architectural review. **Publication:** [JOB-46](https://linear.app/job-radar-app/issue/JOB-46/enforce-provenance-at-final-resume-composition), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Rendered headlines and summaries can contain uncited model prose, and a verified bullet can be placed under a different employer. Provenance checking is separate from final composition and does not establish every rendered claim.

## Steps to Reproduce

Executed during the review with synthetic master/plan inputs under the TypeScript runtime: create two roles with separate verified bullets; select role B's bullet under role A and provide invented headline/summary text; enforce provenance, then compose. This was an isolated function-path reproduction, not an end-to-end paid CLI run.

## Expected Behavior

Every rendered claim and employment attribution comes from verified master evidence. Unsupported material is dropped or reverted to master wording.

## Actual Behavior

Zero provenance violations; invented prose and cross-employer attribution survive composition.

## Acceptance Criteria

- [ ] One final composition interface accepts untrusted plans and enforces all provenance before producing renderable text.
- [ ] Headline/summary select master-authored facts or approved variants; legacy arbitrary prose falls back safely without a paid call.
- [ ] A bullet must belong to its selected role; unknown/unverified citations are dropped.
- [ ] Rewrites cannot borrow another role's technology, introduce numbers, or promote unsupported scope; uncertain paraphrases revert to master wording.
- [ ] Fresh tailoring, saved-plan reuse, and re-rendering use the same interface; adversarial regression fixtures cover all three.
- [ ] Full tests/typecheck pass and tailoring/re-render command paths are exercised with synthetic data and no invented user facts.

## Constraints

The master resume is the only resume fact source. Never loosen provenance checks; repair rather than trust. Preserve covered/partial/gap and independently evidenced qualifiers. No automatic submission or sending.

## Blocked by

None (can start immediately).
