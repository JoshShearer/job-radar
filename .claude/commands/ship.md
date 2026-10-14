Commit, push, and open a PR for the current branch.

Conventions: `.claude/linear.md`.

## Gate guide

| Change size | Command | What it runs |
|---|---|---|
| **Routine** | `/ship` | tests + typecheck + constraint check + critic gate (auto-depth) |
| **Major PR** | `/ship --deslop` | above + the 30-principle analysis (~27k tokens) |
| **Emergency** | `/ship --skip-critique` | quality checks only, logged in the PR body |

## Prerequisites

1. On a `feature/*` or `fix/*` branch, **not** main
2. Changes ready and reviewed

## Optional flags

### `--deslop`
Run `/deslop` before committing. P0/P1 findings → show output, ask to confirm. P2+ or clean → brief summary, continue.

### `--skip-critique`
Skip Step 5. Emergency hotfixes and reverts only. Logged as `Critic review skipped` in the PR body.

## Step 1: Verify branch state

```bash
git branch --show-current
git status
```

**STOP if on main.** Detect the base branch:

```bash
git config branch.<current-branch>.base-branch
```

Set → PR target. Unset → `main`.

## Step 2: Detect the Linear issue

Parse the branch for `job-{N}`. If found, `mcp__linear-jr__get_issue` for title, description,
and acceptance criteria, then confirm: "Detected JOB-12: {title}. Link this PR?"

## Step 3: Review the diff

```bash
git diff --stat
git diff
```

Summarize and confirm.

## Step 4: Quality gates

Both are mandatory and run in parallel. There is no CI — these are the only automated
checks this project has.

```bash
npm test
```

```bash
npm run typecheck
```

Either fails → stop and help fix. Do not commit around a red test.

### Step 4b: Run what changed

Per `CLAUDE.md`, passing tests are not sufficient to claim something works. If the diff
touches a command path, actually run it before shipping:

| Changed area | Run |
|---|---|
| `src/adapters/ats/`, `src/adapters/http/`, `src/app/sweep.ts` | `npm run cli -- sources` |
| `src/domain/catalog/`, `src/domain/evaluation/` (identity, eligibility, scoring, ranking) | `npm run cli -- evaluate` then `top` |
| `src/app/briefing.ts`, `src/ui/` | `npm run cli -- report` (and `serve` for the web UI) |
| `src/app/gateway.ts`, `src/app/assess*.ts`, `src/domain/llm/` | `npm run cli -- assess --dry-run`, then `assess --limit 2 --max-spend 0.5` — this one costs money |
| `src/domain/materials/`, `src/domain/candidate/` | `npm run cli -- evidence match <id>` and `render <id>` (free) |
| `src/domain/browser/`, `src/adapters/browser/` | `npm run cli -- fill <id> --headless` against a real posting, and confirm it stopped at submit |
| `src/domain/config/` | `npm run cli -- check` — config is validated on load |

Record what you ran and the outcome; it goes in the PR body under Testing.

## Step 5: Constraint gate

Run `/check-constraints`. Any **BLOCK** row stops the ship. This is not advisory — the
constraints it checks are the ones `CLAUDE.md` calls non-negotiable.

This gate works whether or not the diff is committed yet: it diffs against
`$(git merge-base origin/main HEAD)`, which covers committed, staged, and unstaged changes.
If it reports every constraint as PASS on a diff you know touches `src/`, treat that as the
gate being broken rather than the code being clean, and check the range first.

## Step 6: Critic gate

**Skip**: `--skip-critique` → log it and note it in the PR body.
**Auto-pass**: all changes are docs, lockfiles, or whitespace → log and proceed.
Exception: `.claude/` changes always require review.

**Check for an existing verdict**: read `.claude/last-critique.md`. **If it carries a `**Mode:**`
line whose value is not `Code Review`, discard it and run a fresh `/critique`** — plan review
scores on the same 0–100 scale, so reusing one here would ship unreviewed code on the strength of
a review that never read any code (no `**Mode:**` line means it predates the field and is a code
review). Otherwise: if its recorded commit matches `HEAD`, reuse it; else run `/critique`.

| Verdict | Action |
|---|---|
| PASS | Proceed |
| CONCERNS | Show the user. Ship → add to the PR under "Critic Notes". Fix → stop. |
| BLOCK | Stop, show the blocking issues |

