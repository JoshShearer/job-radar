# /critique — Adversarial Code Review

<!-- ultrathink: enable extended thinking for deeper adversarial analysis -->

Adversarially review the current changes. Runs standalone, and `/ship` invokes it as the
Critic Gate.

> Self-contained by design. LoopString runs this through a separate `critic` agent; job-radar
> has no agents, so the protocol is inlined below. Follow it as written — the value is in the
> discipline, not the delegation.

## Usage

- `/critique` — review uncommitted and staged changes (auto-detect depth)
- `/critique plan` — review an implementation plan before approving it (always L2, Plan Review)
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

## Plan Review Path (when `/critique plan`)

**If `plan` was specified**, skip Steps 1–3 and use this path instead. You are reviewing a
*proposed approach*, not code that exists — the risk table and the auto-pass check are both
meaningless here.

> **This repo has no `critic` agent, so the protocol is inlined**, matching how the rest of this
> command works. But **do not review the plan in this session** when the plan is one you just
> wrote: spawn a **fresh `general-purpose` subagent** and give it the protocol below. A context
> that drafted the plan cannot adversarially review it — it already believes the plan. Freshness
> is the mechanism, not the agent type.

### P1: Locate the plan

1. **The plan file named in the plan-mode system message**, if this session is in plan mode.
   That path is authoritative — use it verbatim. *(Called from `/validated-plan`? It passes the
   path in; skip this step entirely.)*
2. **A path given in the invocation** — `/critique plan <path>`.
3. **A candidate in `~/.claude/plans/`**, if it exists — **confirm with the user first**. That
   store is shared across sessions and holds more than live plans: `*-ultraplan.md` are plans the
   user **rejected**, `*-agent-*.md` belong to subagents, `*.workshop.md` are not plans, and a
   concurrent session's file will look freshest of all. Exclude those, name the file you intend
   to review, and wait. The directory is relocatable via `plansDirectory`, so its absence is not
   proof there are no plans.
4. **`.claude/plan.md`** — legacy; frequently stale. Confirm first.

**Never review a plan whose location you inferred and did not confirm.** A score against the
wrong file looks exactly like a real verdict and will be trusted as one.

### P2: Assemble the requirements baseline

**Requirements Coverage is 20% of the score and cannot be judged against the plan alone** — a
plan is trivially complete with respect to itself. Gather: the Linear issue if a `JOB-\d+` key is
named (see `/create-issue` for the tooling), acceptance criteria from the conversation, or the
user's original request.

No baseline? Rate that dimension `unrated` and exclude its weight. Do **not** score it 10 — that
inflates every plan by two points and makes "no criteria were handy" the easier path to a pass.

### P3: Review against the plan rubric

Rate each dimension **1–10**, multiply by weight, sum, and multiply by 10 for a score **out of
100**.

| Dimension | Weight | What to evaluate |
|---|---|---|
| **Soundness** | 25% | Is the logic correct? Will the approach produce the desired outcome? Are assumptions validated rather than asserted? |
| **Requirements Coverage** | 20% | Does the plan address every acceptance criterion? Anything missing or partial? |
| **Codebase Alignment** | 20% | Does it match existing patterns, utilities, and the invariants in `CLAUDE.md`? |
| **Gaps & Risks** | 20% | What is missing? Are mitigations concrete? Is there a rollback? |
| **Scope Feasibility** | 15% | Will unexpected changes be required? Are dependencies verified? Is rework likely? |

| Rating | Meaning |
|---|---|
| **9–10** | No meaningful gaps; sound, complete, aligned |
| **7–8** | Minor gaps or unverified assumptions; directionally correct |
| **5–6** | Notable gaps that could cause rework |
| **3–4** | Significant issues; will need major revision |
| **1–2** | Fundamentally flawed, or violates a documented constraint |

