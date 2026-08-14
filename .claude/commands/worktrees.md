Manage parallel worktree workspaces — list, inspect, create, remove, check for file conflicts.

Conventions: `.claude/linear.md`.

## Lane rule

This command owns the **interactive** worktree pool only: siblings named `job-radar-job-{N}`.

`treehouse` owns the gnhf / parallel-agent pool. Never point both at the same directory, and
never create a worktree here for a gnhf run. If a sibling directory does not match
`job-radar-job-*`, this command leaves it alone.

## Input

Argument: `$ARGUMENTS` (optional subcommand)

| Subcommand | Purpose |
|---|---|
| *(none)* | List all active worktrees with status |
| `JOB-12` or `12` | Inspect one worktree in detail |
| `conflicts` | Check for file overlap between active branches |
| `create JOB-12` | Create a new worktree workspace |
| `remove JOB-12` | Remove one, with safety checks |

## Naming

```
~/Documents/Dev/
├── job-radar/          ← primary workspace
├── job-radar-job-12/   ← worktree for JOB-12
└── job-radar-job-14/   ← worktree for JOB-14
```

## Parse

- Empty → **List**
- `JOB-\d+`, `job-\d+`, bare `\d+` → **Inspect**
- `conflicts` → **Conflicts**
- `create <id>` → **Create**
- `remove <id>` → **Remove**

---

## Mode: List

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

Also check the primary workspace:

```bash
BRANCH=$(git branch --show-current 2>/dev/null)
[[ "$BRANCH" == feature/* || "$BRANCH" == fix/* ]] && echo "PRIMARY: $BRANCH"
```

None found:

```
No active worktrees. To create one:
  /worktrees create JOB-12
```

Otherwise format as a table, then check for stale references:

```bash
git worktree list --porcelain 2>/dev/null
```

Any path that no longer exists on disk → `Run \`git worktree prune\` to clean up.`

---

## Mode: Inspect (JOB-XX)

1. `ls -d ../job-radar-job-<NUM>/ 2>/dev/null`
2. `cat ../job-radar-job-<NUM>/.worktree-meta.json 2>/dev/null`
3. Changed files: `cd ../job-radar-job-<NUM> && git diff --name-only origin/main...HEAD`
4. Unpushed commits: `git log --oneline @{u}..HEAD` (fall back to `git log --oneline $(git merge-base origin/main HEAD)..HEAD`)
5. PR: `gh pr list --head "$BRANCH" --json number,title,state,url --limit 1`
6. Linear status via `mcp__linear-jr__get_issue`

```
## Worktree: JOB-<NUM>

| Property | Value |
|----------|-------|
| Path | ../job-radar-job-<NUM>/ |
| Branch | feature/job-<NUM>-... |
| Created | {from meta or unknown} |

### Linear Status
JOB-<NUM>: <title> — <status>

### PRs
- PR #XX (<state>) — <url>

### Changed Files (X files, Y commits ahead)
- src/sources/workable.ts
- tests/sources.test.ts

### Actions
- Open in Claude: `cd ../job-radar-job-<NUM> && claude`
- Remove: `/worktrees remove JOB-<NUM>`
```

---

## Mode: Conflicts

```bash
PRIMARY="$(pwd)"
[[ "$(basename "$PRIMARY")" =~ -job-[0-9]+$ ]] && PRIMARY="${PRIMARY%-job-*}"
shopt -s nullglob
for dir in "${PRIMARY}"-job-*/; do
  [ -d "$dir" ] || continue
  echo "JOB-$(basename "$dir" | grep -oE '[0-9]+$'):"
  (cd "$dir" && git diff --name-only origin/main...HEAD 2>/dev/null)
done

BRANCH=$(cd "$PRIMARY" && git branch --show-current 2>/dev/null)
if [[ "$BRANCH" == feature/* || "$BRANCH" == fix/* ]]; then
  echo "PRIMARY:"
  (cd "$PRIMARY" && git diff --name-only origin/main...HEAD 2>/dev/null)
fi
```

