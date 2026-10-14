# Resume mailbox scans without skipping backlog

**Draft:** A04 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R3, architectural review. **Publication:** [JOB-49](https://linear.app/job-radar-app/issue/JOB-49/resume-mailbox-scans-without-skipping-backlog), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Only one Gmail page is fetched while maximum recorded email time becomes the next lower bound. Older unprocessed pages can be excluded from subsequent scans.

## Steps to Reproduce

Code-confirmed during review; no multipage mailbox or failing user command was run. Reproduce with a paginated provider fixture before implementing, including a second page older than the first page's newest message.

## Expected Behavior

A bounded scan can stop and resume without dropping messages or prematurely advancing its completed-range watermark.

## Actual Behavior

Page continuation is ignored and recorded newest mail can advance the next query beyond unread backlog.

## Acceptance Criteria

- [ ] Persist provider-specific scan progress and completed ranges separately from latest message time.
- [ ] Traverse continuation pages; a run limit or interruption preserves resume position.
- [ ] Failed message fetches remain retryable and do not silently become completed progress.
- [ ] Cover more than 100 messages, expired continuation, duplicates, late arrivals, and interrupted writes using fixtures.
- [ ] Report-only mode leaves persistent cursor and outcome state unchanged.
- [ ] Run isolated inbox commands, full tests, and typecheck; state clearly whether live provider behavior was exercised.

## Constraints

Use documented read-only mailbox endpoints. Preserve deterministic classification, ambiguity refusal, atomic outcome application, and bounded fetching.

## Blocked by

- [JOB-48](https://linear.app/job-radar-app/issue/JOB-48/apply-mail-outcomes-against-current-chronological-state) — Apply mail outcomes against current chronological state.
