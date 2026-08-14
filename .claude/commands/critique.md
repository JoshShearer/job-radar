# /critique — Adversarial Code Review

<!-- ultrathink: enable extended thinking for deeper adversarial analysis -->

Adversarially review the current changes. Runs standalone, and `/ship` invokes it as the
Critic Gate.

> Self-contained by design. LoopString runs this through a separate `critic` agent; job-radar
> has no agents, so the protocol is inlined below. Follow it as written — the value is in the
> discipline, not the delegation.

## Usage

- `/critique` — review uncommitted and staged changes (auto-detect depth)
- `/critique workflow` — review all `.claude/` files (always L2)
- `/critique architecture` — review structure and architectural decisions (always L2)
- `/critique "<question>"` — adversarial evaluation of one specific decision (always L2)

## Your stance

You are not approving. You are finding what is wrong, what could break, and what was
overlooked. You succeed when you find real issues. You fail when you rubber-stamp.

**Evidence requirement.** Every criticism cites one of:

- A specific code path that breaks (file + line)
- A concrete reproduction scenario
- A failing or missing test case
- A measurable risk (unhandled error, race, unbounded query, uncached re-analysis)
- A dependency with a known vulnerability
- A contradiction between the docs and the implementation

No evidence → downgrade to a **question** ("Have you verified that…?"). Never state it as a finding.

## Step 1: Identify changes

```bash
git diff --name-only HEAD
git diff --name-only --cached
```

Nothing? Check unpushed commits:

```bash
git log origin/main..HEAD --oneline
```

`workflow` → all `.claude/` files instead.
`architecture` → `CLAUDE.md`, `README.md`, `TODO.md`, `src/cli.ts`, `src/db/schema.ts`,
`src/pipeline/normalize.ts`, `src/config/schema.ts`, plus anything the user's concern names.

## Step 2: Auto-pass check

Skip only when **every** changed file is:

- `*.md` (documentation only)
- `package-lock.json` / `pnpm-lock.yaml`
- Whitespace-only

Then report `Auto-pass: docs/config only, no code changes to review.` and stop.

**Exception:** `workflow` and `architecture` bypass auto-pass.

## Step 3: Risk assessment

Score the change:

| Factor | Points | Condition |
|---|---|---|
| Resume provenance touched | +2 | `src/resume/provenance.ts`, `render.ts`, or `tailor.ts` changed |
| Apply refusals touched | +2 | `src/apply/` changed — refusals and the never-submit guarantee live here |
| Cost controls touched | +2 | `src/analysis/` changed in a way affecting cache keys, prefilters, prompt caching, or the description budget |
| Determinism boundary crossed | +2 | A model call appears in `src/pipeline/`, `src/lib/`, or `src/db/` |
| Schema change | +1 | `src/db/schema.ts` or `src/analysis/schema.ts` changed |
| No test changes | +1 | No `tests/*` modified alongside code |
| New external dependency | +1 | `package.json` dependencies added |
| Workflow changes | +1 | `.claude/` modified |
| Config schema changes | +1 | `src/config/schema.ts` or `config/*.yaml` structure changed |
| Deletes more than it adds | +1 | Net negative diff |
| Files changed > 10 | +1 | |

**Depth:**

- 0–1 → **L1** (Quick Challenge, ~500 tokens)
- 2–3 → **L2** (Full Protocol, ~2000 tokens)
- 4+ → **L2+Double** (two independent runs, lower score wins)

Report the score and its contributing factors before reviewing.

## Step 4: Review

### L1 — Quick Challenge

Three targeted questions:

1. **Most likely failure mode** — what breaks first on a real run?
2. **The untested path** — which code path has no coverage?
3. **The implicit assumption** — what does this assume without validating?

Verdict: PASS / CONCERNS / BLOCK with brief reasoning.

### L2 — Full Protocol

Five phases, sequential, no skipping.

1. **Claim extraction** — list every explicit and implicit claim the change makes. Read the
   changed files. Identify intent, scope, blast radius.

2. **Adversarial verification** — for each claim, seek counter-evidence. **At least half the
   investigation must seek disconfirmation.** Trace real code paths; do not trust comments.
   Check null, empty, concurrent, large input, Unicode, timezone. Identify the weakest or
   missing test for each significant change.

3. **Belief gap analysis** — what the author *wishes* were true versus what the code *does*.
   Check layer separation, pattern consistency with the surrounding code, and coupling that
   will hurt later.

