# Project facts - job-radar

Read by every shared `claude-workflow` command (see `.claude/workflow/contract.md`).
**The `##` headings are an interface.** Keep them as written. Project-specific steps that aren't
facts live in `.claude/overrides/<command>.md`. `/check-constraints` is a local command here, not
a link: its checks are the product thesis and were written for this repo.

## Identity

| Field | Value |
|---|---|
| Name | job-radar (CLI `jr`) |
| One line | Local-first job search assistant: sweeps public job boards, ranks postings deterministically, and prepares (never sends) tailored, allowlist-verified application material |
| Default branch | `main` |
| Agent instructions | `CLAUDE.md`. Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`. Design: `README.md` |
| Remote | `origin` (`JoshShearer/job-radar`, private) |

## Repos

none

## Gates

Both must pass. There is no lint, format or build script, and **no CI** (no `.github/`): the gates
are local and nobody invents a third. `npm run test:unit` is the fast inner loop, never a gate.

| Gate | Command | Required when the diff touches |
|---|---|---|
| test | `npm test` (vitest, including the real-Chromium refusal harness, ~50 s; fails loudly without `npx playwright install chromium`) | any source, `tests/`, `package.json`, the lockfiles, `vitest.config.ts`, `config.example/` |
| typecheck | `npm run typecheck` | any TS |

Setup before the gates mean anything in a fresh checkout: `pnpm install --frozen-lockfile` (both
lockfiles are tracked and pnpm installed the tree; on lockfile drift fix the lockfiles, never
switch to `npm ci`, which installs a different tree), then `npx playwright install chromium` once
per machine. `CLAUDE.md` "Toolchain" explains the `allowBuilds` pins that make this install work.

CI: none. `/verify` and `/run-tickets` have no check to read.

## Verification

| Field | Value |
|---|---|
| Target | The CLI itself, run on this machine against a real database (`npm run cli -- <command>`), and the web UI on `127.0.0.1` for `src/ui/` work |
| How | Run the command the diff touches, per the area table in `overrides/verify.md` (sources, evaluate, report, assess `--dry-run`, evidence match, fill `--headless` against a real posting, check, stats, mail scan `--dry-run`). Browser changes need a live `jr fill --headless` that stops at submit |
| Verified wording | `VERIFIED` (name the command and the observation) |
| Not-verified wording | `NOT VERIFIED` (`/verify`'s verdict: `GATES GREEN, NOT VERIFIED`) |
| Exclusive resource | none. The owner's `jr serve` may hold the default port 4180: a session that serves picks a free port (`overrides/verify.md`) |

## Risk areas

Highest risk first. The names in brackets are `CLAUDE.md` "Non-negotiable rules" and "Cost control".

L1 code review: skip

- `material verifier` (+2) - a rule loosened so a rewrite passes, a `verified: false` or
  wrong-owner citation no longer dropped, a failing sentence kept, or `MATERIAL_RULES_VERSION` not
  bumped on a rule change (Never invent experience; All outbound text is verified). Match:
  `src/domain/materials/**`, `MATERIAL_RULES_VERSION`, `verify\(`, `repairs\.md`, `pack-review`
- `fill refusals` (+2) - a refusal "improved" into an answer: a demographic or attestation field
  answered, an unset `personal.yaml` value defaulted, a checkbox ticked, a low-confidence dropdown
  guessed, a submit reached (`jr fill` fills, and stops). Match: `src/domain/browser/**`,
  `src/adapters/browser/**`, `src/app/fill.ts`, `personal\.yaml`, `submit`, `checkbox`
- `candidate claims` (+2) - prose, a prompt or code describing the candidate outside
  `config/candidate/evidence.yaml`; a qualifier evidenced by the skill match instead of
  independently; `partial` collapsed into a full match. Match: `src/domain/candidate/**`,
  `src/domain/evaluation/**`, `prompts`, `evidence\.yaml`, `partial`
- `paid calls` (+2) - a model call outside `src/app/gateway.ts`, volatile content in a prompt
  (dates, scores, URLs: every assessment re-buys), a reservation skipped, a receipt missing, spend
  summed from successes instead of the ledger. Match: `src/app/gateway.ts`, `src/app/assess*.ts`,
  `src/domain/llm/**`, `src/domain/budget/**`, `ModelClient`, `max_output_tokens`, `runSpend`
- `facts and migrations` (+2) - an UPDATE path on a fact table, a derived value stored as a fact,
  an applied migration edited instead of a new `MIGRATIONS` entry, a schema change without
  `npm run gen:port`. Match: `src/adapters/sqlite/**`, `MIGRATIONS`, `void_event`, `derivation`
- `transport limits` (+2) - the 500 ms per-host floor or `Retry-After` handling weakened, a
  non-public endpoint, anything that masks the browser or defeats a challenge (Only public,
  documented endpoints). Match: `src/adapters/http/**`, `src/adapters/ats/**`, `Retry-After`,
  `stealth`, `userAgent`, `captcha`
- `Remote OK attribution` (+2) - the followed link back or the source name dropped from the
  briefing while the source is enabled. Match: `src/app/briefing.ts`, `src/ui/reports/render.ts`,
  `remoteok`, `attribution`
- `sending` (+2) - any path that submits a form, sends mail or a message, or records a submission
  without the human's explicit yes (Never send anything). Match: `src/app/mail.ts`,
  `src/adapters/mail/**`, `send\(`, `submit`
- `page-side code` (+1) - a named function inside `page.evaluate` (esbuild `keepNames` breaks it
  under tsx and no test catches it), or an evaluate error swallowed. Match: `page\.evaluate`,
  `evaluate\(`
- `determinism boundary` (+1) - a model asked to compare strings, add weights, parse or dedupe;
  or deterministic code reading the wall clock (`ctx.clock` only). Match: `src/domain/**`,
  `Date\.now`, `new Date\(`
- `config schema` (+1) - a tuning value hardcoded in TypeScript, an unknown key tolerated, a
  cross-file check dropped. Match: `src/domain/config/**`, `config.example/**`

## Non-negotiables

`CLAUDE.md`, sections "Non-negotiable rules", "Structure", "Cost control" and "Verification". A
BLOCK in any of them stops `/ship`. `/check-constraints` (the local command) audits them
mechanically.

## Spec

| Field | Value |
|---|---|
| File | none (decisions are ADRs in `docs/adr/`; the design is `README.md`) |
| Requirement ID pattern | none |

## Push policy

`allowed` - this repo's commands may push a ticket branch, open its PR against `main`, merge it
after Verify, and edit its Linear issue without asking. Base and merge target is `main`
(`origin/HEAD`); merging deploys nothing, the daily timer runs the owner's primary checkout, which
moves only when the owner pulls. There is no branch protection (private repo, free plan).
docs-only commits to the default branch: allowed.

## Worktrees

| Field | Value |
|---|---|
| Location | sibling of the primary checkout (find the primary with `git rev-parse --git-common-dir`) |
| Name pattern | `job-radar-job-{N}` (multi-issue: `job-radar-job-12-14`). `job-radar-run-*` lanes belong to `/run-tickets` |
| Setup | `pnpm install --frozen-lockfile`, then `npm run cli -- init` (copies `config.example/`, never overwriting). Interactive worktrees then **link** `config/candidate/evidence.yaml`, `config/candidate/personal.yaml` and `.env` from the primary (`overrides/worktrees.md`); a `/run-tickets` lane never does |

## Docs to keep in sync

- `CLAUDE.md` - the standing rules, the toolchain notes, "Verification"
- `CONTEXT.md` - the vocabulary
- `README.md` - the design and the command list
- `TODO.md`
- `docs/adr/` - new decision records only. Don't diff these

## Dependencies

| Field | Value |
|---|---|
| Manifests | `package.json` (pnpm installed the tree; `pnpm-lock.yaml` and `package-lock.json` are both tracked and both move) |
| Update tool | `npx npm-check-updates` |
| Hold | `^better-sqlite3$` (prebuilt bindings; `allowBuilds` pins in `pnpm-workspace.yaml` and `tests/toolchain.test.ts`, see `CLAUDE.md` "Toolchain"), `^esbuild$` (same), `^playwright$` (the refusal harness pins a Chromium; bump by its own ticket) |
| Move together | `^vitest$`, `^@vitest/` |
| After an update | `test`, `typecheck`, and `npx playwright install chromium` if playwright moved |
| Not covered | none |

## Autonomous runs

`/run-tickets` facts. The lane rules (owner material, `jr fill`, ports, the timer) are in
`overrides/run-tickets.md`.

| Field | Value |
|---|---|
| Gate-defining files | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `tsconfig*.json`, `vitest*.config.*`, `src/adapters/fs/paths.ts`, `src/ui/compose.ts`, `tests/architecture.test.ts`, `tests/toolchain.test.ts`, `CLAUDE.md`, `.claude/commands/check-constraints.md` |
| Pipeline files | `deploy/install-timer.sh` (it writes the owner's user units and resolves the repo from its own location) |
| Owner-only files | `deploy/**` (the owner's timer and units) |
| Verify-only gates | none |
| Target from a lane | No lock. A lane runs only the free, read-only commands (`sources`, `sweep`, `discover`, `evaluate`, `report`, `daily` without `--assess` or `--mail`, `check`, `evidence lint`, `render`) on its own database, and `serve` only on a port it proved free (`overrides/run-tickets.md`). It never spends (`assess`, `tailor`, `prepare`, `evidence import`, `benchmark-triage`), never reads mail, and runs `fill` only against the `file://` fixtures in `tests/` |
| Target guard files | `src/domain/browser/**`, `src/adapters/browser/**`, `src/app/fill.ts` (a browser change needs a live `jr fill --headless`, which a lane cannot do: the ticket blocks for the owner) |
| Environment fences | Files: `config/candidate/evidence.yaml`, `config/candidate/personal.yaml`, `config/candidate/*.bak`, `.browser-profile/`, `artifacts/`, `data/`. Variables: `ANTHROPIC_API_KEY`, `JR_HOME`, `GMAIL_.*` |
| Primary changes during a run | `warn` |
| Secret patterns | none |
| Forbidden unattended actions | `deploy/install-timer.sh`, `systemctl --user`, `npm run serve` (the default port 4180), `jr fill` against anything but a `file://` fixture, `assess`, `tailor`, `prepare`, `evidence import`, `benchmark-triage`, `mail scan` without `--dry-run`, `git tag`, `gh release`, `npm publish` |

## Model routing

none
