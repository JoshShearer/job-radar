# Issue tracker: Linear

Issues and specs for this repo live in **Linear**, team `JOB` (workspace `job-radar`,
slug `job-radar-app`), reached through the `linear-jr` MCP server declared in
`.mcp.json`. Its tools are `mcp__linear-jr__*`.

**GitHub Issues is not used.** The GitHub remote (`JoshShearer/job-radar`) carries pull
requests only. `#45` is a PR; `JOB-45` is an issue. Never run `gh issue create`.

## `.claude/linear.md` is the source of truth

Statuses, the label set, ID formats, and the "there is no `In Review`" rule live in
[`.claude/linear.md`](../../.claude/linear.md), verified against the live team. Read it
before any write.

It is deliberately the single place those strings appear, so that a status rename is one
edit. Do not copy them into this file. Where the two disagree, `.claude/linear.md` wins
and this file is the one to fix.

## Enough to avoid damage without following the link

- **Never create a label or a status.** The JOB team has exactly three labels. Creating
  one is a change to a shared workspace and is the user's call. Applying a label that
  does not exist fails the create call.
- **Confirm before creating an issue.** Show title, label, priority, and assignee, and
  wait for a yes.
- **Use the URL the response returns.** Never construct a Linear URL.
- **Never invent a reproduction.** A bug issue records what was actually run; if the
  failing command was not run in the session, say so under Steps to Reproduce rather
  than writing plausible steps.

## Tools in use

`get_workspace`, `list_teams`, `list_issues`, `get_issue`, `save_issue`, `save_comment`,
`list_issue_statuses`, `list_issue_labels` — each prefixed `mcp__linear-jr__`. That is
the set `.claude/commands/` relies on; discover anything else rather than guessing at it.

## When a skill says "publish to the issue tracker"

Create a Linear issue in `JOB`, following `.claude/commands/create-issue.md`. It already
encodes the body structure per issue type and the **constraint note** that carries the
governing `CLAUDE.md` rule onto the ticket.

## When a skill says "fetch the relevant ticket"

`mcp__linear-jr__get_issue` with the `JOB-nn` identifier. Accept `JOB-12`, `job-12`, or
a bare `12`.

## Wayfinding

`/wayfinder`'s map-and-children structure has no agreed representation in this workspace.
If it is ever used, settle the shape (Linear sub-issues? a project?) with the user before
creating anything, and record the answer here.
