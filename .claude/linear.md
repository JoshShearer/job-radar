# Linear conventions — Job Radar

Single source of truth for how the `/`-commands talk to Linear. Every command in
`.claude/commands/` refers here instead of restating it, so a status rename is one edit.

## Account

| Setting | Value |
|---|---|
| **Workspace** | `job-radar` (slug `job-radar-app`) |
| **Team** | name `Job-radar`, key `JOB` — <https://linear.app/job-radar-app/team/JOB/all> |
| **MCP server** | `linear-jr` (see `.mcp.json`) → tools are `mcp__linear-jr__*` |
| **Issue IDs** | `JOB-12`. Commands accept `JOB-12`, `job-12`, or bare `12`. |

The server is named `linear-jr` rather than `linear` so it stays distinguishable from the
Linear server in any other project on this machine. MCP names are per-project, but the tool
names appear in transcripts, and an ambiguous `mcp__linear__save_issue` in a log is worth
avoiding.

## Statuses

**Verified against the JOB team on 2026-08-13** via `mcp__linear-jr__list_issue_statuses`.

| Status | Type |
|---|---|
| `Backlog` | backlog |
| `Todo` | unstarted |
| `In Progress` | started |
| `Done` | completed |
| `Canceled` | canceled |
| `Duplicate` | duplicate |

### There is no `In Review`

The team uses Linear's default six states, which do not include one. This matters because
`/ship` would otherwise try to set a status that does not exist, and `/verify` would filter
on it and find nothing.

**Rule for every command:** treat `In Review` as optional.

- If a status named `In Review` exists, `/ship` moves the issue there and `/verify` expects it.
- If it does not, `/ship` leaves the issue **In Progress** and posts the PR link as a comment.
  The open PR is the review signal. `/verify` then accepts **In Progress with an open PR** as
  the pre-merge state.

Re-run `list_issue_statuses` and update this table if the workflow changes. Adding an
`In Review` state in Linear restores the intended flow with no edits to any command.

## Labels

**Verified against the JOB team on 2026-08-13** via `mcp__linear-jr__list_issue_labels`.

| Label | Color |
|---|---|
| `Bug` | `#EB5757` |
| `Feature` | `#BB87FC` |
| `Improvement` | `#4EA7FC` |

That is the whole set. `Chore` and `Documentation` do **not** exist, and there are no area
labels. Commands must apply only a label from this table, or none.

| Issue type | Label to apply |
|---|---|
| feature | `Feature` |
| bug | `Bug` |
| tech-debt | `Improvement` |
| blocker | none (priority Urgent carries it) |
| plan | none |

Area is conveyed by the commit scope (`feat(sources): …`) and the branch name rather than by
a label. If area labels get created later, add them here and to `/create-issue` Step 3.

### Re-running discovery

```
mcp__linear-jr__get_workspace         → workspace name and url
mcp__linear-jr__list_teams            → team id and name
mcp__linear-jr__list_issue_statuses   → statuses for the team
mcp__linear-jr__list_issue_labels     → label set
```

## Issue URLs

**Use the `url` field the MCP returns** on `get_issue` / `save_issue` rather than building one.

The workspace slug is `job-radar-app`, so an issue URL does follow the shape
`https://linear.app/job-radar-app/issue/JOB-{n}` — but Linear appends a title slug and
rewrites the path when an issue moves team. The returned `url` is always correct; a
hand-built one is correct only until it isn't. Use the slug above for a team-level link
(the board, a filter), never for a specific issue.

## Branch naming

| Kind | Pattern | Example |
|---|---|---|
| Feature | `feature/job-{N}-{slug}` | `feature/job-12-workable-adapter` |
| Fix | `fix/job-{N}-{slug}` | `fix/job-19-salary-parse-range` |

Slug: lowercase issue title, non-alphanumerics to `-`, truncated near 50 chars.

## Worktrees

Worktrees are siblings of the primary repo, named `job-radar-job-{N}`:

```
~/Documents/Dev/
├── job-radar/          ← primary workspace
├── job-radar-job-12/   ← worktree for JOB-12
└── job-radar-job-19/   ← worktree for JOB-19
```

**Lane rule (from the global CLAUDE.md):** this pool is for interactive feature work only.
`treehouse` owns the gnhf / parallel-agent worktree pool. Never point both at the same
directory, and never run gnhf against a worktree these commands created.

## Quality gates

This repo has **no CI and no lint script**. The gates are local and both must pass:

```bash
npm test          # vitest run, including the real-Chromium refusal harness (~50 s)
npm run typecheck # tsc --noEmit
```

`npm run serve` starts the local web UI (127.0.0.1), for work on `src/ui/`.

Per `CLAUDE.md`, passing tests alone is not sufficient to claim something works — the
command that changed must actually be run. `/verify` enforces that.

## Degradation

If the `linear-jr` MCP server is not connected, every command still does its git work and
prints what it *would* have sent to Linear as a table for manual entry. A missing
ticketing system is never a reason to block a commit.
