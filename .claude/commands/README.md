# Claude Code custom commands — Job Radar

Ported from the LoopString platform workspace and adapted for this repo. Linear conventions
live in `../linear.md`; every command reads from there rather than restating the team key,
statuses, or branch patterns.

---

## Workflow commands (9)

| Command | Purpose | Linear status |
|---|---|---|
| `/orient` | **Start of session** — git state, sync, stale branches, undocumented merges, JOB issues, next action | — |
| `/create-issue` | Create a JOB issue from conversation | → Todo |
| `/start-issue` | Start work — branch, context, status | → In Progress |
| `/ship` | Gates, commit, push, PR with implementation notes | stays In Progress + PR comment¹ |
| `/verify` | Run the real gates + the command that changed, post results | — (comments) |
| `/update-docs` | Bring `TODO.md` / `README.md` in line after merge | — |
| `/worktrees` | **Parallel sessions** — list, inspect, create, remove; file-conflict check | — |
| `/finish` | **End of cycle** — delete branch (local + remote), sync, close | → Done |
| `/whats-next` | **Session handoff** — full context capture for a fresh session | — |

## Quality commands (4)

| Command | Purpose | Context cost |
|---|---|---|
| `/critique` | **Adversarial review** — risk-adaptive depth (L1 / L2 / L2+Double), auto-runs in `/ship` | ~500–4000 tokens |
| `/check-constraints` | **Non-negotiables** — 20 constraints from `CLAUDE.md`, BLOCK stops `/ship` | ~1k tokens |
| `/deslop` | **Comprehensive** — 30+ coding principles + Job Radar patterns | ~27k tokens (large) |
| `/update-packages` | Dependency updates gated on the real test suite | ~medium |

> `/deslop` consumes roughly a quarter of the context window per invocation. Use `/critique`
> for routine review; reserve `/deslop` for a major PR or a pre-release pass.

---

## The normal cycle

```
/orient  →  /create-issue  →  /start-issue  →  ...work...  →  /ship  →  /verify  →  merge  →  /finish  →  /update-docs
```

---

## What differs from the LoopString originals

| Difference | Why |
|---|---|
| `/verify` replaces `/test-issue` | job-radar has no `.github/` and no CI. There is no build to poll, so the command runs the gates itself. |
| Gates are `npm test` + `npm run typecheck` | No lint script, no eslint, no build step in this repo. |
| Every command adds a "run what changed" step | `CLAUDE.md` requires the affected command to actually be executed. A green suite is not a claim that something works. |
| `/critique` is self-contained | No agents were ported; the critic protocol is inlined. |
| `/check-constraints` was rewritten, not ported | The constraints are entirely different: truthfulness, refusals, determinism, cost. |
| Single repo, not an umbrella | `/orient`, `/finish`, and `/update-packages` collapse their multi-repo loops. |
| Worktrees install deps and link personal config | A fresh worktree has no `node_modules` and no `config/` (`jr init` creates it), and `config/candidate/evidence.yaml` / `config/candidate/personal.yaml` are gitignored, so tailor, prepare and fill would refuse without symlinks. |

## Not ported

The IoT-specific commands (`check-rtdb`, `new-sensor`, `test-device`, `clean-device`,
`find-pis`, `review-flow`, `edit-richtext`), the 7 agents, the 3 hooks, `settings.json`, the
`review` skill (its patterns are React and Firebase), `/docs-drift`, `/audit-ecosystem`,
`/ask`, and `/lenses`.

`post-edit-lint.sh` in particular would be a no-op — there is no eslint here.

## Setup

The Linear MCP server is declared in `../../.mcp.json` as **`linear-jr`** (tools:
`mcp__linear-jr__*`), pointing at the `job-radar-app` workspace, team
[JOB](https://linear.app/job-radar-app/team/JOB/all).

Run `/mcp` once and complete the OAuth flow before any Linear-touching command will work.
Until then every command degrades to git-only and prints what it would have sent.

¹ **The JOB team has no `In Review` status.** Verified statuses are Backlog, Todo, In
Progress, Done, Canceled, Duplicate; verified labels are Bug, Feature, Improvement only.
`/ship` therefore leaves the issue In Progress and posts the PR link as a comment, and
`/verify` treats "In Progress with an open PR" as the pre-merge state. Adding an `In Review`
status in Linear restores the intended flow with no command edits — the fallback is
conditional. Details and the re-discovery block are in `../linear.md`.

The status and label names in `../linear.md` are Linear's defaults and are **unverified**
against the JOB team. Run the discovery block in that file once and correct it — everything
downstream reads from it.
