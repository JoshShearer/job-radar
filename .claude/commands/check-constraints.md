Validate that the current changes do not violate the non-negotiable rules in `CLAUDE.md`.

> Written for job-radar rather than ported. These constraints are the product thesis: the
> system's value is that it cannot lie on your behalf and cannot act without you. A
> regression here is not a code-quality issue, it is a correctness issue about statements
> made to employers.

## The diff range

Every block below diffs against **`$(git merge-base origin/main HEAD)`**, not `HEAD`.

This is load-bearing. `git diff HEAD` shows only *uncommitted* work, and `/ship` runs this
gate **after** committing — so with `HEAD` as the base every grep returns empty and the gate
reports PASS on everything it never looked at. That is the exact failure Step 3 below warns
about, and it was live in this command until it was caught by running `/ship` for real.

The merge-base range catches all three states at once: committed on the branch, staged, and
unstaged. Verify it yourself with `git diff $(git merge-base origin/main HEAD) --name-only`
— if that prints nothing on a branch with commits, something is wrong with the range, not
with the code.

## Dynamic Context

### Changed files
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); echo "range: $B..working-tree"; git diff --name-only "$B" 2>/dev/null | head -50; echo "---BRANCH COMMITS---"; git log origin/main..HEAD --oneline 2>/dev/null | head -20
```

### Model calls outside the analysis and resume boundaries
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null | grep -E "^\+.*(@anthropic-ai/sdk|new Anthropic\(|messages\.create)" | head -20
```

### Model output heading for a rendered document
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null | grep -nE "^\+.*(renderResume|writeFile|toMarkdown|toDocx).*(completion|response|content\[0\]|message\.)" | head -10
```

### Provenance enforcement weakened
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/resume/tailor.ts src/resume/provenance.ts | grep -E "^[-+].*(enforceProvenance|checkRewrite|checkSelection|buildVocabulary|reverted|verified)" | head -25
```

### Three-state match collapsed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/resume/requirements.ts | grep -E "^[-+].*(partial|QUALIFIERS|inEvidence|inRequirement)" | head -25
```

### Autofill refusals touched
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/apply/ | grep -E "^[-+].*(NEVER_FILL|isNeverFill|isSubmitControl|chooseOption|threshold|checkbox|check\(\)|click\(|submit)" | head -30
```

### Unset personal value given a default
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/apply/ src/config/personal.ts | grep -E "^\+.*(\?\?|\|\||default).*(work_eligibility|sponsorship|personal\.)" | head -15
```

### Anti-bot evasion
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null | grep -iE "^\+.*(stealth|puppeteer-extra|playwright-extra|webdriver|navigator\.|fingerprint|user-?agent|captcha|solver|bypass)" | head -20
```

### Rate limiting weakened
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/lib/http.ts src/sources/ | grep -E "^[-+].*(delay|Delay|sleep|throttle|rate|concurren)" | head -20
```

### Cost controls touched
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/analysis/ src/db/repo.ts | grep -E "^[-+].*(cache_control|ephemeral|analysis_threshold|cacheKey|hash|truncat|budget|max_tokens|upsert)" | head -25
```

### Structured output bypassed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null | grep -E "^[-+].*(AnalysisSchema|safeParse|JSON\.parse)" | head -20
```

### Remote OK attribution
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/report/ | grep -iE "^[-+].*(remote ?ok|remoteok)" | head -10
```

### Auto-send surface
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null | grep -iE "^\+.*(sendMail|nodemailer|smtp|sendMessage|\.send\(|mailto:.*\?.*send)" | head -15
```

### Personal data staged or committed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff --name-only "$B" 2>/dev/null | grep -E "(config/personal\.yaml|config/resume\.yaml|^resumes/|^applications/|^data/|^reports/|\.env$)" | head -10; echo "---UNTRACKED---"; git status --porcelain --untracked-files=all 2>/dev/null | grep -E "(config/personal\.yaml|config/resume\.yaml|^\?\? (resumes|applications|data|reports)/|\.env$)" | head -10
```

### Current branch
```
$!git branch --show-current
```

## Instructions

You are an automated constraint checker. Check every changed file against the
non-negotiables in `CLAUDE.md`.

### Constraints

