# Reconcile current operational documentation

**Draft:** A21 · **Team:** JOB · **Label:** Improvement · **Priority:** Low (4) · **Assignee:** me · **Initial state:** Backlog
**Source:** Documentation-drift follow-up, architectural review. **Publication:** [JOB-66](https://linear.app/job-radar-app/issue/JOB-66/reconcile-current-operational-documentation), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Bring current architecture, setup, testing, command, feature-status, and budget documentation into agreement with the implementation at the time of this task.

## Why

Current documents contain conflicting test counts, a sub-second suite claim despite a real-browser harness, an older Node requirement, implemented features marked unimplemented, and overstated budget guarantees.

## Impact

Operators and agents make incorrect setup, verification, and architecture decisions from stale guidance.

## Suggested Approach

Use package requirements, actual commands, current configuration, and the C4 map as evidence. Keep historical audits dated rather than rewriting past measurements. Prefer commands/contracts over duplicating volatile counts; date any retained measurements.

## Acceptance Criteria

- [ ] Current runtime requirement, browser installation, default test gate, command behavior, and implemented capabilities agree with code.
- [ ] Budget and provenance guarantees are qualified honestly until their corrective tasks actually land.
- [ ] Roadmap entries distinguish shipped behavior from genuinely missing capability without marking planned work complete.
- [ ] C4/review/plan links resolve; diagrams render when edited.
- [ ] Verify any operational behavior claimed by running the relevant command; disclose environment limitations and do not imply live endpoint checks were performed if they were not.
- [ ] Subsequent implementation tickets update their own affected documentation; this task does not wait for the entire program.

## Constraints

Keep all standing safety/cost/migration rules intact. Never invent measurements, observed endpoints, production outcomes, or test success. Follow writing-for-agents guidance if editing agent instruction files.

## Blocked by

None (can start immediately).
