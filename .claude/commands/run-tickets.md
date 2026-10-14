---
description: Run a set of Linear JOB tickets end to end without waiting on a human, in a disposable worktree lane it creates and removes - pre-flight triage, then per ticket a scripted start, one Build agent (plan + implement), scripted ship, a critic, an automated Verify, a Fix loop, and a scripted merge into main. Anything that needs the owner blocks that ticket and is reported at the end. Parallel runs are supported.
argument-hint: "[JOB-12,JOB-14|all] [--manual-merge] [--keep-worktree] [--resume [<stamp>]]"
---

**This file is read by the orchestrator only.** Subagents get the self-contained prompts under
"Phase prompts" and never read this file or the interactive commands. `/start-issue` and `/ship` stop
to ask the user, `/ship` critiques in the same context that wrote the code, and `/finish` checks out
`main`, which the primary holds - so an agent following them from a lane would stall, grade its own
work, or move the lane. Their essential steps live in `scripts/run-tickets/ticket-ops.mjs` (see
"Mechanical steps"). `verify.md` is the interactive check and is not used.

**Per clean ticket: three agents** (Build, Critic, Verify), plus one per Fix round. Everything that
needs no judgement - branching, pushing, opening and merging the PR, cleanup, every state-file write -
is one `ticket-ops` call. Linear is MCP-only (`linear-jr`), so **every tracker read and write is the
orchestrator's own MCP call**; `ticket-ops` records the outcome and says what still needs posting.
Resolve the Linear tool prefix from your tool list (`mcp__linear-jr__` in Claude Code; it differs in
opencode, where the subagent type is `general` rather than `general-purpose`).

## Facts that decide behaviour

