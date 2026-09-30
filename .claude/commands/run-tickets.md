---
description: Run a set of Linear tickets end to end in fresh subagents, in a disposable worktree lane the run creates and removes. Parallel runs are supported - each gets its own lane and its own stamped state file, and the only collision checked is two runs claiming the same ticket.
argument-hint: "[JOB-12,JOB-14|all] [--resume [stamp]] [--keep-worktree] [--manual-merge]"
---

Conventions: `.claude/linear.md`. This command delegates to `start-issue.md`, `ship.md`,
`finish.md`, `critique.md`, `check-constraints.md` and `update-docs.md` rather than restating them.
`verify.md` is the interactive, human-driven check and is **not** used here.

## Read this before the first run

| Fact | Consequence |
|---|---|
| **Parallel runs are supported and there is no run-wide lock.** Each run gets its own worktree lane and its own stamped state file. | Fire as many `/run-tickets` prompts as you like. Isolation is structural rather than advisory, so nothing waits. See Step 0a. |
| **An exclusive whole-run lock was tried in the sibling `note-reader-local` pipeline and it failed open.** On 2026-09-30 three runs overlapped despite it: the holder's pid was dead and its `heartbeat` had never been refreshed past the first minute, reading 136 minutes stale while the run was still writing state. | **Do not add one here.** A lock whose liveness signal is a timestamp the implementation forgets to refresh neither excludes a real second run nor survives its own holder, and it blocks the repo for an hour after a crash. Liveness is a field to *report*, never to block on. |
| **The collision that matters is two runs taking the same ticket.** | Step 0a reads every other live run's state file and blocks any ticket already claimed. File overlap between two runs is reported, not refused: that is a merge problem the second merge must handle. |
| **The run never touches the primary checkout.** | Work happens only in `job-radar-run-<stamp>`, a sibling worktree. You can keep working in `job-radar/` while a run is live. |
| **Both `package-lock.json` and `pnpm-lock.yaml` are tracked**, which is a latent inconsistency in this repo. `node_modules/.modules.yaml` exists and there is no `node_modules/.package-lock.json`, so **pnpm** is what actually installed the current tree (measured 2026-09-30). | The lane installs with `pnpm install --frozen-lockfile`. If that ever fails on lockfile drift, fix the repo's lockfile situation rather than switching the lane to `npm ci`, which would install a different tree than the one the gates were last green against. |
| **The gates are `npm test` and `npm run typecheck`**, taken from `ship.md`, which is the only source for them. `test` is `vitest run`; `typecheck` is `tsc --noEmit`. | Run both in the fresh lane before any ticket. Do not invent a `build` or `lint` gate: this repo's `package.json` has neither. |

## Tracker: Linear

Team **JOB**. Operations used: `get_issue`, `list_issues`, `save_issue`, `save_comment`,
`list_issue_statuses`.

**Do not hardcode an MCP tool prefix.** `create-issue.md` uses `mcp__linear-jr__save_issue` in Claude
Code, and the prefix differs in opencode. Resolve the real names from your available tool list, as
`.claude/linear.md` requires. Note that Linear folded its create/update pairs into `save_*`: posting a
comment is `save_comment` and `create_comment` does not exist. If an operation will not resolve, check
the name against your tool list before concluding the server is down.

If no Linear tool is present the run still works: every phase does its git work and prints what it
would have sent. **Say so in the end-of-run report** - a run whose comments all silently failed must
not read identically to one where they all landed.

The JOB team has exactly three labels: `Bug`, `Feature`, `Improvement` (see `.claude/linear.md`).

## Input

Argument: `$ARGUMENTS`

- A comma-separated list of ids, e.g. `JOB-12,JOB-14`. Bare numbers mean `JOB-<n>`.
- `all` - auto-discover assigned, not-done issues via `list_issues`, priority order. Drop anything in
  a blocked or cancelled state.
- `--manual-merge` - pause after Verify with the PR open instead of merging. Later tickets then branch
  from a base that lacks earlier fixes, so use it for one ticket or for unrelated tickets only.
- `--resume [<stamp>]` - re-validate a run's state file against Linear and git before continuing.
  State files are per run, so **name the stamp** when more than one exists. With none given and
  exactly one file holding in-progress tickets, resume that and say which. With several, list them
  with their `runId`, `heartbeat` and ticket sets and ask. Never merge two runs' state into one file.
