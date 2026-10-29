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

### Model calls outside the gateway
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null -- src/ | grep -E "^\+.*(@anthropic-ai/sdk|new Anthropic\(|messages\.create|modelClient\(\)\.)" | head -20
```

### Processes spawned outside the claude-cli adapter (a `claude -p` call is a paid call)
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null -- src/ ':!src/adapters/claude-cli/' | grep -E "^\+.*(child_process|spawn\(|execFile|execSync|claude -p|new ClaudeCliClient|JR_ALLOW_MODEL)" | head -20
```

### Model output heading for a rendered document
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null | grep -nE "^\+.*(renderResume|renderPack|writeFile|toMarkdown).*(completion|response|content\[0\]|message\.)" | head -10
```

### Verifier weakened
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/domain/materials/ | grep -E "^[-+].*(verifySegment|verifyHeading|HEADING_WORDS|OPENERS|INTENT_FRAME|EXPERIENCE_CLAIM|QUALIFIERS|SCOPE_PATTERNS|PAST_ACHIEVEMENT|reverted|verified|MATERIAL_RULES_VERSION|context)" | head -30
```

### Three-state match collapsed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/domain/candidate/requirements.ts | grep -E "^[-+].*(partial|QUALIFIERS|covered|gap)" | head -25
```

### Fill refusals touched
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/domain/browser/ src/adapters/browser/ src/app/fill.ts | grep -E "^[-+].*(NEVER_FILL|isNeverFill|isSubmitControl|chooseOption|radioGroups|matchPreparedAnswer|threshold|checkbox|check\(\)|click\(|submit|approved)" | head -30
```

### Unset personal value given a default
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/domain/browser/ src/adapters/browser/ src/domain/candidate/personal.ts | grep -E "^\+.*(\?\?|\|\||default).*(work_eligibility|sponsorship|personal\.|desired_salary)" | head -15
```

### Anti-bot evasion
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null | grep -iE "^\+.*(stealth|puppeteer-extra|playwright-extra|webdriver|navigator\.|fingerprint|user-?agent|captcha|solver|bypass)" | head -20
```

### Rate limiting weakened
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/adapters/http/ src/adapters/ats/ src/domain/config/schema.ts | grep -E "^[-+].*(delay|Delay|sleep|throttle|rate|concurren|500|Retry-After)" | head -20
```

### Cost controls touched
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/app/gateway.ts src/app/assess.ts src/app/assessment-requests.ts src/domain/budget/ src/domain/llm/ src/domain/evaluation/selection.ts src/adapters/anthropic/ | grep -E "^[-+].*(cache_control|ephemeral|addressOf|requestKey|reserve|worstCase|runCeiling|budget|max_output_tokens|description_char_budget|min_fit|deterministicNote)" | head -25
```

### Structured output bypassed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null | grep -E "^[-+].*(validateStructured|toStructuredOutputSchema|safeParse|JSON\.parse)" | head -20
```

### Remote OK attribution
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=3 2>/dev/null -- src/app/briefing.ts src/ui/reports/ src/adapters/ats/remoteok.ts | grep -iE "^[-+].*(remote ?ok|remoteok|attribution)" | head -10
```

