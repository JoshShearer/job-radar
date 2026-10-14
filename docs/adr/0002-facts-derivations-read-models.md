# ADR 0002: Facts, memoized derivations, and read models

Date: 2026-10-14. Status: accepted.

## Context

The original Job Radar kept observations, derived scores, cached model output and human decisions as overwritable columns on one `jobs` row. Every correctness fix added columns, snapshot hashes and invalidation rules. Three reviews found the same class of bug repeatedly: stale verdicts, lost history, inference from missing observations, and spend that was not recorded.

## Decision

1. **Facts are append-only**: posting versions, sweeps, pursuit and application events, model calls, mail messages, artifacts, approvals, overrides. Corrections are `void_event`s.
2. **Expensive derivations are memoized by input**: a model answer is stored under the hash of exactly the request that produced it. "Current" means the answer to the request we would make now, so invalidation is a lookup, not code.
3. **Read models are disposable**: the ranking is rebuilt whole by `evaluate` in one transaction.
4. **State is a fold**: pursuit and application state are pure functions of their events, ordered by when things happened.
5. **Absence is inferred only from complete observation**: posting closure from complete board sweeps, silence from complete mail coverage.

## Consequences

- No staleness code: changed inputs produce a different address.
- History is complete by construction.
- Some indexes (`alias`, `opportunity`) are maintained alongside facts for speed; they are reconstructible.
- Evaluation recomputes cheap deterministic scores on every pass (about a second per 15k postings), which is simpler than memoizing them.
