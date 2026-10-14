# Job Radar

A local-first job search assistant. It sweeps public job boards, ranks postings deterministically, spends money on model judgement only for the best-ranked few, prepares honest application material from your own evidence, fills forms in an ordinary browser, and reads application mail. It never submits, never sends, and never claims anything about you that your evidence does not.

Version 2 is a ground-up rebuild. `docs/ARCHITECTURE_AUDIT_2026-10-13.md` explains why version 1 (tag `v1-final`) was replaced and what this design fixes; `docs/archive/v1/` keeps its design history. **Upgrading an existing v1 checkout: follow `MIGRATING.md` before you pull.**

## Quick start

```bash
npm install
npx playwright install chromium      # form filling, PDFs, and the refusal tests
cp .env.example .env                 # ANTHROPIC_API_KEY, optional Gmail read-only credentials
npm run cli -- init                  # creates config/ from config.example/ (never overwrites)
npm run cli -- check                 # validates every config file and the evidence ledger
npm run cli -- sweep                 # fetch the configured boards
npm run cli -- evaluate              # rank everything (free, deterministic)
npm run cli -- top                   # the ranked list
npm run daily                        # sweep + evaluate + briefing (reports/latest.html)
```

Coming from version 1: see `MIGRATING.md`. In short, copy `config/` and `data/` aside into `legacy-v1/` *before* pulling, then:

```bash
npm run cli -- import-legacy --db legacy-v1/data/job-radar.sqlite --old-root legacy-v1
npm run cli -- evaluate && npm run cli -- sweep && npm run cli -- evaluate
```

This converts `career-profile.yaml` and `sources.yaml` into the split config, copies `resume.yaml` as the evidence ledger and `personal.yaml` as is, and replays the old database's history as events at their original times. It never modifies the old database. Imported assessments are kept but never count as current; until enough new ones exist they still calibrate the ranking.

## What changed, and why

| Old design | Rebuild |
|---|---|
| One ~70-column `jobs` row: observations, scores, model output and decisions overwritten in place | **Facts are append-only** (posting versions, sweeps, events, model calls, mail). Expensive results are **memoized by the hash of their exact inputs**. The ranking is a **read model** rebuilt whole |
| Eight overlapping "is this still current?" schemes | **One**: a model answer's address is the hash of exactly what the model was shown. "Current" means "the answer to the request we would make now". Staleness needs no code |
| `fit_score` meant raw, projected, or analyst depending on another column | Raw keyword, calibrated projection and analyst scores are **separate fields** |
| One `status` column mixed posting state, pursuit and outcome | **Three machines**: posting lifecycle (derived from sweeps), pursuit (your decisions), application (what employers did). State is a **fold over events in the order they happened** |
| Candidate facts hardcoded in a TypeScript prompt, plus three config files | **One evidence ledger** (`config/candidate/evidence.yaml`). Every prompt is rendered from it |
| Resume rewrites checked against a ~55-term deny-list; cover letters and form answers unchecked | **Allowlist verifier on all outbound text**: numbers (including spelled-out), technologies, scope, qualifiers and names must trace to the cited claims. Headline and summary are chosen from your own variants, never written |
| Per-run spend ceiling checked after the fact; two ledgers | **One gateway** reserves the worst case against run, day and month budgets *before* each call, and receipts every attempt in one ledger |
| Workflows and gates lived in a 2,400-line CLI | **Use cases** own their ordering and gates; the CLI and web UI are thin adapters |
| GHOSTED written automatically while mail was never read | Silence is a **suggestion**, and only when mail coverage spans it; otherwise the funnel says "unobserved" |
| Wall clock read in 33 places; tests went red on a calendar date | **Injected clock** everywhere in domain and app (enforced by a test) |

## Layout

