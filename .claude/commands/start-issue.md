Start work on a Linear issue — create the branch, update status.

Conventions: `.claude/linear.md`.

## Input

Argument: `$ARGUMENTS` (Linear issue identifier, e.g. `JOB-12`). Accepts `JOB-12`, `job-12`, `12`.

## Step 1: Resolve the issue

**With an argument**: parse it.

**Without one**: check `git branch --show-current`. If it matches `feature/job-{N}-*` or
`fix/job-{N}-*`, resume that issue.

Otherwise list candidates via `mcp__linear-jr__list_issues` (`assignee: "me"`, states
Backlog / Todo / In Progress) and present a picker:

```
No issue ID provided. Your assigned issues:

In Progress:
  1. JOB-12: Workable public API adapter (Normal)

Todo:
  2. JOB-14: Company research cache (Normal)
  3. JOB-15: discover --add writes to sources.yaml (Normal)

Backlog:
  4. JOB-20: Phase 3 dashboard (Low)

Enter a number, or an issue ID (e.g. JOB-12):
```

## Step 2: Fetch details

`mcp__linear-jr__get_issue` — title, description, labels, status, assignee, parent, project, url.

## Step 3: Parent context (only if the issue has a parent)

- Parent via `mcp__linear-jr__get_issue`
- Siblings via `mcp__linear-jr__list_issues` filtered by parent

## Step 4: Find related work in the repo

Non-blocking. Grep for the issue's subject in the places that carry project intent:

```bash
grep -rn "<keyword>" TODO.md README.md CLAUDE.md 2>/dev/null | head -10
```

`TODO.md` is the roadmap and frequently already contains the acceptance criteria for an
issue. Surface any matching line — it is usually more specific than the ticket.

## Step 5: Branch name

`feature/job-{N}-{slug}` (or `fix/` for a Bug-labelled issue). Slug = lowercase title,
non-alphanumerics to `-`, truncated near 50 chars.

## Step 6: Collision detection

- **In Progress by someone else**: warn, offer to proceed anyway or pick another. If the
  assignee is you, resume without warning.
- **Branch exists on remote**: `git ls-remote --heads origin <branch>`. If it exists, offer
  checkout-existing / create-new / cancel.

## Step 7: Parallel work context (skip inside a worktree)

- Other actionable issues via `mcp__linear-jr__list_issues` (In Progress + Todo, minus this one)
- Active worktrees: scan `../job-radar-job-*/`

## Step 8: Create the branch

Default base `main`. Adjust when:

- **Sub-issue with a parent branch**: `git ls-remote --heads origin "feature/job-{parent-N}-*"` → recommend the parent branch
- **Currently on a non-main branch**: weaker signal, present as an option

```bash
git checkout <base-branch> && git pull origin <base-branch> && git checkout -b <branch-name>
```

If base is not `main`: `git config branch.<branch-name>.base-branch <base-branch>`.

## Step 9: Update Linear

`mcp__linear-jr__save_issue` → `state: "In Progress"` (only if currently Backlog or Todo), and
`assignee: "me"` if unassigned.

## Step 10: Output

```
{Started work on | Resuming} JOB-12: Workable public API adapter

Branch: feature/job-12-workable-adapter {(checked out) if resumed}
Status: In Progress {(unchanged) if resumed}

{if has parent:}
## Parent Issue
JOB-10: Phase 2 sources
Status: In Progress

### Sub-Issues (1/3 complete)
| Issue | Title | Status |
|-------|-------|--------|
| JOB-11 | SmartRecruiters adapter | Done |
| JOB-12 | Workable adapter | In Prog ← You |
| JOB-13 | Recruitee adapter | Todo |

{if resumed:}
## Remaining Tasks
- [ ] Task from the issue body

Issue: {url from the MCP response}

## Related roadmap entries {omit if none}
- TODO.md:9 — Workable public API (`https://apply.workable.com/api/v1/widget/accounts/{token}`)

{Ready to implement! | Ready to continue!}

{PARALLEL WORK FOOTER if other issues/worktrees exist}
---
Active worktrees: JOB-14
Other actionable issues: JOB-15: discover --add writes to sources.yaml (Todo)
Tip: `/worktrees create JOB-XX` to work on several in parallel.
```

## Step 11: Reminders before implementing

Surface these only when the issue's area label or description implicates them:

- **Sources**: add a test in `tests/sources.test.ts` pinning the real observed payload shape.
  The adapter must catch its own errors and record them on `ctx.stats` — one failing source
  must never abort a run, and there is a test for that.
- **Pipeline / scoring**: tuning belongs in `config/career-profile.yaml`, not TypeScript.
  If the change requires editing TS to tune, that is a design bug.
- **Analysis**: any new model output reaching the database needs a JSON Schema *and* Zod
  re-validation.
- **Resume / Apply**: read the non-negotiables in `CLAUDE.md` first. Several of the
  refusals there are load-bearing and are not to be "improved" into answers.

## Step 12: Extract tasks (resumed work)

Parse `- [ ]` / `- [x]` from the issue description. Show remaining tasks prominently.

## Error handling

| Scenario | Action |
|---|---|
| Issue not found | Show the error, suggest checking the ID |
| Branch already exists | Ask: checkout existing or create new |
| Uncommitted changes | Warn, ask to stash or commit first |
| Not on main | Ask whether to switch |
| Linear MCP unavailable | Create the branch anyway, report that the status was not updated |