- `--keep-worktree` - skip Step 8's cleanup unconditionally and print the lane's path.

If no argument is given, ask which tickets to run. That is the only question this command asks before
its work starts.

## Why phases run in fresh subagents

Quality, not speed. The subagent that just spent its context writing a fix is the worst possible judge
of whether that fix is sound. Fresh context per phase means each phase reads only the state file and
the repo, the way a different person picking the work up would.

This orchestrating conversation stays alive for the whole run and never does the work: read state ->
spawn one subagent for exactly one phase of one ticket -> receive a short summary -> write it to the
state file -> spawn the next. Its context grows from summaries, not transcripts.

Spawn with the `Task` tool. The subagent type is `general-purpose` in Claude Code and `general` in
opencode; pick whichever your runtime exposes.

## Step 0: Establish facts, every run

**Resolve the primary repo first.** Every path this run records is relative to it, and the lane the
run works in does not exist yet.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
DIR=$(dirname "$REPO_ROOT"); NAME=$(basename "$REPO_ROOT")

# Strip the suffix off the BASENAME ONLY, then rebuild the path. Stripping the full path
# is a real bug: a parent directory containing one of these patterns would be cut instead.
# Match a run lane FIRST and most specifically - "job-radar-run-20260930-140000" also
# matches the interactive infix below, so reversing this order works only by luck.
if [[ "$NAME" =~ ^(.+)-run-[0-9]{8}-[0-9]{6}$ ]]; then
  NAME="${BASH_REMATCH[1]}"
elif [[ "$NAME" == *-jr-* ]]; then
  NAME="${NAME%%-jr-*}"       # interactive worktree pool, per worktrees.md
fi
PRIMARY="$DIR/$NAME"

BASE_BRANCH=$(git -C "$PRIMARY" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
  | sed 's@^refs/remotes/origin/@@')
: "${BASE_BRANCH:=main}"

# One stamp for the whole run: it names the lane, the run branch and the state file, so the
# three always match up by eye and no two runs can collide on any of them.
STAMP=$(date -u +%Y%m%d-%H%M%S)
STATE_FILE="$PRIMARY/.claude/pipeline-state.${STAMP}.json"

echo "primary=$PRIMARY  launched-from=$REPO_ROOT  base=$BASE_BRANCH  stamp=$STAMP"
git -C "$PRIMARY" rev-parse --git-dir     # must print ".git", not a worktrees/ path
node --version
```

If that last command prints a path under `.git/worktrees/`, the suffix strip did not find the primary.
**Stop and report both paths rather than guessing**: creating a lane from a linked worktree nests the
`${PRIMARY}-*` sibling glob that cleanup and `worktrees.md` depend on.

### Step 0a: Claim this run's own state file

There is no run-wide lock, deliberately (see the fact table). Isolation is structural: one lane per
run, one state file per run. `$STATE_FILE` carries `$STAMP`, so no other run can name it.

```bash
RUN_ID=$(date -u +%FT%TZ)

if [ -e "$STATE_FILE" ]; then
  echo "STATE FILE ALREADY EXISTS, this run must not start: $STATE_FILE"
  echo "A second-resolution stamp collided: another run started in the same second."
  echo "Re-run; a fresh $STAMP resolves it. Do not delete or reuse the existing file."
  exit 1
fi

printf '{"runId":"%s","stamp":"%s","primary":"%s","baseBranch":"%s","tickets":[]}\n' \
  "$RUN_ID" "$STAMP" "$PRIMARY" "$BASE_BRANCH" > "$STATE_FILE"
echo "state file claimed: $STATE_FILE"