```
src/
  kernel/      clock, hashing, use-case results
  domain/      pure rules: text parsing, catalog, evaluation, candidate, materials, pursuit, outcomes, browser policy, budgets, prompts
  ports/       interfaces and records the app depends on (store, transport, model, mailbox, browser, pdf, artifacts)
  app/         use cases: sweep, evaluate, assess, tailor, prepare, approve, fill, mail, pursuit, briefing, spend, legacy import
  adapters/    SQLite, HTTP transport, ATS boards, Anthropic, Gmail/.eml, Playwright, filesystem, legacy reader
  ui/          CLI, local web UI, report rendering, the composition root
config.example/  search/strategy, candidate/preferences, policy/evaluation, operations, sources, candidate examples
```

Dependency direction is enforced by `tests/architecture.test.ts`. Domain imports only domain, kernel and zod. App imports only app, ports, domain and kernel. Adapters never import app or ui.

## Configuration

| File | Owner | Holds |
|---|---|---|
| `search/strategy.yaml` | your search | lanes, signals, combos, title and description exclusions |
| `candidate/preferences.yaml` | you | compensation bands, location rules, notes for the analyst |
| `candidate/evidence.yaml` | you | **every claim about you**, with ids, skills and `verified` |
| `candidate/personal.yaml` | you | form-filling facts; `null` means unknown, never a default |
| `policy/evaluation.yaml` | tuning | scoring weights, priority bands, routing, selection caps, lifecycle |
| `operations.yaml` | operations | budgets, model choices, mail, transport |
| `sources.yaml` | your search | boards and watchlist |

Every file is strict: an unknown key is an error, and cross-file coherence (lane weights, ordered bands, known lanes) is checked on load. The transport refuses a delay below 500 ms in config *and* in code.

`candidate/evidence.yaml` accepts the old `resume.yaml` shape (`bullets`, a single `headline`/`summary`). Prefer `claims` and several `headlines` / `summaries` variants: tailoring selects among them and never writes one. A claim's `scope` (`led`, `owned`, `built`, `contributed`, `used`) is derived from its wording unless set explicitly.

## Commands

```
jr init | check
jr sweep [--source greenhouse lever]      jr evaluate      jr assess [--limit n] [--slate] [--dry-run] [--max-spend usd]
jr daily [--no-sweep] [--mail] [--assess]  jr report        jr top [--all] [--closed] [--lane x]   jr show <id|prefix|company>
jr pursue <id> reviewed|shortlisted|preparing|skipped       jr submitted <id> [--at iso]
jr outcome <app> contacted|screen|interview|final|offer|rejected|withdrawn|ghosted [--at iso]
jr void pursuit|application <event-id> --reason "..."       jr apps [--events]
jr evidence import <file> | lint | match <id> | brief
jr tailor <id> [--override] [--force]     jr render <id>   jr prepare <id> [--full]   jr approve <id>
jr fill <id> [--headless]                 jr mail scan [--dry-run] | review
jr stats | spend | failures | sources | discover <companies...> [--add]
jr benchmark-triage [--mode routing|verdict] [--limit n] [--yes]
jr serve [--port 4180]                    jr backup [--keep 14] [--with-artifacts]
jr import-legacy --db <file> [--old-root <dir>]       jr interview add <app> --stage x | list
```

`npm run cli -- <command>` runs the same thing without a global install.

