# Report source and outcome observation freshness

**Draft:** A20 · **Team:** JOB · **Label:** Improvement · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R4 and outcome-quality follow-up, architectural review. **Publication:** [JOB-65](https://linear.app/job-radar-app/issue/JOB-65/report-source-and-outcome-observation-freshness), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Show whether source and outcome observations are current, incomplete, stale, unconfigured, or failed before readers interpret ranking/funnel silence.

## Why

Command success does not establish complete source coverage, and the checked-in daily schedule does not scan mail. Ghosting can be computed while mailbox observations are missing.

## Impact

Users can mistake missing evidence for closed postings or absent employer responses.

## Suggested Approach

Build report diagnostics from completed board sweeps, completed mailbox ranges, and explicit run outcomes. Show what was actually observed and the corrective command; retain sample-size protections in funnel reporting.

## Acceptance Criteria

- [ ] Briefing/dashboard expose completed source/mail observation times and partial/error states distinctly.
- [ ] Report-only inbox runs do not masquerade as persisted outcome capture or completed apply-mode scans.
- [ ] No-mail-credentials, never-scanned, incomplete-page, recent failure, and healthy silence have distinct honest outputs.
- [ ] Ghosting is labelled elapsed-time inference with the relevant observation freshness; do not silently alter transition policy or enable mailbox writes.
- [ ] Tests exercise report rendering from synthetic run/sweep/cursor state, including no observations.
- [ ] Run actual isolated reporting commands; preserve self-contained script-free output; full tests/typecheck pass.

## Constraints

Never fabricate outcomes or diagnose below required samples. Mailbox stays read-only; human submission remains human-owned. Preserve Remote OK attribution and the loopback static viewer.

## Blocked by

- [JOB-49](https://linear.app/job-radar-app/issue/JOB-49/resume-mailbox-scans-without-skipping-backlog) — Resume mailbox scans without skipping backlog.
- [JOB-50](https://linear.app/job-radar-app/issue/JOB-50/base-posting-freshness-on-successful-employer-board-sweeps) — Base posting freshness on successful employer-board sweeps.
- [JOB-57](https://linear.app/job-radar-app/issue/JOB-57/record-truthful-command-lifecycle-outcomes) — Record truthful command lifecycle outcomes.
