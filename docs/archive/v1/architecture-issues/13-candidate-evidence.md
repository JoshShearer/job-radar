# Build paid prompts from verified master evidence

**Draft:** A13 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R9, architectural review. **Publication:** [JOB-58](https://linear.app/job-radar-app/issue/JOB-58/build-paid-prompts-from-verified-master-evidence), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Analysis and pack prompts embed candidate accomplishments in code rather than consuming the verified resume master. Correcting master facts need not correct later drafts or verdicts.

## Steps to Reproduce

Code-confirmed only. No false document was generated through a paid command. Reproduce with a synthetic master claim removed between two prompt builds and show whether the old coded claim persists.

## Expected Behavior

New paid requests use one versioned view of current verified candidate evidence; search configuration remains preferences and policy.

## Actual Behavior

Hardcoded prompt facts and master resume facts can diverge independently.

## Acceptance Criteria

- [ ] Build versioned candidate evidence from verified master data, with traceable claim references.
- [ ] Analysis and pack requests consume that view; removed/unverified claims disappear without code edits.
- [ ] Evidence changes participate in attached-analysis freshness using A06's identity.
- [ ] Missing master evidence produces explicit unknowns or a clear actionable error, never fallback invented accomplishments.
- [ ] Saved packs show their generation evidence version; corrected master facts do not silently rewrite submitted material.
- [ ] Tests cover prompt stability, corrected/removed claims, unknown evidence, reuse, and identity changes; run isolated relevant commands plus full tests/typecheck.

## Constraints

Never invent experience. Master resume is the fact source; provenance remains mechanical. Keep all four cost controls, stable prompt caching, and unchanged-input reuse. No automatic sending.

## Blocked by

- [JOB-51](https://linear.app/job-radar-app/issue/JOB-51/version-and-validate-attached-analysis-inputs) — Version and validate attached analysis inputs.
