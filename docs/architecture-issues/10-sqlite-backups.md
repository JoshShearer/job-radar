# Create verified SQLite snapshots under concurrent access

**Draft:** A10 · **Team:** JOB · **Label:** Improvement · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** R6 backup design risk, architectural review. **Publication:** [JOB-55](https://linear.app/job-radar-app/issue/JOB-55/create-verified-sqlite-snapshots-under-concurrent-access), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Make backup and pre-destructive-migration backup use a supported consistent SQLite snapshot operation, and prove the result is restorable.

## Why

Checkpoint/close/copy is not coordinated with other connections and does not inspect checkpoint completion. The concurrency risk was identified by code inspection, not reproduced against the operational database.

## Impact

A plausible-looking backup may omit recent committed data or be inconsistent while a timer/manual command overlaps another connection.

## Suggested Approach

Own snapshot creation, verification, publication, and retention in one module. Use SQLite's backup facilities and preserve the existing byte-size verification guarantee with checks appropriate to the snapshot mechanism; do not compare a moving source file as if it were immutable.

## Acceptance Criteria

- [ ] Backup produces a complete snapshot with a concurrent reader and writer active.
- [ ] Verify expected snapshot bytes and database integrity before publishing success or permitting destructive work.
- [ ] Failed/truncated snapshots cannot replace a known-good backup or trigger pruning of recovery material.
- [ ] Restore a fixture backup and verify representative jobs, events, cache, and metadata.
- [ ] Run real isolated backup/migrate commands; full tests/typecheck pass.

## Constraints

Keep backup before destructive migration, explicit destructive execution, byte-size verification, and bounded retention. No destructive startup migration or unrequested production restore.

## Blocked by

None (can start immediately).
