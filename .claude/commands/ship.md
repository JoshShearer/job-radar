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
| `src/sources/`, `src/pipeline/ingest.ts` | `npm run cli -- sources` |
| `src/pipeline/` (score, filters, dedupe, normalize) | `npm run cli -- score` |
| `src/report/` | `npm run radar` then `npm run cli -- open` |
| `src/analysis/` | `npm run cli -- analyze` on a small slice — this one costs money |
| `src/resume/` | `npm run cli -- resume match <job-id>` |
| `src/apply/` | `npm run cli -- autofill <job-id>` against a real posting, and confirm it stopped at submit |
| `src/config/` | any command — config is validated on load |

Record what you ran and the outcome; it goes in the PR body under Testing.

## Step 5: Constraint gate

Run `/check-constraints`. Any **BLOCK** row stops the ship. This is not advisory — the
constraints it checks are the ones `CLAUDE.md` calls non-negotiable.

## Step 6: Critic gate

**Skip**: `--skip-critique` → log it and note it in the PR body.
**Auto-pass**: all changes are docs, lockfiles, or whitespace → log and proceed.
Exception: `.claude/` changes always require review.

**Check for an existing verdict**: read `.claude/last-critique.md`. If its recorded commit
matches `HEAD`, reuse it. Otherwise run `/critique`.

| Verdict | Action |
|---|---|
| PASS | Proceed |
| CONCERNS | Show the user. Ship → add to the PR under "Critic Notes". Fix → stop. |
| BLOCK | Stop, show the blocking issues |

## Step 7: Stage and commit

Footer: no Linear issue → no footer. Issue found → `Resolves JOB-XX`.

```bash
git add -A
git commit -m "<type>(<scope>): <description>

<body if needed>

Resolves JOB-XX

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
Scopes mirror `src/`: `sources`, `pipeline`, `analysis`, `resume`, `apply`, `report`, `config`, `db`, `cli`.
Description: imperative, lowercase, no trailing period.

> Never `git add` `config/personal.yaml`, `config/resume.yaml`, `data/`, `reports/`,
> `resumes/*`, or `applications/`. They are gitignored because they hold real personal
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
5. Schema or config changes (`src/db/schema.ts`, `config/*.yaml` keys)
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
- `npm test` — 316 passed
- `npm run typecheck` — clean
- `npm run cli -- sources` — 104 boards, 0 errors

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
- Status: In Review
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