# Other runs that may be live right now. Never wait on them and never write them.
ls -1 "$PRIMARY"/.claude/pipeline-state.*.json 2>/dev/null | grep -vF "$STATE_FILE" || true
```

If another run's state file is listed, **say so in the first message and name it**, then carry on.
Read its `tickets` array to check for overlap - that is the single permitted access to another run's
state file, and it is read-only. If the sets overlap, **block the overlapping tickets in your own run**
with `blockedReason: "also held by run <their runId>"` and run the rest.

Refresh a `heartbeat` field at every phase transition, in the same write that appends to `history`, so
a human reading a state file can tell a live run from a dead one. Nothing blocks on it.

### Step 0b: Never destroy another run's record

- **Never write, move, archive or delete a state file you did not create.** Yours is the one carrying
  your `$STAMP`. Reading another for ticket overlap is the only permitted access.
- **Never rewrite a branch you did not create**, and never amend, rebase or reset `$BASE_BRANCH`. The
  run's own `run/<stamp>` branch is the one exception: Step 0d hard-resets it, and it exists solely to
  be reset and then deleted.
- **Never touch the primary checkout.** The run works only inside its lane. The only writes it makes
  in `$PRIMARY` are its own state file and the `git worktree add` / `remove` pair, both of which leave
  the primary's `HEAD` and index alone.
- **Never remove a worktree this run did not create.** Cleanup touches exactly the path in the state
  file's `worktree` field. A `job-radar-jr-*` directory belongs to `worktrees.md`'s interactive pool.

Assert before starting:

- **`$STATE_FILE` was claimed** (Step 0a), i.e. it did not already exist.
- **`$PRIMARY` has no uncommitted changes under `src/` or `tests/`.** Check
  `git -C "$PRIMARY" status --short -- src tests`. Stop and report if any are dirty; do not stash or
  discard. A dirty `.claude/` is **not** a reason to stop, because the lane is cut from
  `origin/$BASE_BRANCH` and the run never commits in the primary. Say what is dirty and carry on.
- **`origin/$BASE_BRANCH` is reachable.** `git -C "$PRIMARY" fetch origin` succeeds and
  `rev-parse --verify "origin/$BASE_BRANCH"` resolves.

### Step 0c: Create the run's lane

```bash
RUN_WT="${PRIMARY}-run-${STAMP}"
RUN_BRANCH="run/${STAMP}"

