# Job Radar — project instructions

Local-first job intelligence pipeline. Read `README.md` for architecture and `TODO.md` for roadmap.

## Non-negotiable rules

**Never invent experience.** Not in prompts, not in generated resume text, not in outreach drafts, not in analysis output. If a posting demands something not in the career profile, that is a gap — say so. Never fabricate employers, metrics, technologies, or a person's name. Never claim to have inspected a company's website, traffic, or codebase.

**Resume provenance is a mechanism, not a guideline.** `config/resume.yaml` is the only source of resume fact. A tailored resume is a SELECTION from it: the model returns bullet ids and replacement strings, and `src/resume/render.ts` assembles the document from master data. Never let a model emit resume prose directly into a rendered document.

`enforceProvenance` must keep repairing rather than trusting: unknown or `verified: false` citations are dropped, and a rewrite that introduces a technology or a number is **reverted to the master wording**. Reverting is always available, so overreaching can only produce a worse resume, never a false one. Do not "fix" a reverted rewrite by loosening the check.

`resume match` must keep three states, not two. `partial` — right technology, wrong scope — is the category that prevents over-claiming, and the qualifiers in `QUALIFIERS` (leadership, open source, enterprise scale, migration, public speaking) each have to be evidenced independently of the skill match. Using a library is not contributing to it.

**Never auto-send anything.** No application, no email, no LinkedIn message. The system prepares; a human sends. This is the whole point of the design.

**`autofill` fills, and stops.** It may type into an employer's form; it must never submit one. Three refusals are load-bearing and must not be "improved" into answers:

1. Demographic self-identification is the candidate's to disclose or withhold.
2. Attestations ("I acknowledge I have read…") are a human certifying something.
3. An unset value in `personal.yaml` is unknown, never a default. `work_eligibility` is nullable for this reason — answering "no sponsorship needed" for someone who needs it is a false statement on a job application, not a mis-ranking.

Checkboxes are never ticked. When a dropdown match is not confident, leave it blank and report the options that were offered. `chooseOption` reserves a score of 1.0 for exact string equality precisely so full-token-coverage ties (`"…for any employer"` vs `"…for my current employer only"`) are refused instead of guessed.

**Only public, documented endpoints.** No bypassing authentication, CAPTCHAs, rate limits, robots protections, anti-bot systems, or paywalls. `autofill` drives an ordinary browser and does not disguise itself: no stealth plugins, no automation-flag masking, no fingerprint spoofing, no CAPTCHA solving. An active challenge stops the run. If bot scoring rejects a legitimate human-reviewed submission, the fix is to fill that form by hand. If a company has no public feed, it goes in `watchlist` and gets researched by hand. Rate limiting in `PoliteFetcher` is load-bearing — do not remove it or configure it to zero.

**Remote OK attribution is a condition of use.** Their API terms require a followed link back and naming them as the source. `src/report/daily.ts` emits it. If that attribution is removed, disable the source rather than violating the terms.

## Schema migrations

`applyColumnMigrations` is **additive only** and runs from `openDb()`, on the hot path of every command and every test. A migration entry may carry a one-time `backfill` that fires only on the pass that creates the column.

Anything destructive lives in `applyDestructiveMigrations` and runs **only** from `job-radar migrate`, never automatically. That command backs up first and verifies the copy's byte size before dropping anything — a truncated backup is worse than none, because it looks like one. `VACUUM` cannot run inside a transaction, which is the other reason this is a command rather than part of startup.

## Determinism boundary

Use **deterministic code** for: deduplication, salary parsing, date parsing, location classification, seniority classification, schema validation, hard filters, scoring arithmetic.

Use **LLM reasoning** only for: semantic fit, career positioning, company analysis, job-description interpretation, outreach personalization, interview prep.

If you find yourself reaching for a model to compare two strings or add up weights, stop. Those must be reproducible, cheap enough to run over the whole index on every pass, and auditable when a ranking looks wrong.

## Cost control

The `analyze` stage is the only thing that costs money. Preserve all four mechanisms:

1. Deterministic prefilters gate eligibility (`filter_passed`), and selection takes the top K by **rank**
2. Content-addressed cache keyed on material hash + title + company + model + evidence + tier
3. Prompt caching on the stable system prefix (`cache_control: ephemeral`)
4. Truncated description budget

Two-tier analysis (`analysis_detail.two_stage`) is **on** as of 2026-09-09, enabled on a measured routing benchmark: 0 missed dossiers across 45 dossier-routing baselines. It is a router, not a replacement — the verdict-accuracy bar still fails at 88.9% against 92%, and that finding stands. Note that the predicted cost saving is **not yet observed**: the first two-stage pass measured $0.0474/job against a $0.0459/job single-stage baseline. Treat the saving as unproven until several daily passes say otherwise.

`analysis_threshold` used to be mechanism 1 and was retired in JOB-32. It gated on an absolute keyword score whose mean absolute error against the analyst is 26.6 points, and whose hit rate is not monotonic through the middle of its range. Spend is now bounded *directly* by `--limit` and `max_spend_per_run_usd` instead of by proxy, and eligibility by the filters, which encode constraints that are actually real. Do not reintroduce an absolute fit gate as a spend control; if a pass needs a floor, that is `--min-fit` for that pass.

Never re-analyze an unchanged job. If a description changes **materially**, `repo.upsert` invalidates the cached analysis and score — keep that behavior.

