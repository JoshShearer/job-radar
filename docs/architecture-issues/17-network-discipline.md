# Enforce transport delay and Retry-After semantics

**Draft:** A17 · **Team:** JOB · **Label:** Bug · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** Network follow-up, architectural review. **Publication:** [JOB-62](https://linear.app/job-radar-app/issue/JOB-62/enforce-transport-delay-and-retry-after-semantics), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Transport construction does not enforce a positive delay; Retry-After parsing handles numeric values only and caps waits at 30 seconds, which can retry before the provider permits it.

## Steps to Reproduce

Code-confirmed only; no live rate-limit response was induced. Reproduce using fake clocks and a local server returning a long numeric Retry-After and an HTTP-date value.

## Expected Behavior

Every transport caller preserves positive pacing and honors the provider's minimum retry time, or defers the request instead of retrying early.

## Actual Behavior

Constructor bypasses can remove pacing, and long/date-based retry instructions are not fully respected.

## Acceptance Criteria

- [ ] Reject zero, negative, nonfinite, or otherwise invalid delay settings at the transport interface.
- [ ] Honor both delta-seconds and HTTP-date Retry-After; excessive waits may defer/fail the run but never retry early.
- [ ] Preserve host serialization, bounded retries, and failure isolation.
- [ ] Tests use a fake clock/local endpoint for 429/503, invalid headers, cancellation, and long waits without hammering live providers.
- [ ] Document limiter scope as per-instance/process; do not imply cross-process coordination exists.
- [ ] Run an isolated source command and full tests/typecheck; verify any real endpoint availability claim live.

## Constraints

Public documented endpoints only. Never bypass authentication, anti-bot systems, CAPTCHAs, or rate limits. Adapters stay classification-free and one source failure never aborts healthy-source work.

## Blocked by

None (can start immediately).
