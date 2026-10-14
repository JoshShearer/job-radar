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
| `zod` | Every model output schema (`src/domain/evaluation/assessment.ts`, `src/domain/materials/plan.ts`), the JSON Schema generated from them (`z.toJSONSchema` in `src/domain/llm/structured.ts`), and the strict config validator (`src/domain/config/schema.ts`) are all zod. A major changes the structured-output guarantee and the coherence checks at once. Upgrade alone, never batched. |
| `better-sqlite3` | Native binding. It ships prebuilds and pnpm deliberately does not build it (`allowBuilds` false in `pnpm-workspace.yaml`, pinned by `tests/toolchain.test.ts`): after a bump, confirm the new version still ships a prebuild for this platform and Node ABI. A missing binding fails at startup with `Could not locate the bindings file`, not at typecheck. |
| `@anthropic-ai/sdk` | Pre-1.0 — every minor can break. Only `src/adapters/anthropic/client.ts` uses it, including the `cache_control: ephemeral` prompt-caching block and structured output. A silently-dropped cache parameter shows up as a cost regression, not a test failure. |
| `commander` | Owns the entire CLI surface in `src/ui/cli.ts`. Option-parsing changes surface as commands that accept flags but ignore them. |
| `playwright` | `jr fill` and PDF rendering drive a real browser. A version bump needs matching browser binaries (`npx playwright install chromium`), and selector-engine changes affect `src/adapters/browser/`. |
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

`tsc` and vitest do not catch everything that a dependency upgrade breaks here. But the
runtime check has two tiers, and picking the wrong one is itself a violation.

**Per package — offline smoke:**

```bash
npm run cli -- stats
```

That exercises `better-sqlite3` (opens the real database), `commander` (argument parsing),
`yaml` (config load), and `zod` (config validation) in one command, and touches no network.
Run this after every single package.

**Once at the end of the session — the network sweep:**

```bash
npm run cli -- sources
```

> **Do not run the sweep after every package.** It requests ~217 third-party boards. A
> ten-package session would hit every one of those companies ten times in a few minutes,
> purely to check a lockfile. The transport's rate limiting is load-bearing precisely
> because this project does not get to treat other people's endpoints as free. Run the
> sweep once, after the last package, to confirm the HTTP path end to end.

**When a package's specific failure mode is invisible to both tiers, test it directly.**
A green suite proves nothing about a flag that parses and is then ignored:

| Package | Direct check |
|---|---|
| `commander` | `cli -- top --limit 2` shows 2 rows, `-l 5` shows 5, bare `top` falls back to the declared default. Option parsing breaking silently is the whole risk. |
| `zod` | Parse a config with an optional section **omitted** and assert the defaults that come back. zod 4 stopped parsing `.default()` values, so a partial default object drops fields while still typechecking. Check `operations.http.delay_ms` specifically — that is the rate limit. Also diff `toStructuredOutputSchema` output for the dossier schema before and after. |
| `better-sqlite3` | Open the real database, not just `:memory:`. A native ABI mismatch surfaces on load, not at typecheck. |
| `@anthropic-ai/sdk` | A negative type test: assign a bogus `cache_control` mode and confirm tsc rejects it. That proves the field is still strictly typed, so a rename would have failed the gate. |

If `playwright` moved:

```bash
npx playwright install
npm test                                  # includes the real-Chromium refusal harness
npm run cli -- fill <id> --headless       # confirm it still stops at submit
```

If `@anthropic-ai/sdk` moved, run one small `jr assess --limit 2` and confirm the second call
reports cache reads in `jr spend` / the ledger — a dropped `cache_control` parameter is
invisible to the type checker.

## Step 8: Commit

Stage only `package.json` and the lockfile, plus any migration fixes.

```
chore(deps): update dependencies

<key version bumps, one per line>

Gates: npm test (316 passed), npm run typecheck (clean), cli -- stats (ok)

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
| zod | 3.25.76 | 4.1.0 | Major — touches every model output schema and config validation. Upgrade alone.

## Gates
npm test          316 passed        (after every package)
npm run typecheck clean             (after every package)
cli -- stats      ok                (offline smoke, after every package)
cli -- sources    104 live, 1 dead  (network sweep, once at the end)
```

The final commit of a session carries the sweep result; the per-package commits carry the
offline smoke. If the sweep reports a dead board, that is a `config/sources.yaml` issue, not
a dependency one — file it with `/create-issue` rather than fixing it inside a deps commit.

## Examples

```
/update-packages                 # all, with the majors split out for confirmation
/update-packages playwright      # also exclude playwright
/update-packages zod,vitest      # exclude both
```