git -C "$PRIMARY" fetch origin
git -C "$PRIMARY" worktree add --no-track -b "$RUN_BRANCH" "$RUN_WT" "origin/$BASE_BRANCH"
cd "$RUN_WT"
```

**`--no-track` is load-bearing.** Without it the new branch's upstream becomes `origin/$BASE_BRANCH`,
so a bare `git push` from the lane would target the base directly. Ship pushes the ticket branch with
an explicit `-u origin <branch>`, but this branch is hard-reset every ticket and exists only to be
thrown away.

**The name is deliberately outside `job-radar-jr-*`**, the interactive pool `worktrees.md` owns, so
the two tools cannot remove each other's directories.

Bring across anything gitignored that the gates or the tracker need - in this repo, an `.env` if one
exists. Link rather than copy when the primary's copy is itself a symlink into `~/.config`; `cp`
follows the link and duplicates real credentials into a directory built to be deleted:

```bash
[ -e "$PRIMARY/.env" ] && ln -sfn "$(readlink -f "$PRIMARY/.env")" "$RUN_WT/.env"
```

Then install and **prove the lane before any ticket touches it**:

```bash
pnpm install --frozen-lockfile
npm test && npm run typecheck
```

`--frozen-lockfile` rather than a bare install: the lockfile is committed and this reproduces it
exactly instead of resolving fresh versions in a throwaway tree. See the fact table for why pnpm and
not `npm ci` despite both lockfiles being tracked.

**A gate failing here stops the whole run.** It is `origin/$BASE_BRANCH` that is broken, not any
ticket, and branching further tickets off it compounds the problem.

Record `worktree`, `runBranch` and `primary` at the top level of the state file. Every phase prompt
from here on gets `$RUN_WT` as its repo root, never `$PRIMARY`.

**Under `--resume`,** do not create a new lane and do not mint a new `$STAMP`. Read `worktree`,
`runBranch` and `stamp` from the chosen state file and use them. If the directory is gone the branches
still exist in the primary's git dir, so recreate the checkout over the existing branch:

```bash
git -C "$PRIMARY" worktree add "$RUN_WT" "$RUN_BRANCH"   # no -b: the branch already exists
cd "$RUN_WT" && pnpm install --frozen-lockfile
```

If `$RUN_BRANCH` no longer exists either, the run cannot be resumed: say so and stop rather than
inventing a new base, because the ticket branches were cut from it.

### Step 0d: Resyncing the lane between tickets

`run/<stamp>` plays the role the base branch plays in an ordinary checkout. Nothing is ever pushed
from it; it is the base each ticket branches off, and it is deleted at cleanup.

After each ticket's merge has landed:

```bash
git -C "$RUN_WT" checkout "$RUN_BRANCH"
git -C "$RUN_WT" fetch origin
git -C "$RUN_WT" reset --hard "origin/$BASE_BRANCH"
```

`reset --hard` is safe here and only here: the lane is clean at that point and this branch is the
run's own. If `status --short` is not empty, something in the previous ticket did not finish cleanly -
block rather than resetting over it, because that reset would destroy work. Under `--manual-merge`,
resync only once the owner confirms the merge landed.

## Phase 0: Pre-flight triage, before any ticket's Phase 1

1. Fetch every ticket in scope with `get_issue`.
2. Spawn **one** fresh read-only subagent for the whole batch:

   > For each of these tickets, in `<run-worktree>`: fetch the full description with `get_issue`,
   > including any "Decisions" section. Grep and read the files each ticket actually names; do not
   > judge by title. Return a table with ticket id, judgment (simple / complex / needs-decomposition),
   > and inter-ticket dependencies and file overlap for the given run order.
   >
   > For every open question the Decisions section does not answer, give the question, **your
   > recommended answer, and one line of reasoning**. Mark a question `unresolvable` only if no
   > defensible default exists. Make no changes of any kind.

3. Fill in the `tickets` array, every in-scope ticket `pending` at phase `start`. Step 0a already
   created the file with its top-level fields, including `worktree` and `runBranch`; do not
   reinitialise it and lose them. Record each recommendation in that ticket's `clarification` with
   `decidedBy: "pipeline"` and post it to Linear with `save_comment`. Set `unresolvable` tickets to
   `status: "blocked"` with the question as `blockedReason`.
4. Print the triage table and the decisions in **one** message, then continue with Phase 1 for the
   first non-blocked ticket.

## The 7 phases

| # | Phase | Delegates to | What the fresh subagent does |
|---|---|---|---|
| 1 | Start | `start-issue.md` | Branch off `<run-branch>` inside the lane, Linear to In Progress, snapshot the issue |
| 2 | Plan | this file | Write the plan using Phase 0's decisions |
| 3 | Implement | this file | Reproduce first for bugs, then fix, then run the gates itself |
| 4 | Ship | `ship.md` | Gates, `check-constraints`, `critique`, commit, push, PR against `$BASE_BRANCH` |
| 5 | Verify | this file | Automated: gates on the PR head, probes of every acceptance input |
| 6 | Merge | this file | Squash-merge once Verify recorded `pass` (paused under `--manual-merge`) |
| 7 | Finish | `finish.md` | Linear to Done, docs corrected if `update-docs.md` applies. **Not** the lane's removal |

Then Step 8 removes the lane, once, for the whole run.

**Sequencing is not optional.** Tickets run one at a time, fully through phase 7, before the next
one's phase 1.

## State file: `$STATE_FILE`

Machine-local, never committed: `$PRIMARY/.claude/pipeline-state.<stamp>.json`, **one per run**. Every
phase is handed that literal absolute path.

It lives in the primary and not in the lane on purpose: the lane is removed at Step 8, and the state
file is the run's record. A state file inside the lane would be deleted by the run's own cleanup,
taking the blocked-ticket reasons and the decision log with it.

Add the glob `.claude/pipeline-state*.json` to `.gitignore`. A glob and not a literal filename,
because the name carries a per-run stamp and an unignored state file is one `git add -A` away from
being committed.

```json
{
  "runId": "2026-09-30T14:00:00Z",
  "stamp": "20260930-140000",
  "primary": "/home/joshshearer/Documents/Dev/job-radar",
  "worktree": "/home/joshshearer/Documents/Dev/job-radar-run-20260930-140000",
  "runBranch": "run/20260930-140000",
  "worktreeRemoved": false,
  "heartbeat": "2026-09-30T14:31:00Z",
  "baseBranch": "main",
  "merge": true,
  "keepWorktree": false,
  "tickets": [
    {
      "id": "JOB-12",
      "title": "...",
      "type": "bug",
      "reproduction": "...",
      "descriptionSnapshot": "<full issue body, captured once in phase 1>",
      "branch": "fix/job-12-slug",
      "phase": "implement",
      "status": "in_progress",
      "clarification": { "question": null, "answer": null, "decidedBy": null },
      "planNote": null,
      "reproConfirmed": false,
      "implementationSummary": null,
      "prNumber": null, "prUrl": null, "commitSha": null,
      "verifyVerdict": null, "verifyNotes": null,
      "blockedReason": null,
      "history": [{ "phase": "start", "at": "2026-09-30T14:01:00Z", "result": "branch created" }]
    }
  ]
}
```

`status`: `pending` | `in_progress` | `awaiting_merge` | `blocked` | `done`.
`phase`: `start` | `plan` | `implement` | `ship` | `verify` | `merge` | `finish`.
`worktree` is the **only** path cleanup may remove.

## Phase subagent prompts

Substitute the literal absolute paths Step 0 resolved, never the rule for deriving them - a subagent
does not inherit your shell:

| Placeholder | Value |
|---|---|
| `<run-worktree>` | `$RUN_WT`, the lane. **This is the repo root every phase works in.** |
| `<state-file>` | `$STATE_FILE` |
| `<run-branch>` | `$RUN_BRANCH` |

The costly direction is the repo root: a phase that resolves to `$PRIMARY` commits into the working
tree you are using, which is the whole thing the lane exists to prevent.

**1. Start** - "Read `.claude/commands/start-issue.md` and follow it for `<ID>` in `<run-worktree>`,
non-interactively; the ticket is already chosen. The state file is `<state-file>`. You are in a
disposable run lane: the base branch is checked out in the primary and you must not try to check it
out here. `<run-branch>` is the base and already sits at `origin/<base-branch>`. Branch from it per
`.claude/linear.md`'s naming (`feature/job-<n>-<slug>` or `fix/job-<n>-<slug>`). If `start-issue.md`
offers to create a worktree, skip it: you are already in one. Write `title`, `type`,
`descriptionSnapshot` and `branch` into this ticket's state entry, set Linear to In Progress by
reading `list_issue_statuses` for the id whose name is exactly `In Progress` and reading the status
back rather than trusting the write. Set `phase: \"plan\"`, append history."