**Rounding is round-half-up and load-bearing.** `Score = round(TOTAL × 10)`. 8/8/8/7/9 gives 7.95
→ **79.5 → 80, which PASSES**. Do not truncate, and do not nudge a dimension to land on the side
of the line you prefer. With a dimension `unrated`, renormalize over the remaining weights, keep
full precision, and round **once** at the end; say `(no requirements baseline — score not
comparable to a baselined run)`, because the four remaining dimensions all judge the plan against
itself or the codebase, both of which the planner controls. More than one unrated → return
CONCERNS with an explanation, not a number that looks authoritative.

**Verdict:** PASS (80+) / CONCERNS (50–79) / BLOCK (<50). **The score is advisory — nothing gates on it.** `/validated-plan` runs one pass and acts on the findings. 80 requires a straight 8 on every dimension at once, while an honest HIGH finding forces a 5-6 and caps the total at 75, so a gate on the number would be asking you for a clean bill of health. Report what you found.

**The highest-value check is verifying the plan's claims against the actual repository.** A plan
is a set of assertions about code — "this helper exists", "this is a three-file change". **Open
the files.** A confident `file:line` that does not exist is the most common plan defect and is
invisible until implementation.

**Evidence, adapted for plans.** Code does not exist yet, so cite: the requirements baseline
(coverage gaps), a `CLAUDE.md` invariant (alignment violations), a **real** `file:line` you opened
(wrong assumptions), or a named dependency/migration/config the plan omits (scope gaps). Anything
you cannot ground this way is a **question**, not a finding, and must not move the score.

Number findings `F1`, `F2`, … with severity `HIGH` (will break or miss a requirement), `MEDIUM`
(likely rework), `LOW` (worth fixing, not blocking).

**If you are handed a plan that was revised after an earlier review**, score it on its own merits — do not ask for or guess the earlier score. One check is worth making: if a risk, caveat or edge case present in the earlier version is simply *gone*, say so and name it. Narrowing scope is a legitimate fix; deleting the description of a risk while the risk remains is not, and it is the cheapest way to make a plan look better than it is.

**Do not** nitpick the plan's wording, block on implementation details not yet decided, or demand
certainty about things only implementation can settle.

### P4: Record and report

**In plan mode** (including a `/validated-plan` verification pass): write **nothing**. Writes outside the
plan file are blocked; the pass is recorded inside the plan by the caller. A blocked write is not
a failure of the review — do not retry it or route around it.

**Not in plan mode:** write the verdict to `.claude/last-plan-critique.md`.

**Never write `.claude/last-critique.md`.** That is the code-review verdict `/ship` reuses in
place of running its own gate when the recorded commit matches HEAD. Plan review scores on the
same 0–100 PASS/CONCERNS/BLOCK scale, so a plan verdict there would ship unreviewed code on the
strength of a review that never read any code. Do not record a `Commit:` either — a plan is not a
commit, and a hash is exactly what makes the file look reusable.

Emit `**Mode:** Plan Review`, `**Score:**` and `**Verdict:**` verbatim on their own lines;
`/validated-plan` parses them.

---

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
`architecture` → `CLAUDE.md`, `README.md`, `CONTEXT.md`, `TODO.md`, `docs/adr/`, `src/ui/compose.ts`,
`src/adapters/sqlite/schema.ts`, `src/domain/catalog/normalize.ts`, `src/domain/config/schema.ts`,
`tests/architecture.test.ts`, plus anything the user's concern names.

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
| Verification touched | +2 | `src/domain/materials/` or `src/domain/candidate/requirements.ts` changed |
| Fill refusals touched | +2 | `src/domain/browser/`, `src/adapters/browser/` or `src/app/fill.ts` changed: refusals and the never-submit guarantee live here |
| Cost controls touched | +2 | `src/app/gateway.ts`, `src/domain/budget/`, `src/domain/llm/`, `src/app/assess*.ts` or `selection.ts` changed |
| Determinism boundary crossed | +2 | A model call anywhere but through `src/app/gateway.ts` |
| Schema change | +1 | `src/adapters/sqlite/schema.ts` or an assessment/plan Zod schema changed |
| No test changes | +1 | No `tests/*` modified alongside code |
| New external dependency | +1 | `package.json` dependencies added |
| Workflow changes | +1 | `.claude/` modified |
| Config schema changes | +1 | `src/domain/config/schema.ts` or `config.example/` structure changed |
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