`jr discover <companies...>` probes the public Greenhouse, Lever and Ashby board APIs for each company and prints `FOUND` with the `sources.yaml` line, `HAVE` when that board is already configured, or `--` when there is no public board (add those to `watchlist` by hand). With `--add`, each new board is written into `config/sources.yaml` after the last entry of its ATS's `boards` list, in that list's style; nothing else in the file changes, comments included. The edited file must load through the full config check before it replaces the original, so a failed add writes nothing. Added boards are live on the next `jr sweep` (unless that provider's `enabled` is false, which the command points out); `jr sources` health-checks them.

Workable and SmartRecruiters boards are also swept, but `discover` does not probe them: add them to `sources.yaml` by hand (`token` is the Workable account or the case-sensitive SmartRecruiters company identifier). Their lists carry no descriptions, so a sweep makes one extra request per posting; see `docs/adr/0003-two-call-providers-fetch-every-detail.md`.

## Spending

Only `assess`, `tailor`, `prepare`, `evidence import` and `benchmark-triage` call a model, and all of them go through `src/app/gateway.ts`:

1. **Same request, same answer.** A request is addressed by the hash of its exact prompt, model and effort. Prompts contain nothing volatile: no calibrated scores, no "posted N days ago", no URLs. So an unchanged posting is never re-bought, however much time passes.
2. **Reserve before calling.** The worst case (prompt size plus the configured `max_output_tokens`) is reserved against the run, day and month budgets in one database transaction. A call that could cross a ceiling is refused *before* it is made.
3. **Receipt for everything.** Refusals, truncations, invalid JSON, schema failures and API errors are all receipted. A call without a usage block counts at its reserved worst case, never as zero.
4. **One schema.** The JSON Schema sent to the API is generated from the Zod schema the response is validated against.

Selection for assessment is by **rank**, spread across companies with per-company caps, and never gated on an absolute keyword score. Two-stage routing (a cheap triage verdict, then a dossier only when earned) is deterministic and configured in `policy/evaluation.yaml`.

`jr tailor` and `jr prepare` reuse their plan unless the **posting** changed materially. An evidence edit re-composes and re-verifies the saved plan for free, so a stale plan can miss a new claim but can never assert a removed one. `--force` re-plans on purpose. Generations are immutable directories under `artifacts/`; an older one that may already have been sent is never overwritten.

## Outbound text

Every sentence of a cover letter, form answer or outreach draft is a separate item citing claim ids, and `src/domain/materials/verify.ts` checks each one:

- **numbers**, in digits or words ("two hundred", "40%", "3x"), must appear in the cited claims;
- **technologies** (a lexicon, your declared skills, and anything technology-shaped) must appear in the cited claims or be tagged on them;
- **scope** may not exceed the cited claims' (`contributed` never becomes `led`);
- **qualifiers** (leadership, team size, org-wide, scale, open source, migration, speaking, seniority titles, revenue impact, awards) must be present in the evidence;
- **names** must appear in the evidence or be the target company or role.

A resume rewrite that fails reverts to your own wording. A pack sentence that fails is removed and listed in `pack-review.md`. A form answer with any failed sentence is not used at all. Uncited sentences may only frame the application. `fill` uses a pack's answers and cover letter only after you `jr approve` that generation.

## Form filling

`jr fill` opens an ordinary, undisguised Chromium, fills what the rules can, and hands you the window. It never submits, never ticks a checkbox, never affirms an attestation, and never answers a demographic question. A value unset in `personal.yaml` is left blank and reported. An active bot challenge stops the run. When you close the window it offers to save answers you typed by hand, then asks whether *you* submitted. Only your "yes" records an application.

## Mail

`jr mail scan` reads application mail read-only (Gmail `gmail.readonly`, or a directory of `.eml` files) and records outcomes employers put in writing, at the email's own time. Windows are read with full pagination. The cursor advances only over windows read completely, so an outage or a large backlog is re-read rather than skipped. Ambiguous mail goes to `jr mail review`, never to a guess.

## Testing

```bash
npm test            # everything, including real Chromium (~50s)
npm run test:unit   # without the browser harness
npm run typecheck
```

The suite covers the ported parsers, the verifier's adversarial corpus, the state machines, the gateway's budget and receipt rules, the whole pipeline end to end against an in-memory database, mail pagination and outages, legacy import, the web UI's security, the CLI through its real `tsx` entry point, dependency direction, and the real-browser refusal harness.

`npm run gen:port` regenerates `src/ports/store.ts` from the SQLite store. `npm run gen:examples` regenerates `config.example/` from a legacy config.

## Scheduling

`deploy/` holds a user-level systemd timer for `jr backup` then `jr daily --mail`. The scheduled pass does not spend unless you add `--assess`; budgets in `operations.yaml` then bound it per run, per day and per month.

## Legal and ethical constraints

Only public, documented board endpoints, rate-limited per host with a floor that cannot be configured away and `Retry-After` honored. No authentication bypassed, no CAPTCHA solved, no bot detection evaded. Remote OK attribution is printed whenever that source is enabled. Nothing is ever sent on your behalf.