4. **Pre-mortem** — "two weeks after shipping this caused an incident. What happened?"
   Three failure scenarios, each tied to a specific `file:line`.

5. **Verdict** — score 0–100:
   - **PASS** (80+) — ship it, minor suggestions only
   - **CONCERNS** (50–79) — specific issues that should be addressed, listed
   - **BLOCK** (<50) — do not ship

### L2+Double

Conduct two independent L2 reviews. The second must not reference the first. Compare:

- Scores diverge by >10 → the lower wins
- Both PASS → PASS
- Either BLOCK → BLOCK
- Otherwise → CONCERNS

## What to attack in this codebase

Generic review misses the failure modes that actually matter here. Work through these:

**Truthfulness (`src/resume/`, `src/analysis/`)**
- Can any path emit resume prose that did not come from `config/resume.yaml`? Model output
  reaching a rendered document directly is a BLOCK, not a concern.
- Does `enforceProvenance` still *repair* rather than trust? Unknown or `verified: false`
  citations dropped, and a rewrite introducing a technology or a number reverted to master
  wording?
- Has a rewrite check been loosened to make a reverted rewrite pass? That is the exact
  failure `CLAUDE.md` warns about.
- Does `resume match` still return three states? Collapsing `partial` into pass/fail removes
  the mechanism that prevents over-claiming.

**Refusals (`src/apply/`)**
- Does anything now click submit, tick a checkbox, answer a demographic question, or accept
  an attestation? Any of these is a BLOCK.
- Does an unset `personal.yaml` value fall back to a default anywhere? An unset value is
  unknown. A default answer on a job application is a false statement.
- Does `chooseOption` still reserve 1.0 for exact string equality? A loosened threshold turns
  a refusal into a guess.
- Any stealth, fingerprint masking, automation-flag hiding, or CAPTCHA handling added?

**Determinism (`src/pipeline/`, `src/lib/`)**
- Is a model being used for string comparison, parsing, arithmetic, or classification?
  Those must be reproducible, cheap over the whole index, and auditable.
- Do adapters in `src/sources/` still do zero classification?

**Cost (`src/analysis/`)**
- Are all four mechanisms intact — deterministic prefilters, the content-addressed cache,
  prompt caching on the stable prefix, and the truncated description budget?
- Can an unchanged job be re-analyzed? Does `repo.upsert` still invalidate cached analysis
  and score when a description changes?

**Politeness (`src/lib/http.ts`, `src/sources/`)**
- Is `PoliteFetcher` rate limiting still enforced and non-zero?
- Any endpoint added that is not public and documented?

**Attribution (`src/report/`)**
- Does `src/report/daily.ts` still emit the Remote OK followed link and name them as source?

**Resilience (`src/sources/`)**
- Can one failing source abort a run? There is a test for this — is it still meaningful, or
  did the change route around it?

**Structured output**
- Does all model output reaching the database still pass a JSON Schema *and* Zod
  (`AnalysisSchema`)? Is malformed output rejected rather than stored?

## Step 5: Record the verdict

Write to `.claude/last-critique.md`, overwriting:

```markdown
## Last Critic Verdict
- **Date:** [ISO timestamp]
- **Commit:** [HEAD hash at review time]
- **Depth:** L1 | L2 | L2+Double
- **Score:** [0-100]
- **Verdict:** PASS | CONCERNS | BLOCK
- **Risk Score:** [0-N]
- **Files Reviewed:** [count]

### Summary
[One line]
```

`/ship` reads this file and reuses the verdict when the commit hash matches HEAD.

## Step 6: Report

Show the full verdict. For CONCERNS or BLOCK, list actionable items with `file:line`.

## Rules

1. **Be specific.** "This could have bugs" is useless. A finding has the shape
   "`<file>:<line>` does X, so input Y produces wrong result Z" — cite the line you actually
   read. `enforceProvenance` lives in `src/resume/tailor.ts`, the vocabulary and rewrite
   checks it calls live in `src/resume/provenance.ts`; name whichever one you traced.
2. **Construct failure scenarios, not hypotheticals.** Trace the call chain.
3. **Don't nitpick style.** There is no linter here, but style is still not your job.
4. **Score honestly.** A 95 means you traced the paths and found almost nothing. If you
   didn't trace them, you haven't earned it.
5. **Report, don't fix.** `/critique` is read-only. Fixes happen after the verdict.
