# /run-tickets override - job-radar

The facts are in `.claude/project.md` `## Autonomous runs`. These are the steps no other project
has. Subagent prompts get the sections their phase names, verbatim.

## Facts

| Fact | Consequence |
|---|---|
| **The primary `.env` holds a live `ANTHROPIC_API_KEY`**, the only credential here that spends money (`assess`, `tailor`, `prepare`, `evidence import`, `benchmark-triage`). The timer's `~/.config/job-radar/env` holds it too, with the Gmail credentials. `loadEnvFile` reads `.env` from `JR_HOME` (default the checkout) and never overrides an exported variable. | A lane has no `.env` and the run's shell exports no `ANTHROPIC_API_KEY` or `JR_HOME` (fenced). Every default path resolves inside the lane. A spending command in a lane is a blocked ticket, never a retry. |
| **`model.provider: claude-cli` spends the owner's claude.ai subscription quota** through `claude -p` (logged in on this machine), and `config.example/` selects it. The provider exists only when `JR_ALLOW_MODEL=1` (ADR-0004). | A lane never sets or exports `JR_ALLOW_MODEL` (fenced; `ticket-ops.mjs` strips and refuses it), and tests never spawn the real `claude`: they inject a fake runner or run `process.execPath`. A real CLI call is owner material, like a real `assess`. |
| **The owner's personal material is gitignored** (`config/candidate/evidence.yaml`, `personal.yaml`, `.browser-profile/`, `artifacts/`, `data/`). | A lane starts without it; the fence stops the run if any of it appears in a lane. A repro runs `npm run cli -- init` in the lane and works on `config.example/` material and synthetic inputs only. |
| **`jr fill` types into a live employer's form**, and `CLAUDE.md` requires a live `jr fill --headless` before any browser change ships. A lane has no personal answers and no logged-in profile. | Agents run `fill` **only** against the `file://` fixtures (`tests/browser.refusals.test.ts`). The browser dirs are target guard files: a ticket touching them is built, critiqued and gate-verified, then **blocks** with `needs a live jr fill --headless by the owner` instead of merging. |
| **`deploy/install-timer.sh` writes the owner's user units** and resolves the repo from its own location: run from a lane it repoints the daily timer at a directory Step 8 deletes. | Never run it or `systemctl --user` in a run (forbidden). `deploy/**` is owner-only. |
| **Sweeps and discovery read public job boards** through the rate-limited transport; `mail scan` reads Gmail with credentials outside `.env`. | `sources`, `sweep`, `discover`, `evaluate`, `report`, `check`, `evidence lint`, `render` and `daily` (never `--assess` or `--mail`) may run in the lane: free, read-only toward the boards, writing only the lane's database. `mail scan` only with `--dry-run`. |
| **`jr serve` defaults to 4180**; the owner's own `serve` may be on it, serving real data. | A lane never binds 4180. It runs `npm run cli -- serve --port <p>` on a port `ss -Hltn "sport = :<p>"` shows free and asserts the server reports `<p>`; otherwise it is grading someone else's server. |
| **Both lockfiles are tracked; pnpm installed the tree.** | Lane setup is `pnpm install --frozen-lockfile`. On lockfile drift fix the lockfiles; never `npm ci`. |
| **`npm test` launches a real Chromium.** | `npx playwright install chromium` is a machine prerequisite, checked at Step 4 before blaming `origin/main` for a red suite. |
| **No CI.** | Verify's CI read is `CI: none`; the gates are the whole merge gate, plus `--match-head-commit`. |
| **JOB has no In Review and no Blocked status.** | A shipped ticket stays In Progress with the PR in a comment; a blocked one stays where it is, with the reason in a comment. |

## Step 4: lane setup

`pnpm install --frozen-lockfile`, `npm run cli -- init`, confirm `npx playwright install chromium`
has been run on this machine, then `$OPS gates`. Link nothing from the primary.

## Phase 0: Triage

Block, with the reason:

- a ticket whose acceptance needs the owner's real evidence or personal file, a logged-in browser
  profile, a real posting, Gmail, or a paid model call (`needs owner material`);
- a ticket touching `deploy/**` or the timer (`owner-only`);
- a ticket whose repro is only observable in a live `jr fill` (`needs a live fill`): Build and
  Verify still run against the fixtures, and the ticket blocks at merge as the Facts table says.

## Build and Verify

Test inputs are synthetic or from `config.example/`, never the owner's. A probe that would spend
money is reported as not run. `src/adapters/browser/playwright-filler.ts` and
`src/adapters/sqlite/store.ts` are over 1,000 lines: index them with `grep -n` before reading.
