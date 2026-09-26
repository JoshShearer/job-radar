# Apply mail outcomes against current chronological state

**Draft:** A03 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R3, architectural review. **Publication:** [JOB-48](https://linear.app/job-radar-app/issue/JOB-48/apply-mail-outcomes-against-current-chronological-state), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

A scan checks each email against one initial candidate snapshot. Older messages can overwrite newer outcomes already applied during that scan.

## Steps to Reproduce

Executed against an isolated database during review: seed APPLIED; return a newer rejection followed by an older invitation from a synthetic mail adapter; scan with local writes enabled. The scanner transitions to REJECTED then SCREEN. The real mailbox and live CLI inbox command were not used for this reproduction.

## Expected Behavior

Outcomes respect current state and event chronology; an older invitation cannot undo a newer rejection.

## Actual Behavior

Both decisions use the initial APPLIED snapshot, leaving SCREEN as the final state.

## Acceptance Criteria

- [ ] Process against current transactional state with an explicit chronological and late-arrival policy.
- [ ] Newer rejection survives older invitations, regardless of input ordering or scan boundaries.
- [ ] Replay is idempotent and terminal/human-owned statuses remain protected.
- [ ] Ambiguous company/title matches stay in review; no latest-job tie-break is introduced.
- [ ] Include same-scan, cross-scan, same-timestamp, duplicate, and late-email cases.
- [ ] Run isolated inbox report-only and apply commands, full tests, and typecheck.

## Constraints

Mailbox access stays read-only; classification and matching stay deterministic. Ghosting is elapsed-time inference, not parsed email. Never record APPLIED from a guessed browser or mailbox signal.

## Blocked by

- [JOB-47](https://linear.app/job-radar-app/issue/JOB-47/make-logical-job-and-outcome-writes-atomic) — Make logical job and outcome writes atomic.
