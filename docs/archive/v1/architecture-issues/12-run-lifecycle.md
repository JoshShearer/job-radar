# Record truthful command lifecycle outcomes

**Draft:** A12 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R8 and R4, architectural review. **Publication:** [JOB-57](https://linear.app/job-radar-app/issue/JOB-57/record-truthful-command-lifecycle-outcomes), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Synchronous callback errors can bypass lifecycle catch/finally; resolved refusals can be recorded as success; started-but-interrupted runs begin with a success flag.

## Steps to Reproduce

Code-confirmed only. Reproduce through isolated commands with synchronous throw, async rejection, explicit refusal, and interrupted execution; these failing CLI cases were not run in the review.

## Expected Behavior

Run records, exit codes, and scheduler diagnostics distinguish running, succeeded, degraded, refused, failed, and interrupted work, and connections close on all handled paths.

## Actual Behavior

Promise resolution and generic success logging can misclassify failures and skip cleanup.

## Acceptance Criteria

- [ ] Use a lifecycle owner that catches sync/async failures and finalizes/cleans up reliably.
- [ ] Explicit command outcomes drive stored status and exit behavior; `{ok:false}` is not success.
- [ ] An unfinished run is not counted as a completed success; historical rows have defined compatibility semantics.
- [ ] Scheduler/report queries consume the new outcome contract without treating partial observation as full refresh.
- [ ] Test/refuse/fail/interrupt real isolated commands; full tests/typecheck pass.

## Constraints

Use additive migrations and preserve diagnostic history. No change to human refusal/override semantics, submission ownership, or automatic spending defaults.

## Blocked by

None (can start immediately).
