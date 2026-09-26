# Preserve source aliases through deduplication

**Draft:** A18 · **Team:** JOB · **Label:** Improvement · **Priority:** Low (4) · **Assignee:** me · **Initial state:** Backlog
**Source:** History/identity follow-up, architectural review. **Publication:** [JOB-63](https://linear.app/job-radar-app/issue/JOB-63/preserve-source-aliases-through-deduplication), created 2026-09-26; assigned to Josh Shearer in Backlog.

## What

Persist every original source/board identity and sighting for a canonical opportunity, including duplicates collapsed within a batch, and resolve later observations through those aliases.

## Why

Only canonical batch candidates currently reach persistence, so source pointers can be lost. Cross-run lookup does not fully use the retained alias relationship.

## Impact

Source coverage and presence history become incomplete; syndicated observations can be hard to associate consistently over time.

## Suggested Approach

Carry alias/sighting evidence through deterministic batch dedupe into storage. Define identity ownership using the explicit board model before considering any wider fuzzy matching.

## Acceptance Criteria

- [ ] All observed URLs/provider external IDs/board identities survive a within-batch merge with first/last seen information.
- [ ] A later observation through any saved alias resolves to the existing canonical job.
- [ ] Replayed sightings remain idempotent; conflicts are visible instead of silently merging distinct jobs.
- [ ] Preserve separate seniority/level identities and human application history.
- [ ] Do not broaden fuzzy matching as part of this task; exercise isolated multi-run ingest fixtures plus full tests/typecheck.

## Constraints

Dedupe remains deterministic and auditable; no LLM comparisons. Preserve source failure isolation, board-specific freshness, public endpoint restrictions, and source attribution.

## Blocked by

- [JOB-50](https://linear.app/job-radar-app/issue/JOB-50/base-posting-freshness-on-successful-employer-board-sweeps) — Base posting freshness on successful employer-board sweeps.
