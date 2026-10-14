Start a new session — show git state, sync with remote, install deps if the lockfile moved, and surface what to work on next.

Conventions: `.claude/linear.md`.

## Parallelism

Two independent lanes — run them concurrently, then synthesize into Step 5:

1. **Bash**: Steps 0–3 (context detection, git state, fetch, stale branches, PRs)
2. **Linear MCP**: Step 2 (In Progress / In Review / Todo)

## Step 0: Detect session context

```bash
CURRENT_DIR="$(basename "$(pwd)")"
if [[ "$CURRENT_DIR" =~ -job-([0-9]+)$ ]]; then
  echo "SESSION_TYPE=worktree"
  echo "ISSUE_NUM=${BASH_REMATCH[1]}"
  [ -f ".worktree-meta.json" ] && cat .worktree-meta.json || echo "META=missing"
else
  echo "SESSION_TYPE=primary"
fi
```

**Worktree**: condensed Steps 1–4, skip 4.6 and 4.7, query only `JOB-{NUM}` in Step 2.
**Primary**: full Steps 1–5.

## Step 1: Git state

Single repo — one call.

```bash
git fetch origin --prune && \
echo "BRANCH=$(git branch --show-current)" && \
git status --short && \
echo "SYNC=$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo '? ?')" && \
git log --oneline -5 && \
echo "=== STALE ===" && \
(git branch -vv | grep '\[.*: gone\]' || echo "none")
```

Worktrees (primary session only):

```bash
PRIMARY="$(pwd)"
[[ "$(basename "$PRIMARY")" =~ -job-[0-9]+$ ]] && PRIMARY="${PRIMARY%-job-*}"
shopt -s nullglob
for dir in "${PRIMARY}"-job-*/; do
  [ -d "$dir" ] || continue
  NUM=$(basename "$dir" | grep -oE '[0-9]+$')
  echo "=== JOB-$NUM ==="
  [ -f "$dir/.worktree-meta.json" ] && cat "$dir/.worktree-meta.json"
  BRANCH=$(cd "$dir" && git branch --show-current 2>/dev/null || echo "detached")
  DIRTY=$(cd "$dir" && git status --short 2>/dev/null | wc -l | tr -d ' ')
  AHEAD=$(cd "$dir" && git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
  echo "  branch=$BRANCH ahead=$AHEAD dirty=$DIRTY"
done
echo "=== END WORKTREES ==="
```

## Step 2: Linear issues (parallel with Step 1)

`mcp__linear-jr__list_issues` with `assignee: "me"`:

1. `state: "In Progress"`
2. `state: "Todo"` (limit 5)

The JOB team has **no `In Review` status** (see `.claude/linear.md`). Split the In Progress
results by whether an open PR exists (`gh pr list --head feature/job-{N}-*`) and report those
under an **In Review** heading — the PR is the review signal. If an `In Review` status is
added to the team later, query it directly as a third call instead.

**Worktree variant**: `mcp__linear-jr__get_issue` with `id: "JOB-{ISSUE_NUM}"` instead.

## Step 3: Detect resume scenario

Check whether the branch matches `feature/job-{N}-*` or `fix/job-{N}-*`.

## Step 4: Sync

| Branch | Tree | vs upstream | Action |
|---|---|---|---|
| main | clean | behind | `git pull --ff-only` |
| main | dirty | behind | `git stash -u` → `git pull --ff-only` → `git stash pop`. On pop conflict, leave the stash intact and surface its message. |
| feature/* | clean | behind | `git pull --ff-only` from the branch's own upstream — picks up pushes from another machine or worktree |
| feature/* | dirty | behind | Skip with warning (WIP — don't risk it) |
| any | — | no upstream | Skip silently |
| any | — | up to date | Report "up to date" |

```bash
ROOT="/home/joshshearer/Documents/Dev/job-radar"

sync_repo() {
  local LABEL="$1" DIR="$2"
  [ -d "$DIR/.git" ] || return
  cd "$DIR" || return
  local BRANCH UPSTREAM BEHIND DIRTY STASH_MSG
  BRANCH=$(git branch --show-current)
  UPSTREAM=$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo "")
  if [ -z "$UPSTREAM" ]; then
    echo "=== $LABEL: no upstream for $BRANCH — skipping ==="
    return
  fi
  BEHIND=$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)
  if [ "$BEHIND" -eq 0 ] 2>/dev/null; then
    echo "=== $LABEL: up to date ($BRANCH) ==="
    return
  fi
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  if [ "$BRANCH" = "main" ] && [ "$DIRTY" -gt 0 ] 2>/dev/null; then
    STASH_MSG="orient-autostash-$(date +%s)"
    echo "=== $LABEL: stash($DIRTY) + pull $BEHIND + pop ==="
    if git stash push -u -m "$STASH_MSG" >/dev/null 2>&1; then
      if git pull --ff-only 2>&1 | tail -2; then
        git stash pop 2>&1 | tail -2 || echo "  stash pop conflicted — recover with: git stash list | grep '$STASH_MSG'"
      else
        echo "  pull failed, restoring stash"
        git stash pop >/dev/null 2>&1 || true
      fi
    else
      echo "  stash failed — skipping pull"
    fi
  elif [ "$DIRTY" -gt 0 ] 2>/dev/null; then
    echo "=== $LABEL: on $BRANCH, $DIRTY dirty — skipping pull (WIP) ==="
  else
    echo "=== $LABEL: pulling $BEHIND from $UPSTREAM ==="
    git pull --ff-only 2>&1 | tail -2
  fi
}

sync_repo "job-radar" "$ROOT"

shopt -s nullglob
for dir in "${ROOT}"-job-*/; do
  [ -d "$dir/.git" ] || continue
  sync_repo "worktree-job-$(basename "$dir" | grep -oE '[0-9]+$')" "$dir"
