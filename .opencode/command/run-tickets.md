---
description: Pre-flight triage every ticket for clarifying questions, then run start-issue -> plan -> implement -> ship -> test-issue -> merge -> finish per ticket in fresh subagents, uninterrupted except for real pauses
---

> **This command is project-agnostic.** It carries no hardcoded repo path, tracker/team, issue
> prefix, or gate commands — it discovers all of that from the current project at runtime (see
> Step 0). It has been copied verbatim across multiple repos in this portfolio: some Linear-backed
> (each with a different Linear team and MCP server name — `linear-vl`, `linear-jr`,
> `linear-loopstring`, plain `linear`, ...), at least one GitHub-Issues-backed. **In Linear mode**,
> a project's `opencode.json` may declare a Linear MCP server, but config is loaded once at
> opencode startup — **a tool bound in `opencode.json` is not guaranteed to be present or
> authenticated in the current session** (observed directly: a session started before the config
> existed, or before its own OAuth flow completed, has no such tool). This command therefore never
> depends on a bare Linear MCP tool call succeeding: every Linear read/write goes through
> `node scripts/linear-mcp.mjs` (copied alongside this file — every project keeps its own copy,
> they are identical), which talks to `https://mcp.linear.app/mcp` directly over HTTP with a
> self-refreshing cached OAuth token and auto-discovers *which* Linear MCP server this project
> uses by reading its own `.mcp.json` or `opencode.json`. If a native Linear MCP tool *is*
> available and working in a given subagent, using it is fine too — the script is the guaranteed
> path, not the only allowed one. **In GitHub Issues mode**, no equivalent script is needed —
> `gh issue` is already authenticated wherever `gh` itself is.

## Tracker compatibility

This command supports two trackers — **Linear** and **GitHub Issues**. Detect which one applies
before anything else (Step 0 below). Every phase's ticket-fetch/update/comment instruction below
gives both forms; use whichever matches. If a project uses neither (e.g. Jira, observed
elsewhere in this portfolio), this command does not apply as written — that would mean building
a third tracker branch, a real but separate piece of work. Do not paper over an unrecognized
tracker by guessing at its shape.

**Detecting the tracker** — read this project's own `.claude/commands/create-issue.md`:
- Says "Create a Linear issue" **and** a `.mcp.json`/`opencode.json` entry's `url` points at
  `mcp.linear.app` → **Linear mode**. Ticket IDs look like `VEN-45`.
- Says "Create a GitHub issue" → **GitHub Issues mode**. Ticket IDs are bare numbers (`45`, not
  `VEN-45`); there is no separate MCP tool to discover — `gh issue` is already authenticated.
- Anything else (e.g. "Create a Jira issue") → stop, report the mismatch, do not proceed.

## Step 0: Establish this project's facts (every run, before anything else)