| # | Constraint | What a violation looks like | Severity |
|---|---|---|---|
| 1 | **Never invent experience** | Any prompt, generated resume text, outreach draft, or analysis output asserting an employer, metric, technology, or credential not in `config/resume.yaml`. Any claim to have inspected a company's website, traffic, or codebase. | BLOCK |
| 2 | **Resume prose comes from master data** | A model's output string written into a rendered document. Tailoring returns bullet ids and replacement strings; `src/resume/render.ts` assembles from master. | BLOCK |
| 3 | **Provenance repairs, never trusts** | `enforceProvenance` (`src/resume/tailor.ts:217`) no longer drops unknown or `verified: false` citations, or no longer reverts a rewrite that introduces a technology or a number. Loosening a check so a reverted rewrite passes is itself the violation. | BLOCK |
| 4 | **`resume match` keeps three states** | `partial` collapsed into pass/fail, or a `QUALIFIERS` entry (`src/resume/requirements.ts:131`) satisfied by the skill match rather than evidenced independently. Using a library is not contributing to it. | BLOCK |
| 5 | **Never auto-send** | Any code path that transmits an application, email, or message without a human action. | BLOCK |
| 6 | **`autofill` fills and stops** | A submit click, a ticked checkbox, an answer to a demographic or attestation field, or a lowered `chooseOption` threshold that guesses instead of refusing. `chooseOption` reserves 1.0 for exact string equality on purpose. | BLOCK |
| 7 | **Unset means unknown** | An unset `personal.yaml` value given a default. `work_eligibility` is nullable specifically so it is never answered on the candidate's behalf. | BLOCK |
| 8 | **Public documented endpoints only** | Auth, CAPTCHA, rate-limit, robots, anti-bot, or paywall circumvention. Stealth plugins, automation-flag masking, fingerprint spoofing, CAPTCHA solving. | BLOCK |
| 9 | **Rate limiting is load-bearing** | `PoliteFetcher` delays removed or configurable to zero. | BLOCK |
| 10 | **Remote OK attribution** | `src/report/daily.ts` no longer emits the followed link naming Remote OK as source. The permitted alternative is disabling the source, not dropping the credit. | BLOCK |
| 11 | **Determinism boundary** | A model call in `src/pipeline/`, `src/lib/`, `src/db/`, `src/sources/`, or `src/report/`. Dedupe, salary/date parsing, location and seniority classification, schema validation, hard filters, and scoring arithmetic are deterministic. | BLOCK |
| 12 | **Adapters stay dumb** | Classification logic in `src/sources/*.ts`. All judgement happens once in `src/pipeline/normalize.ts`. | WARNING |
| 13 | **One failing source never aborts a run** | An adapter that does not catch its own errors or does not record them on `ctx.stats`. There is a test for this. | BLOCK |
| 14 | **Cost controls intact** | Any of the four weakened: deterministic prefilters gating eligibility on `filter_passed` with rank-ordered selection, the content-addressed cache, `cache_control: ephemeral` on the stable prefix, the truncated description budget. Or `repo.upsert` no longer invalidating cached analysis and score when a description changes. Note `analysis_threshold` was retired in JOB-32 — reintroducing an absolute fit gate as a spend control is itself the regression. | BLOCK |
| 15 | **Structured output validated** | Model output reaching the database without both a JSON Schema and Zod re-validation via `AnalysisSchema` (`src/model/job.ts:74`). Malformed output stored rather than rejected. | BLOCK |
| 16 | **Config over code** | A tuning change that requires editing TypeScript. Weights, filters, lanes, thresholds, and exclusions are data in `config/career-profile.yaml`. | WARNING |
| 17 | **Config coherence checks kept** | Cross-field validation removed: lane weights summing to 1, ordered compensation bands, signals referencing real lanes. A typo silently disabling a filter is worse than a crash. | BLOCK |
| 18 | **No personal data committed** | `config/personal.yaml`, `config/resume.yaml`, `resumes/*`, `applications/`, `data/`, `reports/`, or `.env` staged. | BLOCK |
| 19 | **Not committing to main** | Feature work committed directly to `main`. Docs-only changes are exempt. | WARNING |
| 20 | **pnpm build approvals intact** | `pnpm-workspace.yaml` no longer sets `allowBuilds: true` for **better-sqlite3** and **esbuild**. Without them `pnpm install` succeeds and every command then fails with `Could not locate the bindings file`. | BLOCK |

### Step 1: Analyze the injected context

Each block above targets specific constraints. A grep hit is a candidate, not a verdict.

### Step 2: Read the flagged code

For every hit, read a window around it. Determine whether it is a real violation or a false
positive. Common false positives:

- `messages.create` inside `src/analysis/` or `src/resume/` — those are the sanctioned model
  boundaries (`analyzer.ts`, `prepare.ts`, `tailor.ts`, `import.ts`)
- A `submit` string in `src/apply/fields.ts` — `isSubmitControl` exists to *detect and avoid*
  submit controls
- `Remote OK` appearing in a comment — check whether the emitted string survived
- The word `default` in an unrelated switch statement

### Step 3: Verify claims, don't assume them

If a constraint's status cannot be determined from the diff alone, read the current file.
Reporting PASS on something you did not check is the failure mode this command exists to
prevent. Mark it **UNKNOWN** rather than PASS.

### Step 4: Output

```markdown
## Constraint Check

Branch: <branch>   Files changed: <n>

| # | Constraint | Status |
|---|-----------|--------|
| 1 | Never invent experience | PASS / FAIL / N/A / UNKNOWN |
| … | … | … |

Only rows that are FAIL, UNKNOWN, or touched by this diff need listing. Collapse the
untouched ones to a single line: "Constraints 5, 8–10, 16–20 not touched by this diff."

### Violations
- **`<file>:<line you actually read>`** — <what the code now does, and the input that makes
  it produce a false statement>
  - Constraint: #N
  - Severity: BLOCK / WARNING
  - Fix: <remediation>

  For constraint #3 specifically, the remediation is always to restore the check, never to
  loosen it so a reverted rewrite passes. Reverting to master wording is always available,
  so overreach can only produce a worse resume, never a false one.

### Unknown
- **#14** — `analyze` was not run against this diff, so the cache behavior is unverified.
  Run `npm run cli -- analyze` and confirm unchanged jobs were skipped.

### All Clear
No constraint violations detected in the current changes.
```

Any **BLOCK** row stops `/ship`. There is no override flag, and one should not be added.