"Materially" is the mechanism, not a hedge (JOB-44). `descriptionHash` is byte-level and still drives `job_events`, so change history stays exact; `materialHash` — a sorted token multiset — drives invalidation, because a board re-rendering the same words in a different order is not a new posting. Byte-level invalidation is what gave the cache 3 lifetime hits on 430 rows. The normalizer is biased toward calling a change material: a false "material" costs $0.046, a false "immaterial" serves a verdict formed against text that no longer exists. Do not add stopword stripping, stemming, or anything else that widens what counts as immaterial without measuring it against the whole index first.

The cache key is `(materialHash, title, company, model, evidenceVersion, tier)`. `evidenceVersion` hashes the system prompt plus the **calibration-stable** half of the deterministic note; `fitScore` and `applicationRoi` are deliberately excluded, because `project()` rewrites exactly those on every scoring run and hashing them would invalidate the cache continuously. `tier` separates a triage stub from a dossier — without it the stub is served forever to the pass trying to buy the dossier.

The same rule applies to the two per-job documents. `resume tailor` and `apply` reuse a saved `resume-plan.json` / `pack.json` rather than calling the model again, keyed on the stamps in `applications/<job>/generation.json` (`src/apply/reuse.ts`). A changed **posting** regenerates; a changed **master resume** reuses and says so, because `enforceProvenance` re-checks every citation on render, so a stale plan can miss new bullets but can never become a false one. `--force` regenerates deliberately.

This is not only cost. Bullet selection is a model decision, so re-running `tailor` returns a *different* resume for the same posting — silently replacing a document that may already have been read, approved, or submitted. Reuse is the correct default; regenerating is what needs asking for.

## Structured output

All model output that reaches the database goes through a JSON Schema *and* is re-validated with Zod (`AnalysisSchema`). Malformed output is rejected, never stored. Do not let a model write free prose into a column.

## Adding a source

Adapters are dumb by design: map the provider payload onto `SourceJob`, do no classification. All judgement happens once in `pipeline/normalize.ts`.

Every adapter must catch its own errors and record them on `ctx.stats`. **One failing source must never abort a run.** There is a test for this; keep it passing.

Add a test in `tests/sources.test.ts` pinning the real observed payload shape, so a provider renaming a field surfaces as a failing test rather than silently empty results.

## Config over code

Search strategy lives in `config/career-profile.yaml`. Scoring weights, filters, lanes, thresholds, and exclusions are all data. If a tuning change requires editing TypeScript, that is a design bug — move it to config.

Config is validated on load with cross-field coherence checks (lane weights sum to 1, compensation bands ordered, signals reference real lanes). Keep those checks; a typo that silently disables a filter is worse than a crash.

## Toolchain

Works with npm or pnpm. With pnpm, `pnpm-workspace.yaml` must keep `allowBuilds` set to `true` for **better-sqlite3** (native SQLite binding) and **esbuild** (backs tsx and vitest). pnpm blocks build scripts by default, and without those approvals `pnpm install` succeeds while leaving the project broken — every command then fails with `Could not locate the bindings file`.

## Verification

Before claiming anything works: `npm test` (902 tests) and `npm run typecheck` must both pass, and the relevant command must actually be run. Endpoint availability is verified against the live host, never assumed — board tokens in `config/sources.yaml` were each confirmed to return HTTP 200 with a non-empty job list.

`npm test` launches a real Chromium. `tests/autofill.browser.test.ts` drives a saved application form from `file://` and asserts the refusals in `src/apply/` — no checkbox ticked, no attestation affirmed, no demographic question answered, submit never clicked, each combobox reading only its own listbox. It needs `npx playwright install chromium`, and it **fails loudly** rather than skipping when the browser is missing: a refusal test that quietly disappears leaves the suite green on a machine where nothing was checked.

It costs about 40s of the ~42s run (measured 2026-08-17; the previously documented 12s was stale). That stays in the default `npm test` rather than behind an opt-in flag, because a refusal test you have to remember to run is one that does not run. `npm run test:unit` (1s) is the fast inner loop while iterating; `npm run test:browser` runs the harness alone. **`npm test` is the gate** — neither of the other two is sufficient before claiming something works.

**Page-side code must not contain named functions.** Under `tsx` — which is how every `npm run cli` command runs — esbuild's `keepNames` rewrites a named function, including `const sleep = (ms) => ...`, into a call to a `__name()` helper that does not exist in a browser. Any `page.evaluate` body containing one dies with `ReferenceError: __name is not defined`. Vitest transpiles differently, so **the test suite cannot catch this**: `revealLazyContent` passed every test and threw on every real run, and a `.catch` hid it. Keep `page.evaluate` bodies to bare expressions, run loops in Node, and never swallow an evaluate error silently.

The fixture's combobox behaviour is a shim standing in for react-select, so it cannot notice react-select changing the contract it depends on. Running `autofill` against a live posting stays part of shipping any `src/apply/` change; the harness supplements that, it does not replace it.

## Agent skills

### Issue tracker

Linear, team **JOB**, via the `linear-jr` MCP server; `.claude/linear.md` holds the
verified statuses and labels. GitHub carries pull requests only. See
`docs/agents/issue-tracker.md`.

### Triage labels

The JOB team has no triage labels and skills must not create any. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. This file holds the
standing rules; ADRs hold reasoning for new decisions. See `docs/agents/domain.md`.