**2. Plan** - "You are in `<run-worktree>`. Read `<ID>`'s `descriptionSnapshot`, `clarification` and
`reproduction` from `<state-file>`. Line numbers in the ticket may be stale if earlier tickets in this
run touched the same files: read the current code in this lane. Write a concise ordered `planNote`
naming real functions, incorporating every recorded decision. If a genuinely new ambiguity appears,
decide it the way Phase 0 would and record it with `decidedBy: \"pipeline\"`. Set
`phase: \"implement\"`."

**3. Implement** - "You are on `<branch>` in `<run-worktree>`. Read `<ID>`'s `descriptionSnapshot`,
`planNote` and `reproduction` from `<state-file>`. Do not touch any directory outside this lane.

**If `type` is `bug`, reproduce it before changing anything**, and record the actual observed output.
Set `reproConfirmed: true` only when you have seen the failure yourself. If you cannot reproduce it,
set `status: \"blocked\"` with what you tried and stop; do not fix a bug you have not seen.

Then implement exactly what the acceptance criteria describe. Write the regression tests first and
**confirm they fail against the unfixed code** before claiming they verify anything; guard tests that
pin already-correct behaviour are expected to pass both before and after, but the core cases must fail
first, or set `status: \"blocked\"` and stop. Never weaken an existing test.

Run the gates yourself before finishing: `npm test` and `npm run typecheck`. Write a 3 to 6 sentence
`implementationSummary` listing every deviation from the plan and every known miss, set
`phase: \"ship\"`. Do not commit, push, or open a PR."

**4. Ship** - "Read `.claude/commands/ship.md` and follow it for the current branch in
`<run-worktree>`. PR base is `<base-branch>`. Use `implementationSummary` for the PR body's approach
section. Run `/check-constraints` and `/critique`; a BLOCK from either is not overridable - set
`status: \"blocked\"` with the findings and stop without committing. Record `prNumber`, `prUrl`,
`commitSha`, set `phase: \"verify\"`."

**5. Verify** - automated, in a fresh subagent that did not write the fix.

"You are verifying PR `<prNumber>` for `<ID>` in `<run-worktree>`, on branch `<branch>`. Read the
ticket's `descriptionSnapshot`, `planNote`, `implementationSummary` and `reproduction` from
`<state-file>`. You did not write this code; your job is to find out whether it does what the
acceptance criteria say. Do not edit tracked files.

1. Confirm the working tree is clean and `HEAD` equals `commitSha`. Run `npm test` and
   `npm run typecheck`.