## Step 7: Stage and commit

**If the work is already committed** (you committed while implementing, or `/ship` is being
re-run), skip to Step 8. Do not create an empty commit and do not amend a commit that has
already been pushed. Confirm with `git log origin/main..HEAD --oneline` that the commits
exist and their messages are right; amend only if nothing has been pushed yet.

Footer: no Linear issue → no footer. Issue found → `Resolves JOB-XX`.

> `Resolves JOB-XX` is for humans reading git history and for cross-referencing in
> `/update-docs`. It does **not** close the Linear issue — that is a GitHub keyword, and
> Linear's GitHub integration is not connected here. `/finish` Step 10 does the closing.

```bash
git add -A
git commit -m "<type>(<scope>): <description>

<body if needed>

Resolves JOB-XX

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
Scopes mirror the layers and areas: `catalog`, `evaluation`, `assess`, `materials`, `fill`, `mail`, `pursuit`, `gateway`, `sources`, `db`, `config`, `cli`, `web`.
Description: imperative, lowercase, no trailing period.

> Never `git add` `config/candidate/evidence.yaml`, `config/candidate/personal.yaml`, `.env`,
> `data/`, `reports/`, `artifacts/`, `legacy-v1/`, or v1's `config/resume.yaml`,
> `config/personal.yaml`, `resumes/*`, `applications/`. They are gitignored because they hold real personal
> data. If `git status` shows any of them as untracked, stop and investigate rather than
> committing.

## Step 8: Push

```bash
git push -u origin <branch-name>
```

## Step 9: Implementation notes

Produce for the PR body:

1. Files changed (path + purpose)
2. Approach
3. Key decisions and rationale
4. Dependencies added
5. Schema or config changes (`src/adapters/sqlite/schema.ts` `MIGRATIONS`, config keys in `src/domain/config/schema.ts`)
6. Testing — what was run, including the Step 4b command and its result
7. Known limitations

## Step 10: Create the PR

```bash
gh pr create --base <base-branch> --title "<type>(<scope>): <description>" --body "<body>"
```

```markdown
## Summary
<bullets>

## Implementation Notes
### Files Changed
- `path/to/file` — <purpose>

### Approach
<strategy>

### Key Decisions
- <decision + rationale>

### Schema / Config Changes
- <db columns or config keys added>

### Testing
- `npm test` — <n> passed
- `npm run typecheck` — clean
- `npm run cli -- sources` — <n> boards, <n> errors

## Test Plan
- [ ] <verification step a human should do>

## Checklist
- [ ] `npm test` and `npm run typecheck` pass locally
- [ ] The changed command was actually run
- [ ] No personal data files staged
- [ ] Constraint check clean
- [ ] Docs updated (if applicable)

Resolves JOB-XX

Generated with [Claude Code](https://claude.com/claude-code)
```

## Step 11: Update Linear

The JOB team has **no `In Review` status** (see `.claude/linear.md`). Handle both cases:

1. **If an `In Review` status exists** → `mcp__linear-jr__save_issue` with `state: "In Review"`
2. **If it does not** (current state of the team) → leave the issue **In Progress**. The open
   PR is the review signal. Do not invent a status, and do not move it to Done — it is not done.
3. Attach the PR URL to the issue links
4. `mcp__linear-jr__save_comment` with the implementation summary and the PR link — this is
   what carries the review state when there is no status for it

## Step 12: Report

```
Shipped.

Commit: abc1234 - feat(sources): add Workable adapter
PR: <url from gh>

Linear JOB-12:
- Status: In Progress (no In Review status on this team — the open PR is the signal)
- PR linked, implementation notes added

No CI configured — the gates that ran are the ones above.

Next:
1. `/verify` to re-run the gates and post results to the ticket
2. Merge the PR
3. `/finish` to clean up
```

## Error handling

| Scenario | Action |
|---|---|
| On main | Stop, ask for a feature branch |
| Gates fail | Stop, show the errors, help fix |
| Constraint BLOCK | Stop — do not offer an override |
| Push fails | Check the remote branch, surface the force-push decision to the user |
| PR creation fails | Check `gh auth status`, show the error |
| Linear update fails | Warn and continue — the PR is the priority |
