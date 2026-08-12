# Job Radar — project instructions

Local-first job intelligence pipeline. Read `README.md` for architecture and `TODO.md` for roadmap.

## Non-negotiable rules

**Never invent experience.** Not in prompts, not in generated resume text, not in outreach drafts, not in analysis output. If a posting demands something not in the career profile, that is a gap — say so. Never fabricate employers, metrics, technologies, or a person's name. Never claim to have inspected a company's website, traffic, or codebase.

**Never auto-send anything.** No application, no email, no LinkedIn message. The system prepares; a human sends. This is the whole point of the design.

**Only public, documented endpoints.** No bypassing authentication, CAPTCHAs, rate limits, robots protections, anti-bot systems, or paywalls. If a company has no public feed, it goes in `watchlist` and gets researched by hand. Rate limiting in `PoliteFetcher` is load-bearing — do not remove it or configure it to zero.

**Remote OK attribution is a condition of use.** Their API terms require a followed link back and naming them as the source. `src/report/daily.ts` emits it. If that attribution is removed, disable the source rather than violating the terms.

## Determinism boundary

Use **deterministic code** for: deduplication, salary parsing, date parsing, location classification, seniority classification, schema validation, hard filters, scoring arithmetic.

Use **LLM reasoning** only for: semantic fit, career positioning, company analysis, job-description interpretation, outreach personalization, interview prep.

If you find yourself reaching for a model to compare two strings or add up weights, stop. Those must be reproducible, cheap enough to run over the whole index on every pass, and auditable when a ranking looks wrong.

## Cost control

The `analyze` stage is the only thing that costs money. Preserve all four mechanisms:

1. Deterministic prefilters gate eligibility (`analysis_threshold`)
2. Content-addressed cache keyed on description + title + company + model + profile
3. Prompt caching on the stable system prefix (`cache_control: ephemeral`)
4. Truncated description budget

Never re-analyze an unchanged job. If a description changes, `repo.upsert` already invalidates the cached analysis and score — keep that behavior.

## Structured output

All model output that reaches the database goes through a JSON Schema *and* is re-validated with Zod (`AnalysisSchema`). Malformed output is rejected, never stored. Do not let a model write free prose into a column.

## Adding a source

Adapters are dumb by design: map the provider payload onto `SourceJob`, do no classification. All judgement happens once in `pipeline/normalize.ts`.

Every adapter must catch its own errors and record them on `ctx.stats`. **One failing source must never abort a run.** There is a test for this; keep it passing.

Add a test in `tests/sources.test.ts` pinning the real observed payload shape, so a provider renaming a field surfaces as a failing test rather than silently empty results.

## Config over code

Search strategy lives in `config/career-profile.yaml`. Scoring weights, filters, lanes, thresholds, and exclusions are all data. If a tuning change requires editing TypeScript, that is a design bug — move it to config.

Config is validated on load with cross-field coherence checks (lane weights sum to 1, compensation bands ordered, signals reference real lanes). Keep those checks; a typo that silently disables a filter is worse than a crash.

## Verification

Before claiming anything works: `npm test` (173 tests) and `npm run typecheck` must both pass, and the relevant command must actually be run. Endpoint availability is verified against the live host, never assumed — board tokens in `config/sources.yaml` were each confirmed to return HTTP 200 with a non-empty job list.
