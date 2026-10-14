Verify an issue is ready to merge — run the real gates and post the result to Linear.

Conventions: `.claude/linear.md`.

> Replaces LoopString's `/test-issue`. **This repo has no CI.** There is no `.github/`
> directory and no GitHub Actions workflow, so there is nothing to poll. The gates are
> local, and this command runs them rather than asking a server whether it already did.

## Input

Argument: `$ARGUMENTS` (optional Linear identifier, e.g. `JOB-12`).

## Purpose

Bridges `/ship` (PR open) and merge:

1. Runs `npm test` and `npm run typecheck`
2. Runs the actual command the change affects — the requirement `CLAUDE.md` states directly
3. Walks the PR's manual test plan
4. Posts the combined result to the Linear issue
5. Gives a ready-for-merge or fix-needed verdict

## Step 1: Resolve the issue

**With an argument**: parse it, fetch via `mcp__linear-jr__get_issue`.

**Without**: check `git branch --show-current` for `feature/job-{N}-*` or `fix/job-{N}-*`.
If not on one, list `mcp__linear-jr__list_issues` with `assignee: "me"` and the review state
defined below.

## Step 2: Validate status

The JOB team has **no `In Review` status** (see `.claude/linear.md`), so the pre-merge state
is status plus PR, not status alone.

| If `In Review` exists | Current team |
|---|---|
| Expected: **In Review** | Expected: **In Progress with an open PR** |

- **In Progress, no open PR** → suggest `/ship` first
- **Done** → already closed
- **Todo or Backlog** → suggest `/start-issue` first
- **Canceled or Duplicate** → stop; this issue is not being merged

## Step 3: Find the PR

1. Check the Linear issue's attached links
2. Otherwise `gh pr list --head <branch-name> --json number,url,title`
3. Still nothing → suggest `/ship` first

## Step 4: Automated gates

Run both, in parallel:

```bash
npm test
```

```bash
npm run typecheck
```

Report each as pass/fail with the failing output when red. **Stop here if either fails** —
do not proceed to the manual plan.

```
Gates: FAILED

npm test — 3 failing
  tests/sources.test.ts > greenhouse adapter > pins payload shape
  Expected 'absolute_url', received undefined

Likely cause: a provider renamed a field. That is what this test exists to catch.
Fix, push, and re-run /verify.
```

## Step 5: Run what changed

Determine the affected area from `git diff --name-only origin/main...HEAD` and run the
matching command. This is the step that distinguishes a green test suite from working software.

| Changed area | Command | What counts as pass |
|---|---|---|
| `src/adapters/ats/`, `src/adapters/http/`, `src/app/sweep.ts` | `npm run cli -- sources`, then `sweep --source <provider>` | Every configured board returns HTTP 200 with a non-empty list; no board aborted the sweep |
| `src/domain/catalog/`, `src/domain/evaluation/`, `src/app/evaluate.ts` | `npm run cli -- evaluate`, then `top` | Completes; eligible/priority counts and the calibration line move in the expected direction |
| `src/app/briefing.ts`, `src/ui/reports/`, `src/ui/web/` | `npm run cli -- report`, `serve` | Briefing renders; Remote OK attribution present when that source is enabled; web UI answers on 127.0.0.1 only |
| `src/app/gateway.ts`, `src/app/assess*.ts`, `src/domain/llm/`, `src/domain/budget/` | `npm run cli -- assess --dry-run`, then a small `assess --limit 2 --max-spend 0.5` | Completes; **unchanged postings come from cache**; `spend` matches the run's reported total |
| `src/domain/materials/`, `src/domain/candidate/`, `src/app/materials.ts` | `npm run cli -- evidence lint`, `evidence match <id>`, then `render <id>` (free) | `match` returns three states, not two; `repairs.md` and `pack-review.md` show nothing fabricated survived |
| `src/domain/browser/`, `src/adapters/browser/`, `src/app/fill.ts` | `npm test`, then `npm run cli -- fill <id> --headless` on a real posting | Form filled, **submit never clicked**, checkboxes untouched, demographics and attestations refused, unconfident dropdowns blank with options reported |
| `src/domain/config/`, `src/adapters/fs/config-loader.ts` | `npm run cli -- check` | Config loads; a bad key is an error, not a silent no-op |
| `src/adapters/sqlite/` | `npm run cli -- stats` against a copy of a real database | Migration clean, no data loss |
| `src/app/mail.ts`, `src/adapters/mail/` | `npm run cli -- mail scan --dry-run` | Pagination complete; nothing written on a dry run |

Record the exact command and its outcome. If the affected area cannot be exercised without
real personal data (`config/candidate/evidence.yaml`, `config/candidate/personal.yaml`) and those files are
absent, say so plainly rather than reporting the step as passed.

## Step 6: Manual test plan

1. `gh pr view <PR-number> --json body`
2. Parse the `## Test Plan` section

```
Manual Test Plan (2 items):

- [ ] Workable adapter returns postings for a known token
- [ ] A failing Workable token does not abort the run

Run manual tests? (y/n)
```

Walk each item, record PASS / FAIL / SKIP.

## Step 7: Summary

```
Verification for JOB-12
=======================

Gates:
  npm test        316 passed
  npm typecheck   clean

Behavior:
  npm run cli -- sources    105 boards, 105 OK, 0 errors

Manual:
  1. Workable adapter returns postings for a known token   PASS
  2. A failing token does not abort the run                PASS

Overall: READY FOR MERGE
```

## Step 8: Post to Linear

`mcp__linear-jr__save_comment` with the summary above.

## Step 9: Final output

```
Ready for merge — JOB-12

Gates:    passed
Behavior: npm run cli -- sources, 0 errors
Manual:   2/2 passed

Results posted to Linear.

Next:
1. Review the PR: <url>
2. Merge
3. `/finish`
```

## Error handling

| Scenario | Action |
|---|---|
| Issue not found | Show the error, suggest checking the ID |
| Issue not in the review state | Show the current status, suggest the right command |
| No PR found | Suggest `/ship` first |
| A gate fails | Show the failure, stop before the manual plan |
| Step 5 needs absent personal data | Report the step as **not run**, never as passed |
| Linear update fails | Warn, still report results to the user |
