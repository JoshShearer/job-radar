# ADR 0005: What may diverge inside a recovery set

Date: 2026-11-24. Status: accepted. Issue: JOB-80 (follow-up to JOB-64).

## Context

`jr backup` reads three stores one after another: the database (an online-backup snapshot), then `config/`, then `artifacts/`. Nothing freezes them at one instant, so a set can mix moments. Until now the manifest did not say how, and three cases were silent: a generation published during the backup, a generation the database references that was not in the set, and retention pruning the only set that still held one.

## Decision

The order stays database, config, artifacts. A row is recorded only after its generation is renamed into place, so in a healthy run every generation the snapshot references is on disk when `artifacts/` is copied.

| Divergence | Accepted? | What happens |
|---|---|---|
| **Orphan generation**: in the set, not referenced by the snapshot (published during the backup, or never recorded after a crash) | Yes | Listed in the manifest and the notes. Backup and restore stay `ok`. |
| **`config/` newer than the database** | Yes | Both capture windows are recorded. Restore says it may be newer and does not refuse. |
| **Missing generation**: referenced by the snapshot, but a recorded file is absent or has other bytes, or the recorded file list cannot be read | No | Backup and restore are `degraded` and list it. The set stays verified and restorable. |
| **Artifacts left out on request** | Yes | `not-checked`, with the count of generations it does not hold. |

Reconciliation compares the references in the **staged** database (never the live one, which may already have newer rows) with the hashed files of the set (never a directory listing), so it describes what a restore reproduces. An empty generation directory has no files and is not listed.

**A missing generation does not make the set unverified.** Unverified sets are never counted or restored. Facts are append-only, so the row of a lost generation can never be removed, and one loss would disable recovery of everything else for good.

**Reconciliation never stops a restore.** It is a derived value. Restore re-derives it from the restored database and files and reports that result; a manifest that says otherwise (a hand edit, or a later code version reading an old set) makes the restore `degraded`, with the differences listed, not `failed` or `refused`. The row counts next to it are facts of the snapshot, and a mismatch there still fails. The only reconciliation rules that can make a set unverified are contradictions with the capture record (for example, marked checked with `artifacts/` never captured). They are keyed on `capture.artifacts` and `reconciliation.state`, never on reason text.

**Retention keeps the last copy.** For each generation the new set does not hold, the newest verified set that does is kept beyond `--keep` and named. When no set holds the whole of one, the newest holder of each recorded file is kept.

**Manifest format 2** adds `capture` and `reconciliation`. A later change to the shape, to what identifies a generation, or to the reconciliation rules is a new format. `tests/fixtures/recovery-sets/` holds literal sets of both formats that must keep verifying and restoring; do not regenerate them with product code.

**Format 1** sets stay verifiable, counted by retention, and restorable, with a note that neither capture times nor reconciliation were recorded. Restore could run the same comparison on them for free. It does not, because the decision on JOB-80 was that format-1 restores keep their outcome and are never held to a reconciliation they were not written with. This is a cheap improvement left for the owner to ask for: until format-1 sets age out, restoring one does not report a missing generation.

## Rejected

- **Reading references from the live database**: the row of a generation published during the backup would make it look referenced.
- **Snapshotting the database again after the copy, or last**: a row could then reference a generation that was not copied.
- **One lock across the three stores**: none exists, and accepting listed orphans is cheaper and honest.
- **Copying a generation from its recorded directory outside `artifacts/`**: a set copies only its declared trees; a database row must not make backup read elsewhere. It is reported as missing, with what to do.

## Consequences

- Code from before this change cannot read format-2 sets: it lists them as `no-manifest`, keeps them, and `jr restore` refuses them. The files are still a plain Job Radar home and can be copied by hand.
- Retention can hold a few sets above `--keep` while a generation stays missing. A permanently lost generation makes every backup `degraded` (exit code 0, so the scheduled pass still runs).
