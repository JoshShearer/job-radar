# Publish application artifacts as coherent generations

**Draft:** A11 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R7, architectural review. **Publication:** [JOB-56](https://linear.app/job-radar-app/issue/JOB-56/publish-application-artifacts-as-coherent-generations), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

New stamps can precede new pack content, while failed PDF rendering can leave an old attachment alongside newer plan/HTML files. Reuse and autofill select by existence rather than coherent generation.

## Steps to Reproduce

Code-confirmed failure scenario, not fault-injected during review. Reproduce with an existing fixture pack, a changed posting, and interruption after stamp publication but before content replacement; separately fail PDF printing.

## Expected Behavior

Reusable content and selected attachments belong to one identified completed generation.

## Actual Behavior

New input stamps can certify old content; an older PDF can be selected as though it matches newly rendered material.

## Acceptance Criteria

- [ ] One artifact-store interface loads/publishes generation manifests with content hashes and render status.
- [ ] Temporary writes and atomic publication prevent mixed generations at every interruption point.
- [ ] Attachment selection reports generation/freshness honestly; incomplete printing cannot silently reuse an old PDF as newly tailored.
- [ ] Preserve older reviewed/submitted generations and honest legacy-unstamped handling.
- [ ] Master changes reuse selection and re-check provenance; re-render is free; `--force` remains deliberate reselection.
- [ ] Run isolated preparation/render commands and interrupted-write tests, full tests/typecheck, and human-reviewed live autofill for changed attachment/browser paths.

## Constraints

Never auto-submit/send. Preserve checkbox/demographic/attestation/unknown-value refusals and active-challenge stops. Never loosen provenance or silently regenerate already reviewed material.

## Blocked by

None (can start immediately).