2. Run **every input the acceptance criteria name**, including the original reproduction, and compare
   actual output to expected.

Set `verifyVerdict: \"pass\"` only if the gates pass and every probe matches. Otherwise set
`verifyVerdict: \"fail\"`, `status: \"blocked\"`, and put the failing inputs with actual versus
expected in `blockedReason`. Do not attempt a fix. On pass set `phase: \"merge\"`."

**6. Merge** - done by the orchestrator, only when `verifyVerdict` is `pass`. Under `--manual-merge`,
set `status: \"awaiting_merge\"`, print the PR URL and pause instead.

```bash
gh pr view <prNumber> --json state,mergeable
gh pr merge <prNumber> --squash --delete-branch
gh pr view <prNumber> --json state,mergedAt,mergeCommit
```

If it is not mergeable, block the ticket with the reason; do not resolve conflicts in this phase.
Never merge a ticket whose Verify did not record a pass, and never self-approve.

**7. Finish** - "Read `.claude/commands/finish.md` and follow it for the merged branch `<branch>` in
`<run-worktree>`.

Two things do not apply in a run lane. **Do not remove any worktree**: the lane you are in is removed
once for the whole run by Step 8, and a phase that removed its own lane would delete the checkout the
next ticket needs. **Do not check out `<base-branch>`**: it is checked out in the primary and git will
refuse; use `<run-branch>` reset to `origin/<base-branch>` as Step 0d describes.

Verify the merge by **content**, not by branch state: a squash merge makes `git branch -d` report
'not merged' for work fully in the base. Grep the resynced lane for a distinctive symbol the PR added
before deleting. Set Linear to Done by reading `list_issue_statuses` rather than a remembered id, and
read the status back. If this ticket invalidated a doc, apply `update-docs.md` on a
`docs/<id>-finish` branch and squash-merge it yourself; never commit to the base directly. Set
`phase: \"finish\"`, `status: \"done\"`."

## Step 8: Clean up the lane, once, at the end of the run

Runs after the last ticket reaches `done`, `blocked` or `awaiting_merge`. Skipped entirely under
`--keep-worktree`.

**Cleanup is conditional, and the condition is that nothing would be lost.** A ticket blocked
mid-implement has no commit at all, and removing the lane would destroy its reproduction with no record
anywhere.

Measure all four, in the lane, and print what you measured:

```bash
cd "$RUN_WT"
git status --short                       # must be empty
git stash list                           # must be empty
git worktree list --porcelain            # confirm $RUN_WT is the tree you are about to remove

for B in <ticket branches>; do
  git rev-parse --verify "$B" >/dev/null 2>&1 || continue
  if git rev-parse --verify "origin/$B" >/dev/null 2>&1; then
    echo "$B unpushed=$(git rev-list --count "origin/$B..$B")"
  else
    echo "$B unpushed=NO-REMOTE merged=$(git merge-base --is-ancestor "$B" "origin/$BASE_BRANCH" && echo yes || echo no)"
  fi
done
```

A branch with no remote is fine **only** if it is an ancestor of `origin/$BASE_BRANCH`, the normal end
state after a squash merge with `--delete-branch`. One that is not an ancestor is unpushed work.

**All four clean:**

```bash
cd "$PRIMARY"
git worktree remove "$RUN_WT"
git branch -D "$RUN_BRANCH"
git worktree prune
```

`worktree remove` **without** `--force`, deliberately: it refuses on a dirty tree, so it is a second
independent check on what you just measured rather than a way past it. If it refuses after you measured
clean, believe the refusal and keep the lane. `--force` is never correct in this step. Removing
`node_modules/` with the lane is expected; it is gitignored build output.

Set `worktreeRemoved: true`.

**Anything not clean** - keep the lane and report, per item: its absolute path, the dirty files
verbatim, the stash entries, and every branch with its unpushed commit count and subject lines. Say
cleanup was skipped and why, then offer:

```
Lane kept: /home/joshshearer/Documents/Dev/job-radar-run-20260930-140000
  branch fix/job-12-... has 2 unpushed commits:
    abc1234 fix(scraper): ...
Reason: JOB-12 blocked at implement; the work is not on origin.
To inspect:  cd <lane> && git log --oneline origin/main..
To discard:  git -C <primary> worktree remove --force <lane> && git -C <primary> branch -D run/<stamp>
```

