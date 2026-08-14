Update dependencies with `npm-check-updates`, gated on the real test suite.

## Input

Argument: `$ARGUMENTS` (optional) — comma-separated package patterns to exclude in addition
to the defaults. Example: `/update-packages playwright,zod`.

## Scope

Single repo. One `package.json`.

| Package manager | Gate |
|---|---|
| npm (`package-lock.json`) or pnpm (`pnpm-lock.yaml`) — both lockfiles are present; use whichever the working tree already tracks changes for | `npm test && npm run typecheck` |

There is no lint step and no build step. The gate is the test suite plus `tsc --noEmit`,
and for anything touching the runtime, an actual pipeline run.

## Default exclusions

None are permanently excluded. Every dependency here is small enough to upgrade
deliberately. What follows is the risk each major bump carries **in this repo specifically** —
verify each against the package's own changelog before applying, rather than trusting this table.

| Package | Why a major bump is risky here |
|---|---|
| `zod` | `AnalysisSchema` (`src/model/job.ts`) and the config validator (`src/config/schema.ts`) are both zod. A major changes the structured-output guarantee and the cross-field coherence checks at once — the two mechanisms `CLAUDE.md` calls load-bearing. Upgrade alone, never batched. |
| `better-sqlite3` | Native binding compiled against the local Node ABI. A major usually needs a rebuild, and under pnpm needs `allowBuilds` (already set in `pnpm-workspace.yaml`). A broken install fails at startup with `Could not locate the bindings file`, not at typecheck. |
| `@anthropic-ai/sdk` | Pre-1.0 — every minor can break. It carries the `cache_control: ephemeral` prompt-caching call in `src/analysis/analyzer.ts` and `src/analysis/prepare.ts`. A silently-dropped cache parameter shows up as a cost regression, not a test failure. |
| `commander` | Owns the entire CLI surface in `src/cli.ts`. Option-parsing changes surface as commands that accept flags but ignore them. |
| `playwright` | `autofill` drives a real browser. A version bump needs matching browser binaries (`npx playwright install`), and selector-engine changes affect `src/apply/`. |
| `typescript` | `npm run typecheck` is half the gate. A major that changes resolution rules can turn the gate red across the whole tree. |
| `vitest` | The other half of the gate. Config-format changes in a major break `vitest.config.ts`. |
| `@types/node` | Must stay compatible with `engines.node >= 20`. |

## Step 1: Stash dirty state

```bash
git status --short
```

Uncommitted changes → `git stash push -u -m "WIP: pre-package-update stash"` and remember to pop.

## Step 2: Pull latest

```bash
git fetch origin main && git pull --ff-only origin main
```

## Step 3: Build the exclusion pattern

Base: no exclusions. If `$ARGUMENTS` is provided, parse the comma-separated names into:

```
--reject '/<user_args_joined_by_pipe>/'
```

## Step 4: Preview

```bash
npx npm-check-updates
```

Show the results as a table. **Separate majors from minors and patches** — they get different
treatment in Step 6. No updates available → say so and stop.

## Step 5: Confirm

Show the preview and ask before applying. Flag every major bump with the risk note from the
table above, and state plainly which of them you have and have not verified against a changelog.

Recommend the split:

- **Minors and patches** — apply together, one commit
- **Majors** — one at a time, each with its own gate run and its own commit

Batching majors makes a red suite ambiguous about which upgrade caused it.

## Step 6: Apply

```bash
npx npm-check-updates -u --reject '<pattern>'
npm install
```

For a major, target it alone:

```bash
npx npm-check-updates -u --filter '<package>'
npm install
```

## Step 7: Gates

```bash
npm test
```

```bash
npm run typecheck
```

Both must pass. On failure:

1. Show the error
2. Fix if it is a known migration pattern from Step 5
3. Otherwise ask whether to revert that package or continue

### Step 7b: Runtime check

`tsc` and vitest do not catch everything that a dependency upgrade breaks here. Run:

```bash
npm run cli -- sources
```

That exercises `better-sqlite3` (database open), `commander` (argument parsing), `yaml`
(config load), `zod` (config validation), and the HTTP path in one command. If it succeeds,
the runtime surface is intact.

If `playwright` moved:

```bash
npx playwright install
npm run cli -- autofill <job-id>   # confirm it still stops at submit
```

If `@anthropic-ai/sdk` moved, run one small `analyze` and confirm the response still reports
cache reads — a dropped `cache_control` parameter is invisible to the type checker.

## Step 8: Commit

Stage only `package.json` and the lockfile, plus any migration fixes.

```
chore(deps): update dependencies

<key version bumps, one per line>

Gates: npm test (316 passed), npm run typecheck (clean), npm run cli -- sources (0 errors)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

Dependency updates may go straight to `main`.

## Step 9: Pop the stash

```bash
git stash pop
```

Conflicts → tell the user, leave the stash intact.

## Step 10: Summary

```
## Updated (7 packages)

| Package | Old | New | Type |
|---------|-----|-----|------|
| zod | 3.25.0 | 3.25.76 | patch |
| tsx | 4.20.0 | 4.21.2 | minor |

## Held back
| Package | Old | Available | Reason |
|---------|-----|-----------|--------|
| zod | 3.25.76 | 4.1.0 | Major — touches AnalysisSchema and config validation. Upgrade alone.

## Gates
npm test          316 passed
npm run typecheck clean
cli -- sources    105 boards, 0 errors
```

## Examples

```
/update-packages                 # all, with the majors split out for confirmation
/update-packages playwright      # also exclude playwright
/update-packages zod,vitest      # exclude both
```
