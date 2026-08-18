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

Before claiming anything works: `npm test` (489 tests) and `npm run typecheck` must both pass, and the relevant command must actually be run. Endpoint availability is verified against the live host, never assumed — board tokens in `config/sources.yaml` were each confirmed to return HTTP 200 with a non-empty job list.

`npm test` launches a real Chromium. `tests/autofill.browser.test.ts` drives a saved application form from `file://` and asserts the refusals in `src/apply/` — no checkbox ticked, no attestation affirmed, no demographic question answered, submit never clicked, each combobox reading only its own listbox. It needs `npx playwright install chromium`, and it **fails loudly** rather than skipping when the browser is missing: a refusal test that quietly disappears leaves the suite green on a machine where nothing was checked.

It costs about 40s of the ~42s run (measured 2026-08-17; the previously documented 12s was stale). That stays in the default `npm test` rather than behind an opt-in flag, because a refusal test you have to remember to run is one that does not run. `npm run test:unit` (1s) is the fast inner loop while iterating; `npm run test:browser` runs the harness alone. **`npm test` is the gate** — neither of the other two is sufficient before claiming something works.

**Page-side code must not contain named functions.** Under `tsx` — which is how every `npm run cli` command runs — esbuild's `keepNames` rewrites a named function, including `const sleep = (ms) => ...`, into a call to a `__name()` helper that does not exist in a browser. Any `page.evaluate` body containing one dies with `ReferenceError: __name is not defined`. Vitest transpiles differently, so **the test suite cannot catch this**: `revealLazyContent` passed every test and threw on every real run, and a `.catch` hid it. Keep `page.evaluate` bodies to bare expressions, run loops in Node, and never swallow an evaluate error silently.

The fixture's combobox behaviour is a shim standing in for react-select, so it cannot notice react-select changing the contract it depends on. Running `autofill` against a live posting stays part of shipping any `src/apply/` change; the harness supplements that, it does not replace it.