### Auto-send surface
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff "$B" --unified=0 2>/dev/null | grep -iE "^\+.*(sendMail|nodemailer|smtp|sendMessage|\.send\(|mailto:.*\?.*send)" | head -15
```

### Personal data staged or committed
```
$!B=$(git merge-base origin/main HEAD 2>/dev/null || echo HEAD); git diff --name-only "$B" 2>/dev/null | grep -E "(config/candidate/(evidence|personal)\.yaml|config/personal\.yaml|config/resume\.yaml|^resumes/|^applications/|^artifacts/|^legacy-v1/|^data/|^reports/|\.env$)" | head -10; echo "---UNTRACKED---"; git status --porcelain --untracked-files=all 2>/dev/null | grep -E "(config/candidate/(evidence|personal)\.yaml|config/personal\.yaml|config/resume\.yaml|^\?\? (resumes|applications|artifacts|legacy-v1|data|reports)/|\.env$)" | head -10
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
| 1 | **Never invent experience** | Any prompt, config prose or code describing the candidate; generated text asserting an employer, metric, technology, or credential not in `config/candidate/evidence.yaml`. Any claim to have inspected a company's website, traffic, or codebase. | BLOCK |
| 2 | **Outbound text is verified** | Model text reaching a resume, cover letter, form answer or outreach draft without `verifySegment`/`verifyHeading` (`src/domain/materials/verify.ts`), or a headline/summary written rather than chosen from the candidate's variants. | BLOCK |
| 3 | **The verifier repairs, never trusts** | Unknown, `verified: false` or wrong-owner citations no longer dropped; a failing rewrite no longer reverted; a failing pack sentence used; a rule loosened so a refused sentence passes. Fixing a FALSE refusal is allowed only with a test that pins the real overreach on the same input as still refused, and a `MATERIAL_RULES_VERSION` bump. Target context (company, title, department) licensing anything but names is a violation. | BLOCK |
| 4 | **Requirement matching keeps three states** | `partial` collapsed into pass/fail, or a qualifier satisfied by the skill match rather than evidenced independently (`src/domain/candidate/requirements.ts`). Using a library is not contributing to it. | BLOCK |
| 5 | **Never auto-send** | Any code path that transmits an application, email, or message without a human action. | BLOCK |
| 6 | **`jr fill` fills and stops** | A submit click, a ticked checkbox, an answer to a demographic or attestation field, a radio checked without the group-wide tie refusal, or a lowered `chooseOption` threshold that guesses instead of refusing. `chooseOption` reserves 1.0 for exact string equality on purpose. Pack text used before `jr approve`. | BLOCK |
| 7 | **Unset means unknown** | An unset `personal.yaml` value given a default, or filled from a drafted pack answer. A saved override answering a demographic/attestation question it does not itself name. | BLOCK |
| 8 | **Public documented endpoints only** | Auth, CAPTCHA, rate-limit, robots, anti-bot, or paywall circumvention. Stealth plugins, automation-flag masking, fingerprint spoofing, CAPTCHA solving. | BLOCK |
| 9 | **Rate limiting is load-bearing** | The 500 ms per-host floor (`src/adapters/http/polite-transport.ts` and the config schema) removed or configurable lower; `Retry-After` ignored. | BLOCK |
| 10 | **Remote OK attribution** | The briefing (`src/app/briefing.ts`, `src/ui/reports/render.ts`) no longer emits the followed link naming Remote OK as source while the source is enabled. The permitted alternative is disabling the source. | BLOCK |
| 11 | **Determinism boundary** | A model call anywhere but through `src/app/gateway.ts`; a model used for dedupe, parsing, eligibility, scoring, calibration, ranking, selection, routing, verification or mail classification. | BLOCK |
| 12 | **Adapters stay dumb** | Classification logic in `src/adapters/ats/*.ts`. Judgement happens once in `src/domain/catalog/normalize.ts`. | WARNING |
| 13 | **One failing board never aborts a sweep** | An adapter error that escapes `sweep`. There is a test for this. | BLOCK |
| 14 | **Cost controls intact** | The request address no longer the hash of exact prompt/model/effort; volatile content (relative dates, calibrated scores, URLs) in a prompt; reservation after the call instead of before; a receipt missing for any outcome; spend reported from anything but the ledger; selection gated on an absolute fit score instead of rank (ADR-0001); prompt caching or the description budget removed. | BLOCK |
| 15 | **Structured output validated** | Model output stored without Zod validation (`validateStructured`), or a JSON Schema hand-written instead of generated (`toStructuredOutputSchema`). Malformed output stored rather than rejected and receipted. | BLOCK |
| 16 | **Config over code** | A tuning change that requires editing TypeScript. Strategy, preferences, policy, operations and sources are data under `config/`. | WARNING |
| 17 | **Config coherence checks kept** | Strictness (unknown key = error) or cross-file coherence removed (`coherenceProblems`, `src/domain/config/schema.ts`). A typo silently disabling a filter is worse than a crash. | BLOCK |
| 18 | **No personal data committed** | `config/candidate/evidence.yaml`, `config/candidate/personal.yaml`, v1's `config/resume.yaml`/`config/personal.yaml`, `resumes/*`, `applications/`, `artifacts/`, `legacy-v1/`, `data/`, `reports/`, or `.env` staged. | BLOCK |
| 19 | **Not committing to main** | Feature work committed directly to `main`. Docs-only changes are exempt. | WARNING |
| 20 | **pnpm build policy intact** | `pnpm-workspace.yaml` no longer sets `allowBuilds` **esbuild: true** and **better-sqlite3: false** (or `tests/toolchain.test.ts`, which pins it, weakened). Blocking esbuild breaks tsx and vitest; allowing better-sqlite3 makes pnpm run `node-gyp rebuild`, which fails the install on any machine without a global node-gyp even though the shipped prebuild is all it needs (JOB-69). | BLOCK |

### Step 1: Analyze the injected context

Each block above targets specific constraints. A grep hit is a candidate, not a verdict.

### Step 2: Read the flagged code

For every hit, read a window around it. Determine whether it is a real violation or a false
positive. Common false positives:

- `messages.create` inside `src/adapters/anthropic/client.ts`: the one adapter behind the
  gateway's `ModelClient` port
- `spawn(` / `child_process` inside `src/adapters/claude-cli/client.ts`, and `new ClaudeCliClient` /
  `JR_ALLOW_MODEL` in `src/ui/compose.ts`: the second `ModelClient` adapter and its fence (ADR-0004)
- A `submit` string in `src/domain/browser/fields.ts`: `isSubmitControl` exists to *detect and
  avoid* submit controls
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
  loosen it so a refused sentence passes. Reverting to the candidate's own wording is always
  available, so overreach can only produce worse material, never false material.

### Unknown
- **#14** — `jr assess` was not run against this diff, so the cache behavior is unverified.
  Run `npm run cli -- assess --dry-run`, then a small `assess`, and confirm unchanged
  postings came from cache.

### All Clear
No constraint violations detected in the current changes.
```

Any **BLOCK** row stops `/ship`. There is no override flag, and one should not be added.