done
```

**Never auto-rebase a feature branch onto main.** Surface the `behind main` count in the
Step 5 table and let the user invoke rebase explicitly.

## Step 4.5: Install deps if the lockfile moved

```bash
LOCK_CHANGED=$(git diff HEAD@{1} HEAD -- package-lock.json pnpm-lock.yaml package.json 2>/dev/null | head -1)
[ -n "$LOCK_CHANGED" ] && { echo "=== lockfile changed, installing ==="; npm install 2>&1 | tail -3; }
```

Report but do **not** auto-act on these:

```bash
git diff HEAD@{1} HEAD -- .env.example 2>/dev/null | head -1 && echo "ENV_EXAMPLE_CHANGED"
git diff HEAD@{1} HEAD -- config/ 2>/dev/null | head -1 && echo "CONFIG_CHANGED"
```

| Change | Action |
|---|---|
| `.env.example` | Review local `.env` — a new key means a stage will fail at runtime, not at typecheck |
| `config.example/` | The shape `jr init` copies; strict, coherence-checked on load. Run `npm run cli -- check`, and `sources` if `sources.yaml` moved |

> `config/candidate/evidence.yaml` and `config/candidate/personal.yaml` are gitignored and will
> never show here. If they are missing locally, tailor, prepare and fill refuse — that is
> expected, not drift.

## Step 4.6: Stale local branches

From Step 1's `[gone]` output. Candidates for `/finish <branch-name>`. Omit if none.

## Step 4.7: Undocumented merges

```bash
gh pr list --state merged --limit 10 --json number,title,headRefName,mergedAt
git log --oneline --since="7 days ago" --grep="docs:"
```

Cross-reference: extract `JOB-XX` from the PR title first, then the branch name (`job-(\d+)`).
Skip PRs titled `docs:*`, older than 7 days, or with no `JOB-XX`. Omit the section if all
matched or skipped.

## Step 5: Output

```
## Session Orientation

### Repo State
| Branch | Clean | Sync | Deps |
|--------|-------|------|------|
| main | Yes | Up to date | OK |

### Recent Activity (last 3 days)
- abc1234 feat(sources): add Workable adapter

### Linear Issues
**In Progress:**
- JOB-12: Workable public API adapter (Sources) ← on this branch

**In Review:**
- JOB-9: Salary range parser - PR #4

**Todo:**
- JOB-14: Company research cache
- JOB-15: discover --add writes to sources.yaml

### Active Worktrees {omit if none}
| Issue | Branch | Ahead | Dirty |
|-------|--------|-------|-------|
| JOB-14 | feature/job-14-research-cache | 2 | No |

> `/worktrees` for details, `/worktrees conflicts` for file overlap.

### Housekeeping {omit if nothing found}

**Stale Branches:**
| Branch | Action |
|--------|--------|
| feature/job-9-salary-parser | `/finish feature/job-9-salary-parser` |

**Undocumented Merges:**
| PR | Title | Merged |
|----|-------|--------|
| #4 | fix(salary): parse hyphenated ranges (JOB-9) | 2 days ago |

> Run `/update-docs` to catch up.
```

### Work Mode (primary sessions only)

Show **only** when `SESSION_TYPE=primary` and there are 2+ actionable issues
(In Progress + Todo). Otherwise go straight to Recommended Action.

```
### Work Mode

You have X actionable issues (Y in progress, Z todo).

1. **Single issue** — one issue this session
2. **Parallel sessions** — worktrees for 2+ issues
```

| Option | Action |
|---|---|
| Single issue | Continue to Recommended Action |
| Parallel sessions | Ask for the JOB-XX list → `/worktrees create` per issue |

### Recommended Action

**Worktree session:**

```
### Session Context

You're in worktree **JOB-{NUM}** — {issue title}

| Property | Value |
|----------|-------|
| Branch | {from meta or git} |
| Linear Status | {from Step 2} |

**Next:** `/start-issue JOB-{NUM}`
```

**Primary session** — one of:

- **Resume**: on a feature branch → `/start-issue JOB-XX` to continue
- **Todo**: no WIP → list `/start-issue JOB-XX` options plus `/create-issue`
- **In Review**: issue in review → check the PR; gates green and approved → merge, then `/finish`

## Error handling

| Scenario | Action |
|---|---|
| `git fetch` fails | Warn network, continue with local state |
| `git pull --ff-only` rejected | Skip, surface in the table; user rebases explicitly |
| `git stash pop` conflicts | Leave the stash intact, surface `orient-autostash-<ts>` |
| Linear MCP unavailable | Warn, give a git-only orientation, skip Work Mode |
| Merge conflicts in the tree | Stop, surface as the priority |
| `gh pr list` fails | Warn, skip undocumented-merge detection |
| `npm install` fails | Warn, show the error, continue orienting |