| Fact | Consequence |
|---|---|
| **The run does not wait on a human.** | Open questions get a recorded default posted to Linear; Verify and merge into `main` are automated. Anything needing the owner blocks **that ticket** and the run moves on. Only these stop the whole run: the Fix cap, `main is red`, a broken `origin/main` at Step 0c, a failed lane-safety check, Linear unreachable at Step 0, expired `gh` auth, and a refused permission. A failed Verify, a critic BLOCK and a merge conflict are **not** blocks: they go to Fix. |
| **Base and merge target is `main`** (`origin/HEAD`, verified 2026-10-08). Merging deploys nothing: the daily timer runs the owner's primary checkout, which moves only when the owner pulls. | The run merges into `main` only. There is no branch protection (private repo, free plan), so `--match-head-commit` and the verdict pins below are the whole merge gate. |
| **The primary `.env` holds a live `ANTHROPIC_API_KEY`** - the only credential here that spends money (`assess`, `tailor`, `prepare`, `evidence import`, `benchmark-triage`). The timer's `~/.config/job-radar/env` (created by `deploy/install-timer.sh`) holds it too, with the Gmail credentials. `loadEnvFile` reads `.env` from the CLI's home (`JR_HOME`, default the checkout) and never overrides an exported variable. `JR_HOME` / `JR_DB` can point any checkout at the owner's real database, evidence ledger or work-authorization answers (v1's `JOB_RADAR_DB` / `_PERSONAL` / `_RESUME` stay forbidden too). | **The lane `.env` is GENERATED from an allowlist** (`JOB_RADAR_MODEL`, `_EFFORT`, `_CONTACT`, `_DEBUG`) by `ticket-ops guard --init`, never linked - the version this replaced symlinked the primary's `.env` and gave every lane a paid key. The guard refuses the lane if a forbidden variable is **exported** in the launching shell, or the lane `.env` is a symlink, carries any other key, any `sk-ant-` value or the primary's path. `src/adapters/fs/paths.ts` and `src/ui/compose.ts` decide which `.env` loads, so they are gate files, and `ship` re-runs the key probe on every pushed head and refuses a diff that adds a key-shaped `sk-ant-` value, the primary's path, or `.config/job-radar`. A ticket whose acceptance needs a paid model call blocks. |
| **The owner's personal material is gitignored** (`config/candidate/evidence.yaml`, `config/candidate/personal.yaml`, `.browser-profile/`, `artifacts/`, `data/`, and v1's leftovers), so a lane starts without it and resolves every default path inside itself. | The guard refuses a lane in which a candidate file or `.browser-profile` appears. A repro runs `npm run cli -- init` in the lane (it copies `config.example/`, including example `candidate/evidence.yaml` and `personal.yaml`), or sets `JR_HOME` **per command** to a scratch directory inside the lane seeded the same way. The lane's own `data/` is a fresh, empty database and is fine. |
| **`jr fill` types into a live employer's form**, and CLAUDE.md requires a live `jr fill --headless` run before any browser change ships. A lane has no personal answers and no logged-in profile. | Agents run fill **only** against `file://` fixtures (the harness in `tests/browser.refusals.test.ts`). `ticket-ops merge` refuses a diff touching `src/domain/browser/`, `src/adapters/browser/` or `src/app/fill.ts` (PR left open, ticket blocked "owner gate"). |
| **`deploy/install-timer.sh` writes the owner's user units, if installed** (none were on 2026-10-08), and resolves the repo from its own location: run from a lane, it repoints the daily timer at a directory Step 8 deletes. | Never run it or `systemctl --user` in a run. `guard` fingerprints every `job-radar` entry under `~/.config/systemd/user/` (unit files, `*.d/` drop-ins, `timers.target.wants/` links) and `~/.config/job-radar/` once, at the first Step 0c - never retaken, even on resume - and every `ticket-ops` step fails if it changed. |
| **Sweeps and discovery read public job boards** through the rate-limited transport; `mail scan` reads Gmail with credentials that live outside `.env`. | `sources`, `sweep`, `discover`, `evaluate`, `report` and `daily` (never `--assess` or `--mail`) may run in the lane: free, read-only toward the boards, rate-limited, writing only the lane's database. `mail scan` cannot: its credentials are a forbidden export. |
| **`jr serve` defaults to 4180** - the owner's own `serve` may be on it, serving the owner's real data. | A lane never binds 4180 and never uses `npm run serve` (the default port). It runs `npm run cli -- serve --port <p>` on a port `ss -Hltn "sport = :<p>"` shows free (`-H` drops the always-printed header) and asserts the server reports `<p>`; otherwise it is grading someone else's server. Mechanically, every `ticket-ops` step fails while any process whose working directory is the lane is listening (on 4180 or anywhere): a server must be stopped before its phase returns. Nothing single-slot is shared, so there is no lock. |
| **The gates are `npm test` and `npm run typecheck`.** `npm test` launches a real Chromium (`npx playwright install chromium`) and fails loudly without it. No lint, format or build script exists, and there is **no CI** (no `.github/`). | Ship and Verify run both; nobody invents a third. `npm run test:unit` is never a gate. Verify has no CI to read. |
| **Gate-defining files** - `package.json` (scripts and toolchain versions), the lockfiles, `pnpm-workspace.yaml`, `.npmrc`, any `tsconfig*.json` or `vitest*.config.*`, `src/adapters/fs/paths.ts` and `src/ui/compose.ts`, and what the critic grades against: `CLAUDE.md`, `critique.md`, `check-constraints.md` (`ticket-ops gate-files`; a test derives the gates' config closure and fails if the list misses part of it). Renames count on both sides (`--no-renames`). | A diff touching one gets `L2+Double`; **each** critic is told "this diff changes the gates that grade it" and must return a `GATES:` justification (`record` refuses fewer than the depth's critic count, and `merge` re-derives the risk for the graded commit and refuses again); Ship never takes its gates-already-ran shortcut for it. |
| **Both `package-lock.json` and `pnpm-lock.yaml` are tracked; pnpm installed the tree** (`node_modules/.modules.yaml`, no `.package-lock.json`; measured 2026-09-30). | Install with `pnpm install --frozen-lockfile`. On lockfile drift fix the lockfiles; never switch to `npm ci`, which installs a different tree than the gates were last green against. |
| **Merge and branch deletion must stay visible to the permission layer.** | `gh pr merge` and `gh api -X DELETE` never run inside `ticket-ops`: `merge` / `merged` print them and the orchestrator runs each as a plain Bash call. Launch the run in a session that allows `node`, `git`, `gh` and those two. A refused command **stops the run**; never edit `.claude/settings*.json` and never self-approve. |
| **Parallel runs are supported, with no run-wide lock.** An exclusive lock failed open in the sibling `note-reader-local` pipeline (2026-09-30: dead holder pid, heartbeat never refreshed past minute one, three runs overlapped). | Isolation is one lane and one stamped state file per run. Two runs taking one ticket is blocked in Step 0a; `heartbeat` is reported, never blocked on. Merge re-checks the base because another run may have merged meanwhile. |
| **A PR can be merged by hand while a run is live** (`note-reader-local` PR #219, 13 s after Verify failed). | Every phase checks the PR's state first. Merged outside the run before Verify passed -> a follow-up branch and PR off `origin/main`, named in the report. |
| **JOB's statuses are Backlog, Todo, In Progress, Done, Canceled, Duplicate** - no In Review, no Blocked (`.claude/linear.md`). | A shipped ticket stays In Progress with the PR in a comment; a blocked one stays where it is, with the reason in a comment. |

## Token budget

Measured on `note-reader-local` NRL-166: cached-context re-read was ~97% of cost, output only ~86k
tokens. Every tool call re-sends the agent's whole context, so cost is _calls x context size_. Half
that ticket was one Fix agent that critiqued, fixed and critiqued again in a context that grew to
390k; the 82 calls after its first critique cost 27M.

1. **One critique per pushed head, by its own agent.** No agent critiques, fixes and critiques again.
2. **~150k tokens or ~60 tool calls per agent**, whichever first. CLAUDE.md here is ~3k tokens, so
   nearly all of it is working room. At the budget the agent commits locally on the ticket branch
   (`wip:` if its gates have not passed; never pushed) and returns `result: "handoff"` with a
   `handoff` note (done / next / open, under 15 lines); a fresh agent continues the same phase. A
   handoff is not a Fix round.
3. **Batch reads**: one `grep -n` for every symbol, then one call with several `sed -n 'a,bp;c,dp'`
   ranges. Index any file over ~1,000 lines first (`src/adapters/browser/playwright-filler.ts` and `src/adapters/sqlite/store.ts` are).
4. **Bulk output to a log**: `cmd > "$LOG" 2>&1; echo "exit=$?"`, then the tail and grepped failures.
   A pipe into `tail` hides the exit code.
5. **Docs once.** Fix rounds do not edit `docs/`, `README.md`, `CLAUDE.md`, `TODO.md` or `.claude/`;
   they append one Round line to the PR body. A doc the ticket requires is written once.
6. **Structured returns, one writer.** Agents return one fenced JSON object; only `ticket-ops record`
   writes the state file.
7. **Every agent runs on the default model (Opus).** Triage takes the owner's decisions for them and
   they merge into `main` unreviewed; the non-negotiables (never invent experience, never submit, the
   three fill refusals) are subtle enough that a cheaper reviewer is a false economy. The cheap
   phases are scripts, not cheaper agents.

## Input

`$ARGUMENTS` - comma-separated keys (`JOB-12,JOB-14`; bare numbers mean `JOB-<n>`) or `all`, plus
flags. `all` = `list_issues` for team JOB, assignee me, not Done/Canceled/Duplicate, priority order.
`--manual-merge` stops each ticket after Verify with its PR open (later tickets then branch from a base
without the earlier fixes - use it for one ticket or unrelated ones). `--keep-worktree` skips Step 8.
`--resume [<stamp>]` continues a run (below). No argument -> ask which tickets; that is the only
question this command asks.

## Step 0: Establish facts

The flags are parsed **from `$ARGUMENTS` and nowhere else**: a hand-set `false` copied into a run is
how a `--manual-merge` run merges. Single quotes on purpose - a `'` in the arguments is a syntax
error, which stops the run rather than expanding anything. Every key must be `JOB-<n>`: keys become
branch names and shell arguments.

```bash
ARGS='$ARGUMENTS'
MANUAL_MERGE=false; KEEP_WT=false; RESUME=false; RESUME_STAMP=""; KEYS=()
set -f; set -- $ARGS; set +f
while [ $# -gt 0 ]; do
  case "$1" in
    --manual-merge) MANUAL_MERGE=true ;;
    --keep-worktree) KEEP_WT=true ;;
    --resume) RESUME=true; case "${2:-}" in [0-9]*-[0-9]*) RESUME_STAMP="$2"; shift ;; esac ;;
    all) KEYS=(all) ;;
    --*) echo "unknown flag $1 - stop"; exit 1 ;;
    *) IFS=',' read -ra PARTS <<< "$1"
       for k in "${PARTS[@]}"; do
         k=$(printf '%s' "$k" | tr 'a-z' 'A-Z'); [[ "$k" =~ ^[0-9]+$ ]] && k="JOB-$k"
         [[ "$k" =~ ^JOB-[1-9][0-9]*$ ]] || { echo "not a JOB key: $k - stop"; exit 1; }
         KEYS+=("$k")
       done ;;
  esac
  shift
done
echo "keys=${KEYS[*]} manualMerge=$MANUAL_MERGE keepWorktree=$KEEP_WT resume=$RESUME $RESUME_STAMP"

REPO_ROOT=$(git rev-parse --show-toplevel)
DIR=$(dirname "$REPO_ROOT"); NAME=$(basename "$REPO_ROOT")
# Basename only, and the run-lane pattern FIRST: "job-radar-run-20261008-140000" must not be
# mistaken for anything else, and stripping the full path would cut a parent directory instead.
if [[ "$NAME" =~ ^(.+)-run-[0-9]{8}-[0-9]{6}$ ]]; then NAME="${BASH_REMATCH[1]}"
elif [[ "$NAME" == *-jr-* ]]; then NAME="${NAME%%-jr-*}"; fi   # interactive pool, per worktrees.md
PRIMARY="$DIR/$NAME"
git -C "$PRIMARY" rev-parse --git-dir       # must print ".git"; otherwise stop and report both paths
BASE_BRANCH=$(git -C "$PRIMARY" symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
git -C "$PRIMARY" fetch origin && git -C "$PRIMARY" rev-parse --verify "origin/$BASE_BRANCH"
git -C "$PRIMARY" status --short -- src tests scripts   # must be empty
gh auth status
node --version
```

Stop the run (nothing is touched yet) if: `--git-dir` is not `.git` (the suffix strip missed - do not
loosen it to `-*`); `origin/HEAD` does not resolve to `main`; fetch fails; `src`/`tests`/`scripts` is
dirty in the primary (a human mid-edit - report, never stash or discard; a dirty `.claude/` is fine,
the lane is cut from `origin/main`); `gh auth status` fails. Then confirm the Linear MCP tools resolve
(`get_issue`, `list_issues`, `save_issue`, `save_comment`, `list_issue_statuses`; prefix from your tool
list, `mcp__linear-jr__` in Claude Code) and read the viewer's identity once. **Linear unreachable
here stops the run**: without it the ownership check cannot pass, and an ownership check that errors
fails closed. (`.claude/linear.md`'s git-only degradation is for the interactive commands; an
unattended run that cannot see who owns a ticket must not take it.)

### Step 0a: Claim this run's state file

```bash
STAMP=$(date -u +%Y%m%d-%H%M%S)
STATE_FILE="$PRIMARY/.claude/pipeline-state.${STAMP}.json"
RUN_WT="${PRIMARY}-run-${STAMP}"
RUN_BRANCH="run/${STAMP}"
OPS_DIR="$PRIMARY/.planning/run-tickets-ops-${STAMP}"
SCRATCH="$PRIMARY/.planning/run-tickets-${STAMP}"     # agent returns, comment bodies, logs
[ -e "$STATE_FILE" ] && { echo "stamp collision: re-run; never reuse or delete $STATE_FILE"; exit 1; }
mkdir -p "$SCRATCH"
BASE_SHA=$(git -C "$PRIMARY" rev-parse "origin/$BASE_BRANCH")
printf '{"runId":"%s","stamp":"%s","primary":"%s","worktree":"%s","runBranch":"%s","baseBranch":"%s","baseShaAtStart":"%s","manualMerge":%s,"keepWorktree":%s,"tickets":[]}\n' \
  "$(date -u +%FT%TZ)" "$STAMP" "$PRIMARY" "$RUN_WT" "$RUN_BRANCH" "$BASE_BRANCH" "$BASE_SHA" "$MANUAL_MERGE" "$KEEP_WT" > "$STATE_FILE"
ls -1 "$PRIMARY"/.claude/pipeline-state.*.json | command grep -vF "$STATE_FILE" || true
```

Name any other state file in the first message. Reading another run's `tickets` array, read-only, is
the **only** permitted access; block your copy of any ticket it holds with
`blockedReason: "also held by run <runId>"`. Never: write, move or delete a state file you did not
create (including the unstamped `.planning/pipeline-state.json`); rewrite a branch you did not create;
amend, rebase or reset `main`; checkout, reset or commit in `$PRIMARY`; remove a worktree other than
`$RUN_WT` (`job-radar-jr-*` belongs to `worktrees.md`; `treehouse` owns the gnhf pool). The run's only
writes in the primary are its state file, `.planning/run-tickets*-<stamp>`, and the `worktree
add`/`remove` pair. In safety checks write `command grep`: in the Claude Code Bash tool `grep` can be
a function wrapping ugrep that honours `.gitignore`.

### Step 0c: Create and prove the lane

```bash
git -C "$PRIMARY" worktree add --no-track -b "$RUN_BRANCH" "$RUN_WT" "origin/$BASE_BRANCH" || exit 1
cd "$RUN_WT" || exit 1
# FROZEN before any ticket branch is checked out: a ticket that edits ticket-ops, or the critic's
# checklist, must not change the gate that merges it.
[ -f scripts/run-tickets/ticket-ops.mjs ] || { echo "origin/$BASE_BRANCH has no ticket-ops - stop"; exit 1; }
mkdir -p "$OPS_DIR/checklist" && cp scripts/run-tickets/ticket-ops.mjs "$OPS_DIR/" \
  && cp CLAUDE.md .claude/commands/critique.md .claude/commands/check-constraints.md "$OPS_DIR/checklist/" || exit 1
OPS="node $OPS_DIR/ticket-ops.mjs --state $STATE_FILE"
$OPS guard --init          # lane .env from the allowlist; env, personal-file and timer checks
LOG="$SCRATCH/step0c.log"
pnpm install --frozen-lockfile > "$LOG" 2>&1; echo "install exit=$?"; tail -3 "$LOG"
npm run typecheck > "$LOG" 2>&1; echo "typecheck exit=$?"; tail -3 "$LOG"
npm test > "$LOG" 2>&1; echo "test exit=$?"; tail -5 "$LOG"
# Prove the CLI LOADS under the generated .env, and that the paid key is not visible to it.
npx tsx src/ui/cli.ts --help > "$LOG" 2>&1; echo "cli-load exit=$?"
node --import tsx --input-type=module -e "const m = await import('./src/adapters/fs/paths.ts'); const { resolve } = await import('node:path'); m.loadEnvFile(resolve(m.resolvePaths().home, '.env'));
  if (process.env.ANTHROPIC_API_KEY) { console.log('PAID KEY VISIBLE'); process.exit(1) } console.log('no paid key')"
```

`--no-track` keeps the throwaway branch from having `origin/main` as upstream, so a stray bare `git
push` cannot target `main`. **Non-zero install, typecheck or test stops the run: `origin/main` is
broken** (or Chromium is missing - say which). **A failing guard, cli-load or key probe also stops the
run but blames the generator or the launching shell, not `main`** - fix those, never app code. Every
phase prompt gets `$RUN_WT` as its repo root, never `$PRIMARY`.

**`--resume`**: no new lane or stamp. With no stamp, resume the one state file holding an
`in_progress` ticket or a top-level `halted`, or list several (`runId`, `heartbeat`, tickets) and stop.
Read `worktree`, `runBranch`, `manualMerge` and `keepWorktree` from the state file, never from the
resume command. If the lane directory is gone, `git -C "$PRIMARY" worktree add "$RUN_WT" "$RUN_BRANCH"`
and reinstall. **Then move to a known-good base before any probe**, so a half-edited ticket branch
cannot fail it and be blamed on the generator: if `git status --short` is empty, `git checkout --detach
origin/main`; otherwise commit the leftovers on the ticket branch as `wip: left before resume` (never
pushed), then detach. Recreate `OPS_DIR` if missing from the run's own base, never the lane's working
tree: `git show <baseShaAtStart>:<f>` for `ticket-ops.mjs` and the three checklist files. Rerun
`$OPS guard --init` (it regenerates the `.env` but never retakes the units snapshot) and the two load probes, then check out the in-progress ticket's `branch` and
continue from its `phase` (and `handoff`). A state file from before this layout says `plan` or
`implement` (resume as `build`) and has no `manualMerge`, so `merge` refuses and its PRs stay open.
Resuming a `halted` run re-reads the halted ticket from Linear (the owner's answer is expected there),
records `{"status": "in_progress", "phase": "fix", "fixRound": 0}`, clears `halted`, and continues.

### Step 0d: Resync between tickets

```bash
# The reset is gated inside this block: it runs only on a clean lane.
[ -z "$(git -C "$RUN_WT" status --porcelain)" ] || { echo "lane not clean - do not reset"; exit 1; }
git -C "$RUN_WT" checkout "$RUN_BRANCH" && git -C "$RUN_WT" fetch origin \
  && git -C "$RUN_WT" reset --hard "origin/$BASE_BRANCH"
```

Not empty -> do **not** reset (never `reset --hard` over a dirty tree). Commit the leftovers on the
previous ticket's branch as `wip: left in lane after <phase>` (never pushed), record it, then resync.
Step 8 will keep the lane for it.

## Phase 0: Triage

For each key, `get_issue`. **Ownership fails closed**: a ticket that is Done, Canceled, Duplicate or In
Progress (someone is working it), or assigned to anyone but the viewer, is blocked - and so is one
whose read errors. `$OPS add <KEY>` every ticket, then record each ownership block with
`{"result": "blocked", "noTracker": true, "blockedReason": ...}` (`triage`) **before** anything else
touches it: the run never comments on, transitions or takes over a ticket it does not own. Spawn
**one** read-only Triage agent for the rest and **await it** (every phase is awaited before the next
is spawned). Then, without waiting for a human:

- Each recommended answer -> `record <KEY> --phase triage` with `{"clarificationAdd": [...], "type": ...}`.
- Each `unresolvable` ticket or failed prerequisite -> `record --phase triage` with
  `{"result": "blocked", "blockedReason": ...}`.
- After every `record`, post each entry of its `toPost` with `save_comment` ("Decided by /run-tickets
  (owner may override): <question> -> <answer>, because <reason>.") and record
  `{"postedAdd": [<question>], "trackerWritesAdd": [{"op": "comment", "ok": <bool>}]}` as `orchestrator`.
- Print the triage table and decisions in **one** message, then start Phase 1.

**How a return reaches `record`**: write the agent's JSON verbatim to `$SCRATCH/<KEY>-<phase>.json`
with the Write tool (or a quoted `<<'EOF'` heredoc), then `$OPS record <KEY> --phase <p> < <file>`.
Never `echo '...' |` (a `'` in a PR body breaks it) and never an unquoted heredoc (it expands `$(...)`
from agent text in your shell). Exit 1 means malformed or misdirected and **nothing was written**:
re-run that agent once, then block the ticket.

## The phases

| # | Phase | Runs as | Job |
|---|---|---|---|
| 1 | Start | orchestrator + `$OPS start` | Ownership re-check, branch off `<run-branch>`, Linear -> In Progress, read back |
| 2 | Build | agent | Plan, reproduce bugs first, red tests, fix, gates, one clean commit, PR text |
| 3 | Ship | `$OPS ship` | Gates (unless `HEAD` = `gatedSha` and no gate file changed), leased push, read-back, PR adopt/create or Round line |
| 4 | Critic | agent | Review `origin/main...<commitSha>` once, at the depth `$OPS risk` gives; writes nothing |
| 5 | Verify | agent | Head assertion, both gates, failures attributed on the base, probes; writes nothing |
| 5a | Fix | agent | Findings -> red tests -> root-cause fix -> clean commit (Ship pushes it) |
| 6 | Merge | `$OPS merge` + Bash | Squash-merge into `main`, pinned to the graded head **and** base |
| 7 | Finish | `$OPS finish` + orchestrator | Lane resynced, branch deleted by head equality, Linear -> Done, read back |

Strictly one ticket at a time, through phase 7, before the next ticket's phase 1. **After every agent
phase, run `$OPS guard`**; a non-zero exit stops the run, because the lane is no longer safe. The same
checks also run inside `record`, `ship`, `merge` and `finish`, so a forgotten `guard` cannot carry an
unsafe lane forward. **Before spawning a critic or Verify, run `$OPS snapshot <KEY>`**: it records what
"wrote nothing" is checked against, and `record` refuses their return without it.

### Mechanical steps: `scripts/run-tickets/ticket-ops.mjs`

`$OPS <cmd> <KEY>` from the lane (it refuses any other directory, and any key not `JOB-<n>`). One JSON
line out; exit **0** ok, **1** usage or malformed input (nothing written), **2** infrastructure or
safety error (stop the run), **3** blocked (status and `blockedReason` set), **4** fail (route to Fix;
`verifyFindings` set). Every step but `show` refuses a ticket outside its own phase or already `done`.
Tested in `tests/run-tickets.ops.{record,ship,guard}.test.ts`, with each guard mutation-checked.

- **record** `--phase <triage|build|fix|critic|verify|orchestrator>` - validates the shape before
  applying anything (an object; strings, booleans, integers and arrays where expected; `result` in the
  phase's set); records only onto a ticket in that phase and never onto a `done` one; keeps only the
  fields the phase may set (`dropped` lists the rest - an agent cannot set `commitSha`); refuses a
  verdict whose sha is not the current `commitSha`; refuses a critic return unless `risk` was recorded
  for this commit and, on a gate change, it carries one `gateJustifications` entry per critic; **blocks a
  critic or Verify that left anything changed** - lane off the branch or off `commitSha`, any file
  changed, the ticket branch or `origin/main` moved, or the primary (ignored files included) different
  from the snapshot - keeping
  the agent's own block reason in front (so `main is red` still stops the run); records the base sha Verify graded
  on; routes by result (`build`/`fix` done -> ship; critic pass/concerns -> verify, block -> fix; Verify
  pass -> merge, fail -> fix; `handoff` stays); `noTracker` only ever goes false -> true; `status:
  "done"` only after a recorded merge and `finish`. A new `commitSha` clears every verdict.
- **start** - stdin `{title, type, description, url}` as read from `get_issue`. Resyncs the lane if
  `origin/main` moved; blocks on a branch-name collision; branches `fix/job-<n>-<slug>` or
  `feature/job-<n>-<slug>` (`.claude/linear.md`). The ownership check and the transition are yours.
- **snapshot** - before a critic or Verify: the commit, `origin/main`, and the primary - its
  `git status` plus size and mtime of the ignored private files (`.env`, `config/candidate/evidence.yaml`,
  `config/candidate/personal.yaml`, `.browser-profile`, `data/jr.sqlite`, v1's leftovers, `~/.config/job-radar/`).
- **ship** - a dirty tree or a `wip:` commit -> Fix; scans **every commit** it would push and blocks
  (nothing pushed) a key-shaped `sk-ant-` value, any `.env*` file but `.env.example`, the primary's
  absolute path, or code under `src/`/`tests/`/`scripts/` naming `.config/job-radar` (docs and
  `deploy/` may; `process.env.ANTHROPIC_API_KEY` reads and short placeholders pass); runs both gates unless `HEAD` is the `gatedSha`
  an agent recorded **and** no gate file changed; re-runs the key probe (blocks if this commit's
  `loadEnvFile` can see a paid key); blocks if the remote branch holds a commit the run did
  not push; pushes with a lease against what is there (plain `-u` when nothing is); reads the push back
  and records `commitSha` before anything else can fail; adopts an open PR for the branch (a crash
  between create and save would otherwise loop to the Fix cap), else creates one against `main` with
  the agent's `prTitle`/`prBody` plus `NOT VERIFIED BY A HUMAN`, the Linear URL and `Resolves JOB-<n>`;
  or appends `Round <n>: <roundNote>` to an existing PR and reads it back. A PR merged outside the run,
  or based elsewhere, -> Fix; one closed unmerged blocks.
- **risk** - `critique.md` Step 3's factors over `origin/main...<commitSha>`, plus +2 for the
  pipeline's own files and +4 for a gate file (with `gatesChanged: true`). 0-1 `L1`, 2-3 `L2`, 4+
  `L2+Double`; any `.claude/` change is at least `L2`.
- **pr-append** - appends a file to the PR body and reads it back (critic concerns).
- **merge** (preflight), in this order - refuses unless `manualMerge` is explicitly `false`,
  `criticVerdict` is pass/concerns, `verifyVerdict` is pass, and `criticSha` = `verifiedSha` =
  `commitSha`, and re-derives the risk (gate justifications on record for this commit); then the PR:
  head not the graded commit -> block, closed -> block, **already merged at the graded head -> done**
  (checked before the base, because any merge moves the base); then blocks a browser-fill diff
  (`src/domain/browser/`, `src/adapters/browser/`, `src/app/fill.ts`) for the owner; then fetches and routes to **Fix** if `origin/main` moved since Verify (a squash onto a
  newer base is a tree nobody graded; parallel runs make this real); caps attempts at two per head.
  Prints `run: ["gh pr merge <pr> --squash --match-head-commit <sha>"]` (empty if already merged). No
  `--delete-branch` (it checks out the default branch locally - in a lane it fails or moves the lane).
  No pre-gate on `mergeable` (GitHub computes it lazily; a fresh PR reads `UNKNOWN`).
- **merged** - reads the PR back rather than trusting `gh`'s exit: not merged and `CONFLICTING` -> Fix;
  head moved -> block; otherwise `retry: true` (run `merge` again). Merged at the graded head ->
  records `mergeCommit` first, then prints the remote-ref delete only if the branch is exactly that
  commit; if it moved, the ticket blocks as "merged; branch kept".
- **finish** - requires a recorded merge; uncommitted leftovers are committed as `wip: left after
  merge` and block; otherwise resets the lane to `origin/main` on `<run-branch>` and deletes the local
  branch only when it equals the merged `commitSha` (squash-merge makes `git branch -d` lie). Returns
  `trackerDone: false` for a ticket the run does not own.
- **guard** - see Step 0c; without `--init` it re-checks: exported keys, the lane `.env`, personal
  files, a server listening from the lane, and the timer fingerprint.
- **gate-files** - prints the gate-defining paths.

**Routing, per ticket.** For an agent, record its JSON as above; `record` sets the next `phase`, and
you follow it. For the critic, write `{"result": v, "criticVerdict": v, "criticSha": "<sha reviewed>",
"verifyFindings": <findings, on block>, "gateJustifications": [<each critic's GATES: line>]}` from its
`VERDICT:` line. A return with no parseable JSON or no
`VERDICT:` line is re-run once, then blocks. Every phase first checks the PR's state when one exists.

| Result | Next |
|---|---|
| `handoff` (any agent) | A fresh agent for the **same** phase, given the `handoff` note. `fixRound` unchanged. |
| Start | `get_issue` again; ownership as Phase 0, except In Progress is ours when this ticket's `trackerWrites` holds our own `transition:In Progress` attempt. Pipe `{title, type, description, url}` to `$OPS start` (the branch is recorded first). **Then** record `{"trackerWritesAdd": [{"op": "transition:In Progress", "ok": false, "pending": true}]}`, `save_issue` to the status `list_issue_statuses` names exactly `In Progress`, and read it back with `get_issue`: In Progress on read-back is success even if the write call errored. Otherwise retry once. Record the outcome; twice wrong -> `{"status": "blocked", "blockedReason": ...}`. -> **Build**. |
| Build or Fix done | **Ship**. |
| `ship` ok | `$OPS risk` (records the depth for this commit), `$OPS snapshot`, then **Critic** at that depth. `L2+Double`: two critics, neither sees the other; the lower verdict wins, and on a gate change each critic's `GATES:` line goes into `gateJustifications`. |
| `ship` exit 4 | **Fix** (findings are in `verifyFindings`). |
| Critic `pass` / `concerns` | `$OPS snapshot`, then **Verify**. On `concerns`, `$OPS pr-append` the findings under "Critic concerns (known leftovers)". |
| Critic `block` | **Fix**. |
| Verify `pass` | `save_comment`: the PR, gates, critic verdict, probes and results, and "Not verified by a human." Then **Merge**. Under `manualMerge`, `merge` blocks the ticket with its PR open - the intended stop; report it as awaiting the owner's merge. |
| Verify `fail` | **Fix**. |
| `merge` ok | Run each command in `run` as its own plain Bash call, then `$OPS merged`. Exit 4 (base moved) -> **Fix**. |
| `merged` ok | Run each command in `run` (the ref delete, printed only after the merge read back), then **Finish**. `retry: true` -> `merge` again. Exit 4 (conflict) -> **Fix**. |
| `finish` ok | If `trackerDone`: `save_issue` -> `Done`, read back, record `{"status": "done", "trackerWritesAdd": [...]}`. A write that does not read back records `{"status": "blocked", "blockedReason": "merged as <mergeCommit>; Linear Done did not land"}`. Then Step 0d, next ticket. |
| Exit 3 or `blocked` (any phase) | `save_comment` with `blockedReason` unless `noTracker`; Step 0d; next ticket. Verify blocked on `main is red` also stops the run. |
| Exit 2 | Stop the run and report the step. |

**A single Linear read or write that fails blocks that ticket, never the run** - record it in
`trackerWrites` with `ok: false`. **Fix cap**: record `{"fixRound": n+1}` (`orchestrator`) on every Fix
spawn that is not a handoff, whether or not the findings look new. When a ticket needs a Fix with
`fixRound` already 3, **the run halts**: block it with every round's findings, post them, set top-level
`halted: "<KEY>"` in the state file, skip Step 8 (the lane stays, so `--resume` works), report, and
stop. Three failed rounds mean the approach is wrong, and that needs the owner.

## State file

`$PRIMARY/.claude/pipeline-state.<stamp>.json`, one per run, in the primary so it outlives the lane,
gitignored by the glob `.claude/pipeline-state*.json`. Ticket entries are written only by `ticket-ops`;
the run-level `halted` by you. Per ticket: `id`, `title`, `url`, `type`, `descriptionSnapshot`,
`branch`, `phase`, `status`, `clarification[]` (`question`, `answer`, `reason`, `decidedBy`, `posted`),
`reproduction`, `reproConfirmed`, `planNote`, `implementationSummary`, `gatedSha`, `prTitle`, `prBody`,
`roundNote`, `prNumber`, `prUrl`, `commitSha`, `mergeCommit`, `criticVerdict`, `criticSha`,
`verifyVerdict`, `verifiedSha`, `verifiedBaseSha`, `verifyNotes`, `fixRound`, `verifyFindings`,
`handoff`, `noTracker`, `gitFinished`, `trackerWrites[]`, `blockedReason`, `history[]`. `status`:
`pending` | `in_progress` | `blocked` | `done`. `phase`: `start` | `build` | `ship` | `critic` |
`verify` | `fix` | `merge` | `finish`.

## Phase prompts

Substitute **literal** values - subagents do not inherit your shell, and one that re-derives the repo
root can land in `$PRIMARY` and commit into the owner's tree: `<lane>` = `$RUN_WT`, `<state>` =
`$STATE_FILE`, `<ops>` = `$OPS_DIR`, `<primary>` = `$PRIMARY`, plus `<KEY>`, `<branch>`, `<pr>`,
`<sha>` (`commitSha`).

**Every prompt starts with this preamble, verbatim:**

> Work only in `<lane>` (a disposable worktree). Never `cd` anywhere else, never read or write anything
> under `<primary>`, never check out `main`, never push, never merge, and do not follow `/start-issue`,
> `/ship`, `/finish` or `/verify` - they stop to ask, or move the checkout. Read your ticket with
> `node <ops>/ticket-ops.mjs --state <state> show <KEY> [field,...]`; **never write the state file and
> never write to Linear** - your return is recorded for you. This lane's `.env` holds no API key:
> **never set or export `ANTHROPIC_API_KEY`**, `JR_HOME` outside the lane, or any credential, never run `assess`, `tailor`, `prepare`, `mail scan`, or
> anything else that calls a paid model or reads mail, and never run `deploy/install-timer.sh` or
> `systemctl`. **Never run `jr fill` against an http(s) URL** - only `file://` fixtures; it types into
> a real employer's form. Never copy in the owner's `config/candidate/` files or `.browser-profile`;
> for a repro, run `npm run cli -- init` in the lane (example config and candidate files), or set
> `JR_HOME` per command to a scratch directory inside the lane. Never bind port 4180 and never use
> `npm run serve` (the default port); to serve, pick a port `ss -Hltn "sport = :<p>"`
> shows free, run `npm run cli -- serve --port <p>`, assert it reports `<p>`, and stop it before you
> return - a server still listening from the lane stops the run. Sweeps and discovery may read public job boards (they are rate-limited). The gates are
> `npm test` (the full suite; it launches Chromium) and `npm run typecheck`; there is no lint or build.
> Budget: stop at ~150k context or ~60 tool calls - commit locally on the ticket branch (`wip:` if your
> gates have not passed), return `result: "handoff"` with a `handoff` note (done / next / open, under
> 15 lines). If you block after editing files, commit them the same way. Batch reads: one `grep -n` for
> every symbol, then one call with several `sed -n` ranges; index any 1,000+ line file with grep
> first. Send installs and suites to a log, capture the exit code separately
> (`cmd > "$LOG" 2>&1; echo "exit=$?"`), and read only the tail and grepped failures. **Return only one
> fenced JSON object**: the fields your phase sets, plus `result`, `note` (a string under 3 lines) and,
> when blocked, `blockedReason`.

**Triage** - "For each ticket below [keys + full text]: read the files it names (grep; do not judge by
title) and CLAUDE.md's non-negotiables. Return a JSON object keyed by ticket: judgment (simple /
complex / needs-decomposition), `type` (bug / feature), flags (`apply` - touches the browser-fill code, so it
cannot merge unattended; `paid` - acceptance needs a live model call; `deploy` - needs the timer
reinstalled), dependencies and file overlap in the given order, and `clarificationAdd`: for each open
question its text does not answer, the `question`, your recommended `answer`, and a one-line `reason`
- prefer the acceptance criteria, CLAUDE.md and existing conventions. Mark `unresolvable` with a reason
only when no defensible default exists: the ticket contradicts itself or a CLAUDE.md rule; it needs
the owner's intent (career positioning, what to claim, which employers); it cannot be finished in this
repo (a board's reply, a new credential); or verifying it needs a paid model call, the owner's real
data, or a live employer form. `needs-decomposition` is `unresolvable` unless the split stays inside
the ticket's own acceptance criteria. Change nothing."

**2. Build** - "On `<branch>`. Read `descriptionSnapshot`, `clarification` and `handoff`.
1. **Plan.** Read the current code (line numbers in the ticket may be stale). Settle on an ordered
   `planNote` naming real files and functions and the CLAUDE.md rule for each area touched (resume
   verification, the fill refusals, cost control, the determinism boundary, append-only facts and
   new-entry migrations, config over code, dumb adapters). A new ambiguity: decide it as Triage would and return it in
   `clarificationAdd`; no defensible default -> `blocked`, `blockedReason: Unanticipated by
   pre-flight: <question>`.
2. **Reproduce.** If `type` is `bug`, reproduce before editing - a vitest test on the real function,
   or `npm run cli -- <command>` in the lane - and record the command and observed output as
   `reproduction`; `reproConfirmed: true` only when you saw it fail. Cannot reproduce, or it needs the
   owner's data or a paid call -> blocked.
3. **Implement** exactly the acceptance criteria. Tests first, and **confirm the core cases fail
   against the unfixed code** (guard tests for correct behaviour may pass both ways); if they do not
   fail, block. Drive from the real entry point - a test that hands a helper its arguments verifies the
   helper, not the call site. Never weaken a test. A new source gets a `tests/adapters.sources.test.ts` case
   pinning the real payload shape. `page.evaluate` bodies hold no named functions (tsx's `keepNames`
   breaks them and the suite cannot catch it).
4. **Gates**: `npm test` and `npm run typecheck`, each to a log. Then run what changed, within the
   preamble's limits, and say what you skipped: `src/adapters/ats/` or sweep -> `npm run cli -- sources`;
   `src/domain/catalog/` or `evaluation/` -> `npm run cli -- evaluate` then `top`; briefing or `src/ui/`
   -> `npm run cli -- report`, then `serve` as the preamble says; `src/domain/materials/` ->
   `evidence match` and `render` against the example evidence (free); `src/domain/config/` -> `check`. A doc the ticket itself requires is written now.
5. **Commit first, then gate**: one conventional commit (`fix(scope): ...`, `Resolves <KEY>` footer;
   squash any `wip:`), then `npm test` and `npm run typecheck` again on that clean, committed tree, and
   return `gatedSha` = `git rev-parse HEAD` only if both passed there. Return `planNote`, `reproduction`, `reproConfirmed`, `implementationSummary` (3-6
   sentences: deviations and known misses), `prTitle`, `prBody` (summary, the pipeline's decisions,
   what you ran under Testing, a manual test plan with exact steps and expected results). Do not push."

**4. Critic** - run `$OPS risk <KEY>` first, then spawn `subagent_type: "general-purpose"` (this repo
has no critic agent; twice, independently, for `L2+Double`). "Depth: `<depth>` (risk factors:
`<factors>`). [If `gatesChanged`:] **This diff changes the gates that grade it**: confirm the test and
typecheck configuration, the env loader and the checklist still check at least what they did on
`origin/main`, and add a line `GATES: <why it does not weaken them, or how it does>` after the verdict
(a weakening is a BLOCK). Adversarially review PR
`<pr>` for `<KEY>` in `<lane>`: the diff `origin/main...<sha>`. For intent, read `descriptionSnapshot`
and `clarification` with `node <ops>/ticket-ops.mjs --state <state> show <KEY>
descriptionSnapshot,clarification`. Apply `<ops>/checklist/critique.md` Step 4 at that depth and the checks
in `<ops>/checklist/check-constraints.md` to that range, against the rules in `<ops>/checklist/CLAUDE.md`
- frozen copies from the run's base, not the ticket's (a ticket may edit them); **never read or write
`.claude/last-critique.md`**, and write no file at all - the lane is checked afterwards. Classify as
BLOCK any finding where experience or a resume fact could be invented, a model writes prose into a
document or column unverified, `jr fill` could submit, tick, attest, answer a demographic question or
default an unknown, money can be spent outside the gateway (unaddressed, unreserved or unreceipted), the
transport floor is weakened, a fact table is updated or an applied migration edited, a test does not verify what it claims, or a CLAUDE.md rule is broken; otherwise CONCERNS or
PASS. Return, in at most 40 lines, a first line exactly `VERDICT: pass`, `VERDICT: concerns` or
`VERDICT: block`, then the findings (file:line, failure scenario), most severe first."

**5. Verify** - "You did not write this code; find out whether it meets the acceptance criteria. Read
`descriptionSnapshot`, `clarification`, `planNote`, `implementationSummary`, `reproduction`. Edit no
tracked file and leave the lane as you found it (on `<branch>` at `<sha>`, clean) - it is checked when
your return is recorded. If `gh pr view <pr> --json state,baseRefName` shows it merged outside the run
or based on anything but `main`, return `fail` saying so.
1. **Head assertion**: `git fetch origin`; `git status --short` empty; `git rev-parse HEAD`,
   `gh pr view <pr> --json headRefOid -q .headRefOid` and `commitSha` all equal. Otherwise `fail` with
   `verifyFindings: head mismatch` and the three values.
2. `npm test` and `npm run typecheck`, each to a log with its exit code. There is no known-failures
   baseline, so every failure counts - but attribute it first: `git checkout --detach origin/main`
   (running `pnpm install --frozen-lockfile` after each checkout if `pnpm-lock.yaml` differs) and rerun
   that suite; Then `git checkout <branch>` (and reinstall if the lockfile differs) **before
   returning anything**; if `main` failed too, return `blocked` with `blockedReason: main is red`.
3. Probe every input the acceptance criteria and the PR's test plan name, including `reproduction`,
   against the real changed code, and run what changed (Build's step-4 list) within the preamble's
   limits. A probe the criteria require that the preamble forbids (a paid call, a live form, the
   owner's data) -> `blocked`, naming it.
4. There is no CI to read.
`pass` only with the head assertion holding, both gates green, and every probe matching. Return
`result` and `verifyVerdict` (`pass` / `fail`), `verifiedSha` (= `commitSha`), a short `verifyNotes`,
and on fail `verifyFindings`: minimised failing inputs, expected vs actual, root-cause hypothesis, and
the path of any probe you built (in your scratchpad, never the lane). Do not fix."

**5a. Fix** - never the agent that wrote the code, the critic, or the Verify that failed it. "Fix round
`<n>` on `<branch>`, PR `<pr>` (may be null). Read `descriptionSnapshot`, `planNote`, `clarification`,
`implementationSummary`, `verifyFindings`, `handoff`. Fix what `verifyFindings` records; dispute a
finding only with evidence from the same oracle that produced it.
1. If the PR conflicts or `origin/main` moved, rebase onto `origin/main`, keeping `main`'s content plus
   this branch's change. If the PR was merged outside the run, `git checkout --no-track -b
   <branch>-followup origin/main`, re-apply what is missing, and return `branch: "<branch>-followup"`
   with `prNumber: null` (Ship opens the new PR with a first, lease-less push). A PR based on anything
   but `main`: `gh pr edit <pr> --base main`, read it back.
2. Reproduce every failing input on the branch tip and add each, with close siblings, as a test that
   **fails first**.
3. Fix the root cause. If an earlier round patched this finding in another shape, a per-shape patch is
   not acceptable.
4. **Do not edit `docs/`, `README.md`, `CLAUDE.md`, `TODO.md` or `.claude/`** unless this round
   finishes a doc the ticket itself requires. Commit first (no `wip:` left), then run both gates on the
   committed tree, and return `gatedSha` (only if they passed),
   `verifyFindings: null`, an updated `implementationSummary`, and `roundNote` (one line). Do not push
   and do not critique - Ship pushes, and a fresh critic reviews the new head.
A finding that needs an owner decision -> blocked, naming the decision."

**7. Finish** - `$OPS finish <KEY> --run-branch <run-branch>`, then the Linear write per the routing
table. If the ticket closed something CLAUDE.md, `README.md` or `TODO.md` records as open, note it for
the report's `/update-docs` list; never edit those in a run.

## Blocking: when the owner is needed

Each of these blocks only its ticket: record `blockedReason`, comment it on Linear (unless `noTracker`;
the status stays where it is), Step 0d, next ticket.

- No defensible default for a question; an `apply`, `paid` or `deploy` prerequisite
- A bug that cannot be reproduced, or whose repro or verification needs the owner's data, a paid call
  or a live employer form
- Core regression tests that pass against the unfixed code
- A critic or Verify finding that needs an owner decision, named
- A branch-name collision; a Linear read or write that fails; a status that reads back wrong twice
- A merge that fails twice for a reason other than a conflict, a moved base or a moved head
- A browser-fill diff at merge (PR left open for the live `jr fill` run), or a `--manual-merge` run
- The ticket is held by another live run, or by someone else

## Step 8: Remove the lane, once, if nothing would be lost

Skipped under `keepWorktree` and when the run halted on the Fix cap. In the lane, with `$TICKET_BRANCHES`
set to this run's ticket `branch` values from the state file:

```bash
git status --short; git stash list                  # both must be empty
git worktree list --porcelain                       # confirm $RUN_WT is the tree to remove
for B in $TICKET_BRANCHES; do
  git rev-parse --verify --quiet "$B" >/dev/null || continue
  if git rev-parse --verify --quiet "origin/$B" >/dev/null; then echo "$B unpushed=$(git rev-list --count "origin/$B..$B")"
  else echo "$B no-remote ancestor=$(git merge-base --is-ancestor "$B" "origin/$BASE_BRANCH" && echo yes || echo no)"; fi
done
```

A finished branch is already gone (Finish deleted it). Clean means empty status and stash, and every
remaining branch at `unpushed=0` or `ancestor=yes`; a blocked ticket's `wip:` commit is unpushed work,
deliberately. Clean ->

```bash
# Gated inside the block: removes nothing unless the lane is clean and has no stash.
[ -z "$(git -C "$RUN_WT" status --porcelain)" ] && [ -z "$(git -C "$RUN_WT" stash list)" ] \
  && cd "$PRIMARY" && git worktree remove "$RUN_WT" && git branch -D "$RUN_BRANCH" && git worktree prune
```

Never `--force`: a refusal after a clean measurement means something changed - keep the lane. The lane
`.env` and `node_modules/` go with it. Not clean -> keep it and report the path, dirty files, stashes,
and each branch's unpushed commits, with `To discard: git -C <primary> worktree remove --force <lane> &&
git -C <primary> branch -D run/<stamp>`. Never run that yourself, and never push a blocked ticket's
half-finished work to make cleanup pass. `$SCRATCH` and `$OPS_DIR` stay as the record.

## End-of-run report

One message, after Step 8:

- Table: ticket, PR, merge commit, critic verdict, Verify result, fix rounds, one line on what changed.
- Blocked tickets with reason, branch and PR - owner-gate (browser-fill) PRs first, with "run
  `npm run cli -- fill <id> --headless` against a live posting, confirm it stopped at submit, then merge".
- Pipeline decisions taken for the owner; critic CONCERNS left as known leftovers.
- PRs merged **outside** the run, and any follow-up PR that created.
- The lane: removed, or kept with the reason (a Fix-cap halt gives the `--resume` stamp).
- `/update-docs` candidates (CLAUDE.md's test count is one that drifts).
- Destructive repo scripts: none ran outside the lane - `backup` / `migrate` act on the lane's own
  database, and `deploy/install-timer.sh` is never run (the units fingerprint would have stopped the run).
- `main` carries these merges; the owner's primary and the daily timer do not until the owner pulls.
- Every `trackerWrites` entry with `ok: false`. A run whose writes failed must not read like a clean one.
- Cost signals: per ticket, fix rounds and handoffs; any phase that hit the budget twice, and any file
  it kept paging through, as a split candidate.
- This run's state file, and any other run's that was live alongside it.

## Error handling

| Scenario | Action |
|---|---|
| A command is refused or prompts for permission | Stop and report which one. Never edit settings or self-approve. |
| A Linear MCP operation will not resolve but others do | It was renamed (`save_comment`, not `create_comment`). Find it in your tool list; do not treat a typo as an outage. |
| A Linear call fails mid-run | Record it (`ok: false`) and block that ticket. Never invent issue data. |
| Step 0c install, typecheck or test fails | `origin/main` is broken (or Chromium is missing): stop the run. |
| `guard`, cli-load or the key probe fails at Step 0c | The generator or the launching shell is wrong (an exported key, a new credential, a symlinked `.env`). Stop the run; fix the shell or this pipeline, never app code, and never link or copy the primary's `.env`. |
| `guard` fails after an agent phase | That agent copied personal material, exported a key, or touched the owner's timer. Stop the run and report what changed. |
| Verify reports `main is red` | Block the ticket and stop the run: every later ticket would hit it. |
| Verify reports `head mismatch` | The push did not land, or something committed after it. A PR head the run did not make blocks; otherwise -> Fix to re-push. Never merge. |
| `record` exit 3 after a critic or Verify | It changed the lane. The ticket is blocked; Step 0d commits the leftovers as `wip:`. |
| PR merged outside the run before Verify passed | Fix works on `<branch>-followup` off `origin/main` with a new PR. Report it. |
| The lane's `HEAD` moved unexpectedly | Something else is in the lane. Stop and report; do not commit. |
| `$RUN_WT` or `$RUN_BRANCH` already exists | A previous run left it. Report and stop; never reuse or `-D` it. |
| An orphan `-run-*` lane with no state file | Report its path and unpushed commits; do not remove it. It may hold the only copy of a blocked repro. |
| `pnpm install --frozen-lockfile` fails on lockfile drift | Fix the repo's two-lockfile situation; never switch to `npm ci`. |
| `gh` auth expires | Stop the run and report the step. |
| A decision not covered here | Default it with a recorded reason if defensible; otherwise block the ticket. Never wait. |
