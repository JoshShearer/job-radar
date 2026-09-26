# Base posting freshness on successful employer-board sweeps

**Draft:** A05 · **Team:** JOB · **Label:** Bug · **Priority:** High (2) · **Assignee:** me · **Initial state:** Backlog
**Source:** R4, architectural review. **Publication:** [JOB-50](https://linear.app/job-radar-app/issue/JOB-50/base-posting-freshness-on-successful-employer-board-sweeps), created 2026-09-26; assigned to Josh Shearer in Backlog.

## Bug Description

Fetch errors are isolated per employer board, but freshness uses a provider-level high-water mark. Healthy sibling boards can make an unavailable board's jobs appear closed.

## Steps to Reproduce

Executed synthetic freshness/parking functions during review: one old and two recent NEW sightings all labelled greenhouse; use a three-day threshold and 0.5 parking fraction cap. The old sighting is stale and parkable. No live failed-board ingest was induced.

## Expected Behavior

Absence is inferred only from a successful complete sweep of the same employer board.

## Actual Behavior

Provider-wide observations can trigger absence and parking for another board.

## Acceptance Criteria

- [ ] Represent employer-board identity and successful/partial/failed sweep completion explicitly through adapters, storage, freshness, and preparation gates.
- [ ] Successful empty board responses are distinguishable from failed or incomplete responses.
- [ ] Board A's failure never closes A's jobs because board B succeeds; retain useful B results.
- [ ] All-source failure reports failure; partial success exposes degradation and useful counts.
- [ ] Existing sightings with unknown board provenance are handled conservatively, never guessed closed.
- [ ] Keep parking allowlists/drop guards; cover partial and empty responses with adapter/pipeline fixtures and run ingest against an isolated documented test endpoint.
- [ ] Full tests/typecheck pass; any endpoint availability claim is verified live.

## Constraints

Only public documented endpoints, positive rate limiting, no bypasses. Adapters map provider payloads without classification; central deterministic logic decides freshness. Keep Remote OK attribution when applicable.

## Blocked by

None (can start immediately).
