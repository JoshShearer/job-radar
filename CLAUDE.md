# Job Radar: project instructions

Local-first job search assistant. Read `README.md` for the design, `CONTEXT.md` for the vocabulary, and `docs/adr/` for decisions. `docs/ARCHITECTURE_AUDIT_2026-10-13.md` explains why the previous version (tag `v1-final`) was replaced; `docs/archive/v1/` holds its design history.

These rules are enforced by code or tests. Do not weaken the mechanism to make a change easier.

## Non-negotiable rules

**Never invent experience.** `config/candidate/evidence.yaml` is the only source of claims about the candidate. No prompt, config prose or code may describe the candidate; `tests/architecture.test.ts` checks the prompts file. Never fabricate employers, metrics, technologies, or a person's name. Never claim to have inspected a company's website, traffic, or codebase. A posting demand with no evidence is a gap: say so.

**All outbound text is verified, by allowlist.** Resume rewrites, cover letters, form answers and outreach go through `src/domain/materials/verify.ts`: numbers (digits or words), technologies, scope, qualifiers and names must trace to the cited claims, or to the target (company, role, the posting's department/team). A failed resume rewrite reverts to the candidate's own wording; a failed pack sentence is removed and listed in `pack-review.md`; a form answer with any failed sentence is not used. Headlines and summaries are chosen from the candidate's own variants, never written.

Reverting is always available, so strictness costs polish, never truth. **Never loosen a verifier rule to let a rewrite through.** Fixing a *false* refusal is allowed only with a test that pins the real overreach on the same input as still refused (see the "false refusals observed on a live pack" tests). Bump `MATERIAL_RULES_VERSION` whenever verification or composition rules change, so saved generations are re-verified (free) on the next render.

`partial` (right technology, wrong scope) in requirement matching is load-bearing: it is what prevents over-claiming. Qualifiers (leadership, team size, org-wide reach, scale, open source, migration, speaking, seniority titles, revenue impact, awards) must each be evidenced independently of the skill match. Using a library is not contributing to it.

**Never send anything.** No application, email or message. The system prepares; a human sends.

**`jr fill` fills, and stops.** It may type into an employer's form; it must never submit one. These refusals are load-bearing and must not be "improved" into answers:

1. Demographic self-identification is the candidate's to disclose or withhold.
2. Attestations ("I acknowledge I have read...") are a human certifying something.
3. An unset value in `personal.yaml` is unknown, never a default. Answering "no sponsorship needed" for someone who needs it is a false statement on a job application.

Checkboxes are never ticked. When a dropdown match is not confident, it is left blank and the offered options are reported; an exact string match is the only full-confidence match, so ties are refused rather than guessed. Pack text is used only after `jr approve` of that generation. A submission is recorded only on the human's explicit yes.

**Only public, documented endpoints.** No bypassing authentication, CAPTCHAs, rate limits, robots protections, anti-bot systems, or paywalls. `fill` drives an ordinary, undisguised browser: no stealth plugins, automation-flag masking, fingerprint spoofing or CAPTCHA solving. An active challenge stops the run. The transport's 500 ms per-host floor (in config *and* in code) and `Retry-After` handling are load-bearing. A company with no public feed goes in the watchlist.

**Remote OK attribution is a condition of use.** Their API terms require a followed link back and naming them as the source; the briefing (`src/app/briefing.ts`, `src/ui/reports/render.ts`) emits it whenever the source is enabled. If attribution is removed, disable the source instead.

## Structure

- Dependency direction (enforced by `tests/architecture.test.ts`): domain -> kernel only; app -> ports/domain/kernel; adapters never import app or ui; `src/ui/compose.ts` is the composition root.
- Domain and app never read the wall clock (enforced). Take time from `ctx.clock`.
- **Facts are append-only** (posting versions, sweeps, events, model calls, mail). Do not add UPDATE paths to fact tables; correct mistakes with `void_event`, not deletion. The only two-phase rows are ledger entries (run, model_call, sweep, mail_scan), documented in `src/adapters/sqlite/schema.ts`.
- **Derived values are memoized by the hash of their exact inputs** (`derivation`), or recomputed whole (`ranking`). Never store a derived value as if it were a fact, and never overwrite one kind of score with another: raw keyword, calibrated projection and analyst scores are separate fields.
- **State is a fold over events in occurrence order** (`src/domain/pursuit/machines.ts`): posting lifecycle (derived from sweeps), pursuit (the human's decisions), application (what employers did). An old email cannot undo a newer rejection.
- Each use case returns `ok | degraded | refused | failed` and runs inside `withRun`. Workflows and gates live in `src/app/`; the CLI and web UI are thin.
- Adapters are dumb: map a provider payload onto `RawPosting`, no classification. Judgement happens once, in `src/domain/catalog/normalize.ts`. One failing board must never abort a sweep. Pin each provider's real observed payload shape in a test.
- After changing `SqliteStore`'s public surface, run `npm run gen:port`.
- **Schema changes are a NEW entry in `MIGRATIONS`** (`src/adapters/sqlite/schema.ts`); never edit an applied one. Each migration commits with its completion marker, so a crash leaves it unapplied, not half-applied. `jr backup` (run first by the scheduled timer) takes snapshots through SQLite's online backup API.

## Determinism boundary

Deterministic code for: deduplication and identity, salary/date/location/seniority parsing, eligibility, scoring arithmetic, calibration, ranking, selection, dossier routing, verification, mail classification. These must be reproducible, cheap enough to run over the whole index every pass, and auditable when a ranking looks wrong.

Model reasoning only for: semantic fit and positioning, company and posting interpretation, resume selection and rewording (then verified), cover letters and form answers (then verified), evidence import from free text (then reviewed). If you reach for a model to compare two strings or add up weights, stop.

## Cost control

Only `assess`, `tailor`, `prepare`, `evidence import` and `benchmark-triage` call a model, and **every paid call goes through `src/app/gateway.ts`**. Never call `ModelClient` directly. Preserve all of:

1. **Same request, same answer.** A request is addressed by the hash of its exact prompt, model and effort (a cached answer is re-validated against the current schema before use). An unchanged posting is never re-bought. Keep prompts free of volatile content (dates relative to today, calibrated scores, URLs): anything volatile silently re-buys every assessment. The deterministic note sent to the model excludes `WARNING:` lines and combo prose for this reason.
2. **Reserve before calling.** The worst case (prompt size plus `max_output_tokens`) is reserved against the run, day and month budgets in one transaction; a call that could cross a ceiling is refused before it is made.
3. **Receipt for everything.** Refusals, truncations, invalid JSON, schema failures and API errors are all receipted; a call with no usage block counts at its reserved worst case, never zero. Reported run spend comes from the ledger (`runSpend`), never from a running sum of successes.
4. **Selection by rank, not by an absolute fit gate** (ADR-0001), spread across companies with per-company caps.
5. **Two-stage routing** (cheap triage, dossier only when earned) is a router, not a replacement. `jr benchmark-triage --mode routing` is the gate for trusting it: 0 missed dossiers across at least 40 baselines independent of triage routing. As of 2026-10-14 that has not been re-measured on this version.
6. **Prompt caching** on the stable system prefix, and a truncated description budget.

`jr tailor` and `jr prepare` reuse their plan unless the **posting** changed materially. An evidence or rules change re-composes and re-verifies the saved plan for free, so a stale plan can miss a new claim but can never assert a removed one. Generations are immutable directories under `artifacts/`; one that may already have been sent is never overwritten. `--force` re-plans on purpose.

## Structured output

All model output is validated with Zod before anything is stored; malformed output is rejected and receipted, never stored. The JSON Schema sent to the API is generated from the same Zod schema (`src/domain/llm/structured.ts`); constraints the API does not support are stripped and restated in the field description, because a limit the model is never told is one it breaks.

## Config over code

Search strategy (`config/search/strategy.yaml`), preferences (`config/candidate/preferences.yaml`), policy (`config/policy/evaluation.yaml`), operations (`config/operations.yaml`) and sources (`config/sources.yaml`) are data. If a tuning change requires editing TypeScript, that is a design bug. Every config file is strict (an unknown key is an error) and cross-file coherence is checked on load; keep those checks. `config.example/` is what `jr init` copies.

## Toolchain

Works with npm or pnpm. With pnpm, `pnpm-workspace.yaml` must keep `allowBuilds` true for **better-sqlite3** and **esbuild**; without it `pnpm install` succeeds and every command then fails with `Could not locate the bindings file`.

## Verification

Before claiming anything works: `npm test` and `npm run typecheck` must both pass, and the affected command must actually be run. Endpoint availability is verified against the live host, never assumed.

`npm test` launches a real Chromium (`tests/browser.refusals.test.ts`, about 40 of the ~50 s). It **fails loudly** rather than skipping when the browser is missing (`npx playwright install chromium`): a refusal test that quietly disappears leaves the suite green on a machine where nothing was checked. `npm run test:unit` is the fast inner loop; **`npm test` is the gate.**

**Page-side code must not contain named functions.** Under `tsx` (how every `npm run cli` command runs), esbuild's `keepNames` rewrites a named function into a call to a `__name()` helper that does not exist in the browser, and the test suite cannot catch it. Keep `page.evaluate` bodies to bare expressions, run loops in Node, and never swallow an evaluate error.

The browser fixture's combobox is a shim, so it cannot notice a real widget changing its contract. For any change to `src/adapters/browser/` or `src/domain/browser/`, also run a live `jr fill <id> --headless` against a real posting.

## Agent skills

### Issue tracker

Linear, team **JOB**, via the `linear-jr` MCP server; `.claude/linear.md` holds the verified statuses and labels. GitHub carries pull requests only. See `docs/agents/issue-tracker.md`.

### Triage labels

The JOB team has no triage labels and skills must not create any. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. This file holds the standing rules; ADRs hold reasoning for new decisions. See `docs/agents/domain.md`.