Never assume venture-lab's specifics apply. Resolve fresh, every run:

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)
```

Then read, in `$REPO_ROOT`:
- `.claude/commands/create-issue.md` — the team name, issue key prefix, and label vocabulary for
  *this* project (do not assume `VEN`/`Venture-lab`)
- `.claude/commands/ship.md` — the actual quality-gate commands this project uses (do not assume
  `pnpm typecheck && pnpm test:ci && pnpm build` — a Next.js project may use `npm run build`, a
  CLI tool may have no build step at all, etc.) and whether CI is advisory or merge-blocking here
- `package.json` (or equivalent) — package manager and script names

Every phase subagent prompt below must be filled in with these resolved values, not the
examples shown (which use venture-lab's `VEN-NN` / pnpm for illustration only).

**Mandatory push-permission check — do this before any write, every run.** Read `CLAUDE.md` (or
`AGENTS.md`) at `$REPO_ROOT` and at any parent workspace directory above it, if one exists, for a
repo-specific policy on pushing/opening PRs. This is not hypothetical: one workspace in this
portfolio explicitly grants blanket push permission to exactly one of its five repos and requires
asking before every single push to the other four — "permission granted for one push does not
carry to the next." If such a policy exists and this project isn't the unconditionally-permitted
case, the Ship phase (below) must ask for explicit permission **before every push and PR**, not
just once at the start of the run — treat it as a pause (see **Pauses**) at that exact point,
every ticket, no exceptions. If no such policy is found, proceed normally.

**Mandatory credential-collision check (Linear mode only) — do this before any write.** OAuth
tokens for a Linear MCP server are cached by *server name*, not by project. Two different
projects that both name their server the same generic thing (`linear` is the observed repeat
offender) share one cached token, and whichever project last authenticated it wins for **all** of
them — silently. This is not hypothetical: it has been directly observed in this exact portfolio,
where a project documenting team `BASEMyHome` resolved to a completely different team
(`Valqor-crm`, belonging to an unrelated project sharing the plain `linear` server name) with no
error of any kind.

Before the Start phase of the *first* ticket in a run, verify:

```bash
node scripts/linear-mcp.mjs call list_teams '{}'
```

Compare the returned team name against the `**Team**` row in this project's own
`.claude/commands/create-issue.md`. **If they don't match, stop immediately — do not proceed with
any phase.** Report the mismatch and recommend the fix at the source: rename this project's
Linear server entry in `.mcp.json`/`opencode.json` to something project-specific (e.g.
`linear-<project>` instead of plain `linear`), then re-authenticate it so it gets its own
distinct cached token. Re-running this check with `LINEAR_MCP_SERVER_KEY=<new-name>` afterward
should then resolve correctly.

Run the full ticket lifecycle for one or more tickets, **one ticket at a time**, with **every
phase executed by a fresh subagent that has no memory of any prior phase**. All handoff between
phases happens through `.planning/pipeline-state.json`, git, GitHub, and the tracker (Linear or
GitHub Issues) themselves — never through this conversation's context.

## Why phases run in fresh subagents

The point is quality, not speed: a subagent that just spent its context writing a fix should not
also be the one deciding whether its own PR passes the critic gate. Fresh context per phase means
each phase reads only what it needs from the state file and the repo, the same way it would if a
different person picked up the work.

This orchestrating session (yours, running this command) stays alive for the whole run, but it
never does the work itself — it only ever: read state -> spawn one `task` tool call
(`subagent_type: "general"`) for exactly one phase of one ticket (or, for Phase 0, one call for
the whole batch) -> receive a short summary -> write the result to the state file -> spawn the
next one. Its own context grows from summaries, not transcripts, so it can outlast a long
multi-ticket run. The one thing only *this* session can do — not a subagent — is actually ask you
a question and wait for your reply, which is why pre-flight's questions and every later pause
happen here, not inside a spawned subagent.

## Input

`$ARGUMENTS` is one of:

- A comma-separated ticket list, e.g. `VEN-45,VEN-46,VEN-47` in Linear mode or `45,46,47` in
  GitHub Issues mode (substitute this project's actual issue key prefix from Step 0 — `VEN` is
  venture-lab's, not a universal default)
- `all` — auto-discover. **Linear mode:** `node scripts/linear-mcp.mjs list-issues
  '{"assignee":"me","fields":["id","title","status","priority","labels"]}'` (add
  `"team":"<name>"` from Step 0 only if this workspace has multiple teams), keep only issues
  whose `status` is not `Done`, `Canceled`, or `Duplicate`, sort by priority value ascending
  (1=Urgent first, 0/None last). **GitHub Issues mode:** `gh issue list --assignee @me --state
  open --json number,title,labels`, sorted however labels indicate priority for this project (or
  left in returned order if none do)

Plus optional flags anywhere in `$ARGUMENTS`:

- `--auto-merge` — merge each PR automatically once the test-issue phase reports CI green.
  Without this flag, the pipeline **pauses after the test-issue phase** for the user to merge on
  GitHub, then resumes on their go-ahead.
- `--resume` — re-validate `.planning/pipeline-state.json` against tracker/git reality (branch
  still exists? PR still open? issue status changed under you?) before continuing. Auto-invoked
  anyway if the state file already has in-progress tickets when the command starts with no
  `--resume` flag — ask before overwriting a run that looks incomplete.

If `$ARGUMENTS` is empty, ask which tickets to run rather than guessing.

## Phase 0: Pre-flight triage (all tickets, before any ticket's phase 1)

**Why this exists.** Without it, "complex, needs a human decision" is discovered *after* a
branch already exists and the tracker has already flipped to `In Progress` — real churn for a
ticket that then just sits blocked. (Observed directly: a ticket got a branch and an
`In Progress` transition, then the Plan phase immediately blocked it on an unresolved
security-posture decision the ticket's own acceptance criteria left open.) Triage first, touch
nothing until you know which tickets need a human and which don't.

**Process**, run once per invocation, before any ticket's Start phase:

1. Fetch full details for every ticket in scope: **Linear mode:** `node scripts/linear-mcp.mjs
   get-issue <TICKET-ID>` for each. **GitHub Issues mode:** `gh issue view <TICKET-ID> --json
   title,labels,body,url` for each.
2. Spawn **one** fresh subagent covering the whole batch (not one per ticket — this is read-only
   analysis, not implementation, so there's no reason to isolate them from each other). Prompt:
   "For each of these tickets [list with full descriptions], apply the complexity heuristic from
   `.claude/commands/start-issue.md`'s 'Agent Delegation' section — grep/read the actual files
   named in each ticket to judge scope accurately, don't go by the title alone. Return a table:
   ticket id, judgment (simple / complex / needs-decomposition), and for anything not simple, one
   crisp clarifying question whose answer would resolve the ambiguity (phrased so a short answer
   suffices — e.g. 'rate-limit-only with a documented residual-risk note, or actual signed
   payloads?', not 'what should we do about security?'). Make no changes of any kind — no
   branches, no tracker writes, purely analysis."
3. Present the batch result **in one message**: which tickets are clear to run straight through,
   and — grouped together, up front — every clarifying question for tickets that aren't. Example:

   ```
   7 of 10 tickets are clear to run straight through: VEN-46, VEN-47, VEN-48, VEN-49, VEN-51,
   VEN-52, VEN-54.

   3 need a decision before they can run unattended:
   - VEN-45: rate-limit-only + residual-risk note, or actual signed event payloads?
   - VEN-50: delete SESSION_SECRET entirely, or implement real signing?
   - VEN-53: [...]
   ```

4. Wait for the user's reply — this is an ordinary turn in the conversation, not a subagent call
   and not `--resume`. The run has not started yet; nothing is waiting on disk.
5. For every answered question, write it into that ticket's `clarification` field in
   `.planning/pipeline-state.json` (create the file now if it doesn't exist yet, with every
   in-scope ticket pre-populated at `status: "pending"`, `phase: "start-issue"`). For tickets left
   unanswered, set `status: "blocked"` with the question as `blockedReason` — they're excluded
   from this run but don't hold up the others (see Orchestration algorithm).
6. Only now begin Phase 1 for the first ticket that isn't blocked.

The Plan phase (below) still runs for every ticket — it's the safety net for anything pre-flight
couldn't have anticipated (e.g. a design question that only becomes obvious once you're looking
at the branch in context). If a ticket already has a `clarification.answer` recorded, Plan uses
it directly instead of re-asking.

## The 7 phases

| # | Phase | Reference | What the fresh subagent does |
|---|---|---|---|
| 1 | Start | `.claude/commands/start-issue.md` | Branch, tracker -> In Progress, snapshot title/description/acceptance criteria into the state file |
| 2 | Plan | (this file, below) | Judge complexity (using pre-flight's answer if one was recorded); genuinely new/unanticipated complexity pauses for a decision |
| 3 | Implement | (this file, below) | Write the fix scoped exactly to the ticket; run this project's own gates itself before finishing |
| 4 | Ship | `.claude/commands/ship.md` | Gates + critic gate + commit + push + PR |
| 5 | Verify | `.claude/commands/test-issue.md` | Poll CI, record pass/fail |
| 6 | Merge | (this file, below) | Auto-merge if `--auto-merge` and CI passed, else pause for manual merge |
| 7 | Finish | `.claude/commands/finish.md` | Cleanup, tracker issue closed, base branch synced for the next ticket |

These `.claude/commands/*.md` files are Claude Code slash-command definitions, but they are
just markdown instructions on disk — read them with the `read` tool and follow them directly.
Nothing about their content is Claude Code-specific except the tool-naming difference already
called out above, and the fact that "running a command" from inside a subagent means reading the
file and doing what it says, not invoking `/ship` as a literal action — slash commands only
expand at top-level user input, not mid-prompt.

**Sequencing is not optional.** Tickets run strictly one at a time, fully through phase 7,
before the next one's phase 1 starts. Starting work branches from the base branch, and that base
branch only has ticket N's fix once ticket N's finish phase has pulled it — running two tickets
concurrently risks ticket N+1 branching before ticket N's fix has landed.

## State file: `.planning/pipeline-state.json`

Created on first run, read and rewritten by every phase. This is the memory substrate that
replaces conversation context.

```json
{
  "runId": "2026-09-26T20:00:00Z",
  "mergeMode": "manual",
  "tickets": [
    {
      "id": "VEN-45",
      "title": "Bound and authenticate public event capture",
      "priority": "High",
      "labels": ["Bug"],
      "descriptionSnapshot": "<full tracker description, captured once in phase 1>",
      "branch": "fix/ven-45-bound-and-authenticate-public-event-capture",
      "phase": "implement",
      "status": "in_progress",
      "clarification": {
        "question": "Rate-limit-only + residual-risk note, or actual signed event payloads?",
        "answer": "Rate-limit + cap only; document the residual risk. Signing is overkill for a single-founder deployment."
      },
      "planNote": "Trivial — single file. Proceeding directly.",
      "implementationSummary": null,
      "prNumber": null,
      "prUrl": null,
      "commitSha": null,
      "ciStatus": null,
      "blockedReason": null,
      "history": [
        { "phase": "start-issue", "at": "2026-09-26T20:01:00Z", "result": "branch created" }
      ]
    }
  ]
}
```

`status` is one of `pending`, `in_progress`, `awaiting_merge`, `blocked`, `done`.
`phase` is one of `start-issue`, `plan`, `implement`, `ship`, `test-issue`, `merge`, `finish`.
`clarification` is present once pre-flight (or a later Plan-phase pause) raises a question for
this ticket; `answer` is `null` until the user responds.

## Orchestration algorithm

1. Run **Phase 0** (pre-flight triage, above) across every ticket in scope. This populates
   `.planning/pipeline-state.json` for all of them before any ticket's Phase 1 runs.
2. For each ticket **not** left `blocked` by pre-flight, in priority order, **not in parallel**:
   1. If the ticket's `status` is already `done`, skip it.
   2. Run phases 1-7 in order (below). After each phase, update the state file before spawning
      the next phase's subagent.
   3. If a phase hits something requiring a decision it can't make (see **Pauses**, below): ask
      the question in this same conversation and wait — do not spawn the next phase, and do not
      move to the next ticket. Once answered, record it in the state file and continue this
      ticket's very next phase. This is an ordinary pause, not an abort.
3. When every non-blocked ticket in scope reaches `status: "done"`, report a final summary:
   tickets shipped, PR links, and the pre-flight-blocked tickets that were excluded (with their
   unanswered questions, so they're easy to pick up separately).

### Phase subagent prompts

Spawn each with the `task` tool (`subagent_type: "general"`). Every prompt must include the
resolved `$REPO_ROOT` from Step 0 (as a literal absolute path, not the variable name —
subagents don't inherit your shell), the ticket ID, and an instruction to read
`.planning/pipeline-state.json` for context — never assume the subagent has any prior
conversation. `<TICKET-ID>` below means this project's actual issue key (e.g. `VEN-45`,
`JOB-12`, `45` in GitHub Issues mode) — never assume `VEN`.

**1. Start** — "Read `.claude/commands/start-issue.md` and follow its instructions for
`<TICKET-ID>` in `<repo-root>`, non-interactively (no numbered-list prompt; the ticket is already
chosen). Wherever it says to use a `mcp__linear-vl__*`-style tool, use the equivalent
`node scripts/linear-mcp.mjs` subcommand instead (Linear mode) or `gh issue` (GitHub Issues
mode). After the branch is created and the tracker is updated, fetch the full issue —
**Linear mode:** `node scripts/linear-mcp.mjs get-issue <TICKET-ID>`, read `title`,
`priority.name`, `labels`, `description`. **GitHub Issues mode:**
`gh issue view <TICKET-ID> --json title,labels,body,url`, read `title`, `labels[].name`, `body`
(there's no priority field — leave `priority` null unless a `priority:*` label is present). Write
`title`, `priority`, `labels`, `descriptionSnapshot` (the full description/body text), and
`branch` into this ticket's entry in `.planning/pipeline-state.json`. Set `phase: \"plan\"`,
`status: \"in_progress\"`, append a history entry. If the branch or a collision warning needs a
decision `start-issue.md` can't make automatically (e.g. branch already exists with different
content, issue already In Progress under someone else), set `status: \"blocked\"` with
`blockedReason` and stop — do not guess."

**2. Plan** — "Read `<TICKET-ID>`'s `descriptionSnapshot` from `.planning/pipeline-state.json`.
If a `clarification.answer` is already recorded (from pre-flight), use it directly: write
`planNote` incorporating that decision, set `phase: \"implement\"`, done — do not re-judge
complexity from scratch. Otherwise, apply the complexity heuristic from
`.claude/commands/start-issue.md`'s 'Agent Delegation' section yourself: **Simple** (clear
requirements, touches <3 files) -> write
`planNote: \"Trivial — proceeding directly to implementation\"`, set `phase: \"implement\"`.
**Complex** (new pattern, unclear approach, >3 files) or **needs decomposition** (large scope,
multiple deliverables) -> pre-flight should have caught this; if it didn't, don't guess now
either — set `clarification.question` to a crisp one-line question, leave `clarification.answer`
null, set `status: \"blocked\"`, `blockedReason: \"Unanticipated by pre-flight — see
clarification.question\"`, and stop. Base the judgment on the actual files named in the ticket,
not the title alone."

**3. Implement** — "Read `<TICKET-ID>`'s `descriptionSnapshot` and `planNote` from
`.planning/pipeline-state.json`; you are on branch `<branch>` in `<repo-root>`. Implement exactly
what the ticket's Acceptance Criteria describe — do not expand scope beyond its 'Out of Scope'
section if one exists. Before finishing, run this project's own quality gates yourself (from
Step 0 — do not assume `pnpm typecheck && pnpm test:ci && pnpm build`; that's venture-lab's, this
project may differ) and fix any failures your change caused; do not leave that for the ship
phase. Write a 3-6 sentence `implementationSummary` (files changed, approach, key decisions) into
the state file. Set `phase: \"ship\"`. Do not commit, push, or open a PR — that is the next
phase."

**4. Ship** — "Read `.claude/commands/ship.md` and follow its instructions for the current
branch in `<repo-root>`, substituting `node scripts/linear-mcp.mjs` (Linear mode) or `gh issue`
(GitHub Issues mode) for any tracker MCP tool reference. Use `implementationSummary` from
`.planning/pipeline-state.json` for the PR body's Approach section, and the ticket's
title/description for the Summary and Test Plan sections. If you need the canonical tracker
description again: **Linear mode:** `node scripts/linear-mcp.mjs get-issue <TICKET-ID>`.
**GitHub Issues mode:** `gh issue view <TICKET-ID>`. This project's plain (no-flags) gate path is
sufficient for these changes.

**If Step 0 found a push-permission policy requiring per-push approval for this repo**: before
running `git push` or `gh pr create`, stop and ask the user for explicit permission to push this
specific branch, naming the branch and repo. Do not proceed on an earlier or general approval —
the policy is explicit that permission does not carry over. Once granted, continue normally.

Record `prNumber`, `prUrl`, and `commitSha` into the state file, set `phase: \"test-issue\"`. If
the critic gate BLOCKs, do not override it: set `status: \"blocked\"` with the blocking findings
as `blockedReason` and stop."

**5. Verify** — "Read `.claude/commands/test-issue.md` and follow its instructions for PR
`<prNumber>`, substituting **Linear mode:** `node scripts/linear-mcp.mjs comment <TICKET-ID>
<bodyFile>` or **GitHub Issues mode:** `gh issue comment <TICKET-ID> --body-file <bodyFile>` for
its comment-posting step. Poll `gh pr checks <prNumber>` every ~20s for up to 10 minutes if CI is
still running — do not report a result before it finishes. Record `ciStatus: \"passed\"` or
`\"failed\"` in the state file. If failed: attempt **at most one** fix-and-repush cycle (subject
to the same push-permission check as the Ship phase, if it applies), but only if the failure is
clearly caused by this ticket's own change (reproduce locally with this project's own gate
commands from Step 0, fix, push, re-check CI once). If it fails again or the cause isn't clearly
this change, set `status: \"blocked\"`, `blockedReason` with the CI failure detail, and stop. If
passed, set `phase: \"merge\"`."

**6. Merge** — "Read `mergeMode` from `.planning/pipeline-state.json`. If `\"auto\"` and
`ciStatus` is `\"passed\"`: run `gh pr merge <prNumber> --squash --delete-branch`, record the
merge in history, set `phase: \"finish\"`. If `mergeMode` is `\"manual\"`: set
`status: \"awaiting_merge\"` and pause — print the PR URL and tell the user you're waiting for
them to merge on GitHub. This is an ordinary pause in the same conversation: once they confirm
it's merged, verify with `gh pr view <prNumber> --json state,mergedAt` and proceed to Finish.
Only if the session itself ends before that confirmation does resuming later need this command
with `--resume` instead."

**7. Finish** — "Read `.claude/commands/finish.md` and follow its instructions for the
now-merged branch `<branch>` in `<repo-root>`, substituting `node scripts/linear-mcp.mjs`
(Linear mode) or `gh issue` (GitHub Issues mode) for any tracker MCP tool reference. Confirm
`<TICKET-ID>` is closed afterward — **Linear mode:**
`node scripts/linear-mcp.mjs get-issue <TICKET-ID>`, expect `status: \"Done\"`. **GitHub Issues
mode:** `gh issue view <TICKET-ID> --json state`, expect `\"CLOSED\"`; if `finish.md` doesn't
already close the issue for this project, run `gh issue close <TICKET-ID> --reason completed`
yourself (finish.md should have handled tracker closure, but verify — do not assume either way).
Set `phase: \"finish\"`, `status: \"done\"` in the state file. This unblocks the orchestrator to
start the next ticket."

## Pauses — ask and wait, never guess past these

A pause is not a failure and not an abort. It's the same mechanism every time: stop before the
next phase, ask a specific question in this conversation, wait for the reply, record the answer
in the state file, continue. The run stays parked on the current ticket — it does not skip ahead
to the next one while waiting (sequencing, above, is why).

Things that pause a ticket:

- Pre-flight (or Plan, as a fallback) judges it "complex" or "needs decomposition" — the
  question was already asked and answered before phase 1 for anything pre-flight caught; a
  Plan-phase pause means pre-flight missed it
- Critic gate BLOCK (ship phase)
- CI failure not clearly caused by this ticket's own change, or a second failure after one fix
  attempt (verify phase)
- Merge conflict, or `gh pr merge` failure for any reason (merge phase)
- Branch/issue collision `start-issue.md` flags as needing a decision
- A repo-specific push-permission policy applies and hasn't been granted yet (ship/verify phases)
- `--auto-merge` was not passed and a ticket reaches the merge gate — the intended pause, not a
  problem

**`--resume` is for a different situation: the session itself ending**, not for any of the above.
If the session is still running, every pause above resolves by just answering in the next
message — no flag, no re-invocation. `--resume` only matters if you come back *later*, in a new
session: it reloads `.planning/pipeline-state.json`, re-verifies the in-flight ticket's
branch/PR/tracker status against reality (time has passed — the PR might already be merged, the
branch might be gone), and continues from its recorded `phase` rather than restarting from
scratch.

## Example usage

(Using venture-lab's `VEN-` prefix for illustration — substitute this project's own, per Step 0.)

```
/run-tickets VEN-45,VEN-46,VEN-47,VEN-48,VEN-49,VEN-50,VEN-51,VEN-52,VEN-53,VEN-54
```
Phase 0 fetches all ten, judges each, and opens with one consolidated message: which are clear
to run straight through, and every clarifying question for the rest, together, before anything
is touched. Answer them once, up front — then the clear ones run phase 1 through 7
uninterrupted, ticket after ticket, only pausing again for the manual-merge gate (or anything
genuinely unanticipated) on each one.

```
/run-tickets VEN-45,VEN-46,VEN-47
```
Runs those three tickets in the given order, pausing for manual merge after each one's CI goes
green.

```
/run-tickets all --auto-merge
```
Discovers every open ticket assigned to the user, runs them in priority order, merges each
automatically once CI passes, and only stops for a real blocker.

```
/run-tickets --resume
```
Continues whatever run is recorded in `.planning/pipeline-state.json`.

## Error Handling

| Scenario | Action |
|---|---|
| `scripts/linear-mcp.mjs` fails (no cached OAuth entry, dead refresh token, no Linear config found for this project) | Report the exact error from the script; do not fall back to inventing issue data |
| State file exists with an `in_progress` ticket and no `--resume` given | Ask before overwriting: resume, or start a fresh run (which orphans the in-flight ticket's branch/PR — flag that explicitly) |
| A phase's subagent can't complete without a decision not covered above | Pause: ask, report why, wait for a reply in this same conversation |
| `gh` or tracker auth expires mid-run | Report which step failed and why; do not silently skip that ticket |

## Project Path

Resolved fresh every run (Step 0) — not hardcoded, since this command is shared across
multiple repos:

| Setting | Value |
|---------|-------|
| **Project** | `$REPO_ROOT` (`git rev-parse --show-toplevel`) |
| **Base Branch** | `$BASE_BRANCH` (`main` unless the remote's default branch says otherwise) |
