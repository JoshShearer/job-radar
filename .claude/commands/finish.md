Clean up after merging a PR — delete **both** the local and remote branch, return to main, sync.

Conventions: `.claude/linear.md`.

The unbreakable rule: every branch this command touches must leave both local **and** remote
clean. "Deleted local, remote still present" is a bug, not a partial success.

## Input

Argument: `$ARGUMENTS` (optional) — a branch name, e.g. `feature/job-12-workable-adapter`.
Omitted → auto-detect from the current branch, or scan for stale ones.

## Step 1: Detect the branch

**Argument given** → use it.
**On a `feature/*` or `fix/*` branch** → use the current branch.
**On main (batch scan)**:

```bash
git fetch origin --prune && \
git branch -vv | grep '\[.*: gone\]' || true
```

Then find local branches whose remote still exists but whose PR merged (covers
auto-delete-after-merge being disabled):

```bash
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/ | grep -E '^(feature|fix)/'); do
  pr=$(gh pr list --head "$b" --state merged --json number,mergedAt --jq '.[0]')
  [ -n "$pr" ] && echo "$b → $pr"
done
```

Verify each:

```bash
gh pr list --head <branch-name> --state merged --json number,mergedAt --jq '.[0]'
```

- Merged PR found → include with the merge date
- No merged PR → flag "No merged PR", exclude from the default `y`
- `gh` fails → warn, present all as "Unverified", require explicit `select`

```
Found N stale branches:

| # | Branch | Local | Remote | Status |
|---|--------|-------|--------|--------|
| 1 | feature/job-9-salary-parser | present | gone | Merged 2 days ago |
| 2 | feature/job-12-workable-adapter | present | present | Merged 1 day ago |
| 3 | feature/job-99-experiment | present | present | No merged PR found |

Clean up? (y/n/select)
- y: delete all verified-merged branches, local + remote (1-2). Branch 3 excluded.
- n: skip
- select: choose numbers, e.g. "1,2"
```

**No stale branches** → fall back to recent merges:

```bash
gh pr list --state merged --limit 5 --json number,headRefName,mergedAt
```

## Step 1b: Batch cleanup (replaces Steps 2–7)

Per branch:

1. `git checkout main` (first iteration only)
2. `git pull origin main` (first iteration only)
3. **Remote**: `git ls-remote --heads origin <branch>` — exists → `git push origin --delete <branch>` and capture the exit code; already gone → record `remote: already-deleted`
4. **Local**: `git branch -d <branch>`. If `-d` fails because the branch was squash-merged on GitHub, fall back to `git branch -D <branch>` **only** after `gh pr list --head <branch> --state merged` confirms the merge. Otherwise stop and surface the warning.
5. Record `{ branch, local, remote }`

After the loop:

6. `git fetch origin --prune`
7. **Verify**: re-run `git ls-remote --heads origin <branch>` and `git show-ref --verify --quiet refs/heads/<branch>` for every branch. Both must come back empty. Anything remaining is a FAILED row in the summary, not a success.

**Linear**: extract `JOB-XX` from the merged PR title first, then the branch name
(`job-(\d+)`). For each, check whether it is already Done; if not, `mcp__linear-jr__save_issue`
with `state: "Done"`.

Continue to Steps 8 → 9 → 10 with the batch template.

## Step 2: Verify the PR merged (single branch)

```bash
gh pr list --head <branch-name> --state merged --json number,mergedAt
```

Not merged → warn strongly and require confirmation.

## Step 3: Base branch

```bash
git config branch.<branch-name>.base-branch
```

Set → return there. Unset → `main`.

## Step 4: Pull

```bash
git pull origin <base-branch>
```

## Step 5: Delete the remote branch FIRST

Remote before local, so a partial failure leaves the local branch as a recovery anchor.

```bash
git ls-remote --heads origin <branch-name>
```

- Exists → `git push origin --delete <branch-name>`
- Already gone → record `remote: already-deleted`
- Push fails (permission, protection rule, network) → **STOP**, do not delete local

## Step 6: Delete the local branch

```bash
git branch -d <branch-name>
```

If `-d` fails and `gh pr list --head <branch> --state merged` confirms the merge, fall back
to `-D` — squash-merge is the dominant and safe case. Any other failure → warn and stop.

## Step 7: Prune

```bash
git fetch origin --prune
```

## Step 7.5: Verify both sides

```bash
git show-ref --verify --quiet refs/heads/<branch-name>   # must fail (exit 1)
git ls-remote --heads origin <branch-name>                # must print nothing
```

If either still resolves, surface it as a failure. Cleanup is not complete until both are gone.

## Step 8: Sync

```bash
git checkout main && git pull origin main
```

## Step 9: Worktree cleanup (conditional)

**Single branch:**

```bash
ISSUE_NUM=$(echo "<branch-name>" | grep -oE 'job-([0-9]+)' | grep -oE '[0-9]+')
ls -d ../job-radar-job-${ISSUE_NUM}/ 2>/dev/null
```

Worktree exists → offer removal. Inside it → instruct the user to exit first.

**Batch**: cross-reference active worktrees against deleted branches, surface orphans. Omit if none.

> Never remove a worktree owned by the `treehouse` / gnhf pool. This command only touches
> `job-radar-job-*` siblings it created.

## Step 10: Update Linear (single branch)

Check whether the issue is already Done (auto-closed by `Resolves JOB-XX`). If not,
`mcp__linear-jr__save_issue` with `state: "Done"`.

## Step 11: Summary

The output must show local **and** remote status for every branch. A row saying only
"Deleted" is incomplete and forbidden.

```
Cleanup Complete

## Branches Deleted
{if single:}
- Local: {branch} deleted
- Remote: {deleted | already-deleted-by-github | FAILED: <reason>}

{if batch:}
| Branch | Local | Remote |
|--------|-------|--------|
| feature/job-9-salary-parser     | Deleted | Already deleted by GitHub |
| feature/job-12-workable-adapter | Deleted | Deleted |

## Repo Synced
- main: up to date

## Linear
{if single:} JOB-12: Done
{if batch:}
- JOB-9: Done
- JOB-12: Done

## Documentation
Run `/update-docs` to bring TODO.md and README.md in line.

{if any FAILED row:}
## Action Required
{N} remote deletion(s) failed. Inspect with `git ls-remote --heads origin` and clear
manually before re-running.

## Next
1. `/update-docs`
2. `/orient`
3. `/start-issue JOB-XX`
```

**Already clean** (on main, nothing stale): "No feature branch detected — already on main.
Local and remote clean. Repo synced." Offer `/update-docs` or `/orient`.

## Error handling

| Scenario | Action |
|---|---|
| Branch missing locally | Check `git ls-remote`; if the remote is present, offer a remote-only delete |
| PR not merged | Warn strongly, require confirmation before any delete |
| Uncommitted changes | Stash or commit before checkout |
| Local `-d` fails AND PR merged | Fall back to `-D` |
| Local `-d` fails AND PR not merged | Stop, surface to the user |
| Remote delete fails | Stop, do **not** delete local, surface the error |
| Pull conflicts | Stop, alert the user |
| `gh` failure | Warn, skip merge verification, require explicit `select` |
| Step 7.5 finds residue | FAILED row; do not claim success |

## Safety invariants

1. Local and remote both cleaned, every time. One side only is a failure.
2. Remote delete runs before local in single-branch mode, so the local branch remains a recovery anchor.
3. Never force-delete (`-D`) without `gh` confirming the PR merged.
4. Never delete a remote branch whose PR is not merged — even on explicit confirmation, log it loudly.
5. The verification pass is mandatory. This command does not report success without it.