Build a file → branches map. Report any file in 2+ branches.

```
File overlap detected:

| File | Branches |
|------|----------|
| src/pipeline/normalize.ts | JOB-12, JOB-14 |
```

**High-collision files in this repo** — flag these loudly when they appear in 2+ branches,
because everything funnels through them:

| File | Why it collides |
|---|---|
| `src/pipeline/normalize.ts` | All source classification happens here, once |
| `src/sources/registry.ts` | Every new adapter registers here |
| `src/db/schema.ts` | Migrations conflict destructively |
| `config/career-profile.yaml` | All tuning lives here |
| `src/cli.ts` | Every new subcommand lands here |

No overlap → `All clear — no file overlap between active branches.`

---

## Mode: Create (create JOB-XX)

1. Parse the issue number
2. Already exists? `ls -d ../job-radar-job-<NUM>/ 2>/dev/null`
3. If currently inside a worktree, warn — create from the primary workspace
4. Create:

```bash
git worktree add ../job-radar-job-<NUM> -b feature/job-<NUM>-<slug>
```

If the slug is unknown, use `feature/job-<NUM>` as a placeholder; `/start-issue JOB-<NUM>`
in the new worktree can rename it.

5. Metadata:

```bash
cat > ../job-radar-job-<NUM>/.worktree-meta.json << EOF
{
  "issue": "JOB-<NUM>",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
```

6. **Install dependencies.** A fresh worktree has no `node_modules`, and with pnpm the
   native bindings matter — `pnpm-workspace.yaml` must keep `allowBuilds` true for
   **better-sqlite3** and **esbuild**, or every command fails with
   `Could not locate the bindings file`.

```bash
cd ../job-radar-job-<NUM> && npm install
```

7. **Link the gitignored personal config.** These files are not in git, so a new worktree
   cannot run the resume or apply commands without them. Symlink rather than copy, so
   there is exactly one real copy on disk:

```bash
cd ../job-radar-job-<NUM>
for f in config/personal.yaml config/resume.yaml .env; do
  [ -f "../job-radar/$f" ] && ln -sf "../job-radar/$f" "$f"
done
```

   Report which ones were linked and which were absent.

8. Run a conflict check if other worktrees exist
9. Report:

```
Worktree created: ../job-radar-job-<NUM>/

Dependencies installed. Linked: config/personal.yaml, .env
Not found (resume commands will fail here): config/resume.yaml

To start working:
  cd ../job-radar-job-<NUM> && claude
  # then: /start-issue JOB-<NUM>
```

**Critic gate required.** Every worktree PR passes `/critique` before merge, as part of
`/ship`. Never merge a worktree PR without it.

---

## Mode: Remove (remove JOB-XX)

1. Parse the number, confirm the worktree exists
2. Safety checks, in parallel:
   - Unpushed commits: `git log --oneline @{u}..HEAD | wc -l`
   - PR: `gh pr list --head <branch> --state merged --json number --limit 1`
   - Linear: `mcp__linear-jr__get_issue` — is it Done?
3. Present findings. Warn on unpushed commits, an unmerged PR, or an issue not Done. Use `AskUserQuestion`.
4. Inside the worktree → instruct the user to exit first. Otherwise:

```bash
git worktree remove ../job-radar-job-<NUM> --force
```

5. Report success.

> Removing a worktree deletes its `node_modules` and its symlinks, not the real
> `config/personal.yaml` in the primary workspace. Confirm the links are symlinks before
> `--force`, and stop if any is a real file — that would mean personal data lives only there.

---

## Error handling

| Scenario | Action |
|---|---|
| Directory not found | Show the error, list available worktrees |
| `git worktree` fails | Show the error, suggest manual cleanup |
| `npm install` fails in a new worktree | Report it — the worktree exists but is unusable until fixed |
| Linear MCP fails on inspect | Warn, show git-only data |
| Inside the worktree being removed | Instruct the user to exit first |
| None active | "No active worktrees" plus create instructions |
