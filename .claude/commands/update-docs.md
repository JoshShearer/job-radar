Update documentation after merging a PR — read implementation notes, bring `TODO.md` and
`README.md` in line with what actually shipped.

Conventions: `.claude/linear.md`.

## Purpose

Runs **after merge** to:

1. Read implementation notes from merged PR(s)
2. Tick off completed roadmap items in `TODO.md`
3. Correct any numbers or claims in `README.md` that the change invalidated
4. Keep documentation honest about what exists

## When to run

- After merging a PR
- After `/finish`
- At session start when `/orient` reports undocumented merges

## Input

Argument: `$ARGUMENTS` (optional) — one or more `JOB-XX` identifiers to limit scope.
Omitted → all undocumented merged PRs from the last 7 days.

## Step 1: Identify what needs documenting

**1a. Merged PRs**

```bash
gh pr list --state merged --limit 20 --json number,title,headRefName,mergedAt,body
```

**1b. Existing doc commits**

```bash
git log --oneline --since="7 days ago" --grep="docs:"
```

**1c. Cross-reference**

For each merged PR:

1. Extract the identifier — PR title first (`JOB-(\d+)` or `job-(\d+)`), then the branch name (`feature/job-(\d+)-*`)
2. Skip when: the title starts with `docs:`, merged more than 7 days ago, or no `JOB-XX` found
3. Match against doc commits with a **word-boundary** check on `JOB-{number}` (followed by a non-digit), so `JOB-2` does not match `JOB-20`
4. Classify documented / undocumented

**1d. Scope filter** — if `JOB-XX` arguments were given, keep only those.

**1e. Report**

```
Scanning merged PRs (last 7 days)...

Already documented:
  - PR #3 (JOB-9) — doc commit abc1234

Skipped:
  - PR #2 (no JOB-XX identifier)

Need documentation:
  - PR #4 (JOB-12) — Workable adapter
  - PR #5 (JOB-14) — company research cache

Updating docs for 2 PRs...
```

Nothing to do:

```
All merged PRs from the last 7 days are already documented.

Run `/orient` to see what's next.
```

**Fallback if `gh pr list` fails:**

```bash
git log main --oneline -20 --since="7 days ago"
```

## Step 2: Extract implementation context

Per undocumented PR:

1. `gh pr view <PR-number> --json body,title,files`
2. Parse Implementation Notes — files changed, approach, key decisions, testing
3. `mcp__linear-jr__get_issue` for additional context

## Step 3: Update the docs

This repo keeps three documents, each with a different job. Update the right one.

### `TODO.md` — the roadmap

Organized in phases with `- [ ]` / `- [x]` checkboxes. For each shipped item:

- Tick the box
- Append `— done.` plus a one-line note of what actually landed, matching the existing style
  (the `discover` entry is the model: `- [x] **job-radar discover <company>** — done. Probes
  all three ATS platforms, dedupes against existing config, prints a pasteable line.`)
- If the work revealed follow-on work, add it as a new unchecked item rather than leaving it
  implied

### `README.md` — what the system does today

Only touch it when the change altered something the README asserts. It contains **live
numbers from a real run** ("5,792 postings fetched from 104 boards → 579 duplicates
collapsed → 815 pass hard filters → 40 analyzed → 2 Priority A, 5 Priority B").

**Never update those numbers by estimating.** If a source was added or a filter changed, the
counts are stale. Either:

- Run `npm run radar` and use the real output, or
- Leave the numbers and note the run date they came from

Fabricating a plausible funnel number is the same category of error as fabricating resume
content. If you cannot run the pipeline, say the numbers are stale rather than adjusting them.

Also check the README for:

- New CLI subcommands that belong in the command table
- A new source that changes the board count
- Any capability described as future that now exists

### `CLAUDE.md` — the rules

Update only when the change altered a **mechanism** a rule depends on: a new determinism
boundary, a new refusal in `autofill`, a new cost-control mechanism, a new source-adapter
requirement.

Do **not** relax a rule to match code that violated it. If the code contradicts `CLAUDE.md`,
that is a bug in the code, and the fix is a new issue rather than a documentation edit.

## Step 4: Commit

```bash
git add TODO.md README.md CLAUDE.md
git commit -m "<message>"
git push origin main
```

Single PR:

```
docs: update roadmap after JOB-12 merge

- Marked Workable adapter complete in TODO.md
- Added `workable` to the sources table in README.md

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Multiple:

```
docs: update roadmap after JOB-12 and JOB-14 merges

- Marked Workable adapter (JOB-12) complete
- Marked company research cache (JOB-14) complete

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

**Every `JOB-XX` must appear in the commit subject line** — Step 1c's cross-reference scan
reads subjects.

Docs-only changes may go straight to `main`; that is the documented exception to the
branch-and-PR flow.

## Step 5: Summary

```
Documentation Updated

## Scan Results

| PR | Issue | Status | Details |
|----|-------|--------|---------|
| #3 | JOB-9  | Already documented | commit abc1234 |
| #4 | JOB-12 | Updated | Workable adapter |
| #5 | JOB-14 | Updated | company research cache |

## Changes Made

### TODO.md
- Ticked Workable public API under Phase 2 / More sources
- Ticked company research cache; added follow-on item for per-company cache eviction

### README.md
- Added `workable` to the sources table
- Funnel numbers left unchanged — last real run was 2026-08-01, now stale with the new source

## Committed
def5678 — docs: update roadmap after JOB-12 and JOB-14 merges
Pushed to origin/main
```

## Error handling

| Scenario | Action |
|---|---|
| No recent PRs | Check whether docs are already current |
| PR has no Implementation Notes | Use `git diff` and commit messages instead |
| Can't determine what changed | Ask the user |
| `gh pr list` fails | Use the git log fallback |
| README numbers are stale and the pipeline can't be run | Say so in the summary; never estimate |