Never run that discard command yourself. Offering it is the point; deciding is the owner's.

## When something needs a human

Nothing waits. Each of these blocks the ticket it happens in, records why in `blockedReason`, and the
run continues with the next ticket:

- Phase 0 or Plan finds a question with no defensible default
- A bug that cannot be reproduced
- A `check-constraints` or `critique` BLOCK
- A regression test whose core cases pass against the unfixed code, proving nothing
- Automated Verify fails
- A merge conflict with the base branch
- A ticket already claimed by another live run (Step 0a)

A blocked ticket keeps its branch and any open PR. **A ticket blocked before Ship pushed anything is
the case Step 8 exists for**: its branch is local to the lane, so "the work is not lost" is true only
because cleanup refuses to remove a lane holding unpushed commits.

## End-of-run report

One message, after Step 8:

- A table: ticket, PR, merge commit, verify result, one line on what changed.
- **The lane**: its path, and whether Step 8 removed it. If kept, the reason and the unpushed or dirty
  items verbatim.
- **Every other run whose state file was live during this one**, by `runId`, and any ticket blocked
  because another run held it.
- Every decision taken with `decidedBy: "pipeline"`.
- Every blocked ticket with its reason, branch and PR.
- **Whether every Linear write actually landed.** Name any comment or status change that was printed
  instead of posted, and why. A degraded run must not read as a clean one.

## Error handling

| Scenario | Action |
|---|---|
| No Linear tool in the available list | Continue git-only, print what would have been sent, and say so in the end-of-run report |
| A named Linear operation will not resolve, but others do | It was renamed (`save_comment`, not `create_comment`). Find the equivalent; do not fall through to the git-only path, which hides a fixable typo behind a success report |
| Another run's state file exists | Expected: runs are parallel. Name it, read its `tickets` read-only, block any ticket it holds. Never write, move or delete it |
| Several state files hold `in_progress` tickets and no `--resume` stamp given | List them with `runId`, `heartbeat` and ticket set, and ask which. Never adopt one at random |
| `$STATE_FILE` already exists at Step 0a | Two runs started in the same second. Re-run for a fresh `$STAMP` |
| `git worktree add` fails because `$RUN_WT` or `$RUN_BRANCH` exists | A previous run left a lane. Report the path and stop; never reuse it, and never `-D` a run branch this run did not create |
| A lane is on disk with no matching state file | An orphan from a crashed run. Report its path and unpushed commits; create your own lane with a fresh stamp |
| `rev-parse --git-dir` prints a `worktrees/` path | The Step 0 strip did not find the primary. Report both paths; do not loosen the pattern to `-*`, which would eat legitimate repo names |
| `pnpm install --frozen-lockfile` fails on lockfile drift | Fix the repo's two-lockfile situation; do not switch to `npm ci`, which installs a different tree than the gates were last green against |
| `npm test` fails in the fresh lane | `origin/$BASE_BRANCH` is broken. Stop the run and report it |
| A phase committed in `$PRIMARY` | It was handed the wrong repo root. Stop, report which phase, and check `git -C "$PRIMARY" status` first |
| `gh` auth expires mid-run | Stop and report which step failed; every later ticket would fail the same way |

## Configuration

| Setting | Value |
|---|---|
| **Primary repo** | `git rev-parse --show-toplevel` with a `-run-<stamp>` or `-jr-*` suffix stripped off the basename. Assert `rev-parse --git-dir` prints `.git` |
| **Run lane** | `${PRIMARY}-run-<YYYYMMDD-HHMMSS>` on `run/<stamp>`, cut from `origin/$BASE_BRANCH`, removed at Step 8 only when nothing would be lost |
| **State file** | `$PRIMARY/.claude/pipeline-state.<stamp>.json`, one per run. No run-wide lock |
| **Base branch** | `$BASE_BRANCH`, derived from `origin/HEAD` (`main` here, verified 2026-09-30) |
| **Remote** | `git@github.com:JoshShearer/job-radar.git` |
| **Tracker** | Linear team `JOB`, MCP server `linear-jr`; resolve the tool prefix at runtime |
| **Install** | `pnpm install --frozen-lockfile` (pnpm is what installed the current tree; see the fact table) |
| **Gates** | `npm test` (`vitest run`) · `npm run typecheck` (`tsc --noEmit`). No lint or build script exists |