**Truthfulness (`src/domain/materials/`, `src/domain/candidate/`, `src/domain/llm/prompts.ts`)**
- Can any path put model text into a resume, cover letter or form answer without
  `verifySegment`? Model output reaching a rendered document unverified is a BLOCK.
- Does the verifier still *repair* rather than trust? Unknown, `verified: false` or wrong-owner
  citations dropped; a failing rewrite reverted to the candidate's wording; a failing pack
  sentence removed; a form answer with any failure unused?
- Has a rule been loosened to make a refused sentence pass? A false-refusal fix needs a test
  pinning the real overreach on the same input as still refused, and a `MATERIAL_RULES_VERSION`
  bump. Can the target context (company, title, department) now license a technology,
  qualifier or number?
- Does requirement matching still return three states? Collapsing `partial` removes the
  mechanism that prevents over-claiming.
- Does any prompt or config prose describe the candidate? Only the evidence ledger may.

**Refusals (`src/domain/browser/`, `src/adapters/browser/`, `src/app/fill.ts`)**
- Does anything now click submit, tick a checkbox, answer a demographic question, or accept
  an attestation? Any of these is a BLOCK.
- Does an unset `personal.yaml` value fall back to a default, or get filled from a drafted pack
  answer? An unset value is unknown. A default answer on a job application is a false statement.
- Does `chooseOption` still reserve 1.0 for exact string equality, and are radios still judged
  against their whole group? A loosened threshold turns a refusal into a guess.
- Any `page.evaluate` body with a named function (`__name` under tsx)?
- Any stealth, fingerprint masking, automation-flag hiding, or CAPTCHA handling added?

**Determinism (`src/domain/`)**
- Is a model being used for string comparison, parsing, arithmetic, routing or classification?
  Those must be reproducible, cheap over the whole index, and auditable.
- Does domain or app code read the wall clock instead of `ctx.clock`?
- Do adapters in `src/adapters/ats/` still do zero classification?

**Cost (`src/app/gateway.ts`, `src/domain/budget/`, `src/app/assess.ts`)**
- Is every paid call still through the gateway: addressed by the hash of exactly what is sent,
  reserved at worst case before the call, receipted on every outcome?
- Can an unchanged posting be re-bought? Look for volatile content entering a prompt.
- Is selection still by rank (ADR-0001), not an absolute fit gate?

**Facts (`src/adapters/sqlite/`, `src/app/`)**
- Any UPDATE or DELETE on a fact table? Corrections are `void_event`s.
- An edited applied migration instead of a new `MIGRATIONS` entry?

**Politeness (`src/adapters/http/`, `src/adapters/ats/`)**
- Is the 500 ms per-host floor still enforced in code and config, and `Retry-After` honored?
- Any endpoint added that is not public and documented?

**Attribution (`src/app/briefing.ts`, `src/ui/reports/`)**
- Does the briefing still emit the Remote OK followed link and name them as source?

**Resilience (`src/app/sweep.ts`)**
- Can one failing board abort a sweep? There is a test for this: is it still meaningful, or
  did the change route around it?

**Structured output**
- Does all model output still pass Zod (`validateStructured`) before storage, with the JSON
  Schema generated from the same Zod schema? Is malformed output rejected and receipted?

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
   read. Verification lives in `src/domain/materials/verify.ts`, composition and reverting in
   `src/domain/materials/compose.ts`; name whichever one you traced.
2. **Construct failure scenarios, not hypotheticals.** Trace the call chain.
3. **Don't nitpick style.** There is no linter here, but style is still not your job.
4. **Score honestly.** A 95 means you traced the paths and found almost nothing. If you
   didn't trace them, you haven't earned it.
5. **Report, don't fix.** `/critique` is read-only. Fixes happen after the verdict.
