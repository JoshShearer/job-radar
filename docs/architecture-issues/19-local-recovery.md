# Back up and restore the irreplaceable local data set

**Draft:** A19 · **Team:** JOB · **Label:** Improvement · **Priority:** Normal (3) · **Assignee:** me · **Initial state:** Backlog
**Source:** Backup-coverage follow-up, architectural review. **Publication:** [JOB-64](https://linear.app/job-radar-app/issue/JOB-64/back-up-and-restore-the-irreplaceable-local-data-set), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Provide a documented, verifiable local recovery path for the database, master candidate evidence, personal answers, and saved application generations.

## Why

A SQLite backup alone does not preserve the factual master or already-reviewed generated materials. Regenerating those is not equivalent to restoring them.

## Impact

Database recovery can succeed while losing facts, human-entered answers, or the exact documents previously reviewed/submitted.

## Suggested Approach

Build on consistent SQLite snapshots and coherent generation manifests. Define the recovery set and manifest explicitly, distinguishing irreplaceable evidence from rebuildable reports and operational browser state. Keep recovery local and make destination/overwrite behavior deliberate.

## Acceptance Criteria

- [ ] Backup manifest names included data, versions/hashes, exclusions, and completion state.
- [ ] Master/personal evidence and retained application generations are recoverable together with the database.
- [ ] Credentials and browser session inclusion/exclusion are explicit; no automatic upload or accidental version-control inclusion.
- [ ] Partial backups are not reported complete and retention does not prune the last verified recovery set.
- [ ] Perform a restore into an isolated destination and verify facts, history, and saved artifact identity without paid regeneration.
- [ ] Run backup/restore commands and full tests/typecheck for implementation changes.

## Constraints

Never silently overwrite the user's working data, regenerate reviewed resumes, or invent missing facts. Preserve verified SQLite backup mechanics, bounded retention, and explicit destructive actions.

## Blocked by

- [JOB-55](https://linear.app/job-radar-app/issue/JOB-55/create-verified-sqlite-snapshots-under-concurrent-access) — Create verified SQLite snapshots under concurrent access.
- [JOB-56](https://linear.app/job-radar-app/issue/JOB-56/publish-application-artifacts-as-coherent-generations) — Publish application artifacts as coherent generations.
