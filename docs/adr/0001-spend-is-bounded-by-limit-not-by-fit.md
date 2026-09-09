# Analysis spend is bounded by `--limit`, not by an absolute fit score

The `analyze` stage selects jobs by **rank** — the top K ordered by `fit_score DESC` — with
no absolute floor. Spend is bounded directly by `--limit` and `max_spend_per_run_usd`, and
*eligibility* by the deterministic hard filters (`filter_passed`). This replaced
`scoring.analysis_threshold`, an absolute fit gate, in JOB-32.

This is recorded because removing a threshold reads like removing a cost control, so the
instinct of anyone — or anything — optimizing spend is to put it back. It is the deliberate
opposite of the obvious path.

## Why the gate was wrong

The keyword engine's absolute score is not accurate enough to gate on:

- Mean absolute error against the analyst is **26.6 points on a 0–100 scale**.
- Measured over **406 analyzed jobs**, the hit rate is **not monotonic** through the middle
  of the range: the 40–49 band returns 8.1%, while 50–59 returns 6.5% and 60–74 returns 6.8%.

The **rank is reliable even though the score is not**. Ordering by it and taking the top K
spends the same money on strictly better-chosen jobs.

A second cost was diagnostic. A gate set above what the scorer could actually produce made
`analyze` report an exhausted index when the index was full — the message was describing the
gate, not the jobs. That misreading cost an afternoon of adding job boards that were never
the constraint.

## Consequences

- Do **not** reintroduce an absolute fit gate as a spend control. If a particular pass wants
  a floor, that is `--min-fit`, an explicit human choice for that run rather than a standing
  default nobody re-derives.
- The four surviving cost-control mechanisms are the ones to preserve: deterministic
  prefilters, the content-addressed analysis cache, prompt caching on the stable system
  prefix, and the truncated description budget.
- `--min-fit` must keep reporting how many unanalyzed jobs sit *below* the floor, so an
  over-set flag never again looks like an empty index.

See `src/db/repo.ts` (`needingAnalysis`) and `src/analysis/analyzer.ts` for the
implementation, and the **Cost control** section of `CLAUDE.md` for the standing rule.
