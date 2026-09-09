---
description: Plan mode with an adversarial critic loop - iterates the plan until it scores 80+
argument-hint: "<what to plan> [--threshold=80] [--max-passes=3]"
---

# /validated-plan -- Plan, Critique, Revise, Repeat

Produce an implementation plan that has **already survived adversarial review** before you
are asked to approve it.

Ordinary plan mode ends the moment the plan reads well. This command does not end there: it
hands the finished draft to the **critic** agent, applies the findings, and re-critiques --
looping until the plan scores at or above the threshold. **The finalized, passing plan is
the deliverable.**

## Usage

- `/validated-plan <what to plan>` -- plan and validate to the default threshold (80)
- `/validated-plan <what> --threshold=90` -- demand a higher bar
- `/validated-plan <what> --max-passes=5` -- allow more revision rounds (default 3)
- `/validated-plan JOB-1234` -- a bare issue key: fetch the issue first, plan against it

Related: `/critique plan` reviews a plan **once**, without the loop. `/ship` runs the
equivalent gate against code. This command is the planning-time counterpart.

## Contract

| | |
|---|---|
| **Delivers** | One plan file plus its full revision history -- normally one that scored >= threshold |
| **When the gate is not met** | The plan is still delivered, carrying a `GATE NOT MET` banner with its score and unresolved findings (Step 4). Falling short is a disclosed outcome, not a hidden one |
| **Never delivers** | A plan that failed the gate, presented as if it passed |
| **Scale** | 0-100. PASS >= 80, CONCERNS 50-79, BLOCK < 50 |
| **Default budget** | 3 critic passes |
| **Writes during the loop** | The plan file only -- *provided plan mode was entered* (Step 1) |

---

## Step 0: Parse Arguments

From `$ARGUMENTS`, extract:

- **Task** -- everything that is not a flag. This is what gets planned.
- **`--threshold=N`** -- passing score. Default **80**. Clamp to 0-100.
- **`--max-passes=N`** -- maximum critic passes. Default **3**. Clamp to 1-6.

If the task names an issue in this repo's tracker, **fetch it** and use its summary,
description, and acceptance criteria as the requirements baseline. This repo tracks work in
**Linear** (`JOB-\d+`); `/create-issue` in this same directory shows the exact tooling, and is the
reference to follow rather than a tool name hardcoded here.

Fetching is not optional when a key is given. **Requirements Coverage is the only dimension of
the critic's rubric measured against something outside the plan** -- every other dimension
judges the plan against itself or the codebase. Skipping the fetch drops it, which makes the
rubric *easier*, not merely less informed. See Step 3a.

If no task was supplied at all, stop and ask what to plan. Do not enter plan mode with
nothing to plan.

## Step 1: Enter Plan Mode

Call **`EnterPlanMode`**. This is the harness's plan mode -- the same one shift+tab toggles.
(There is no `/plan` slash command in this repo; `EnterPlanMode` and shift+tab are the two
affordances.) The loop below runs *inside* that mode.

**The user can decline this.** If they do, you are not in plan mode: nothing restricts writes,
there is no plan file, and the write-confinement this command advertises does not hold. Do not
proceed as if it did. Say that plan mode was declined, and offer to either draft the plan to an
explicit path the user names and run the same critic loop against it, or stop. Never quietly
continue and later describe the result as a validated plan produced under plan mode.

The plan-mode system message names the **plan file** you are to write to. **That path is
authoritative -- use it verbatim** and record it; every later step reads and rewrites this
one file. Do not invent a path, and do not assume `.claude/plan.md`: it is a legacy location
that may or may not be what this session was given.

## Step 2: Research and Draft

Research the codebase properly before writing anything. A plan built on unverified claims
scores badly on **Codebase Alignment** and **Soundness**, and burns a pass discovering it.

Ground the draft:

- Read the files the plan proposes to change. Cite them as `path:line`.
- Check `CLAUDE.md` and any `.claude/rules/*.md` whose `paths:` frontmatter matches the
  files in scope. These encode hard-won invariants; a plan that violates one is a BLOCK.
- Confirm every helper, hook, or utility the plan says it will reuse actually exists.
- Prefer a `general-purpose` or `Explore` subagent for broad fan-out searches so the main
  context stays clean for the loop.

Write the draft to the plan file. Include, at minimum:

1. **Goal** -- what and why, in a sentence or two
2. **Requirements** -- the acceptance criteria this must satisfy
3. **Approach** -- the design, and what was rejected and why
4. **Files to change** -- each with `path:line` and what happens to it
5. **Verification** -- the exact commands or observations that prove it works
6. **Risks and rollback** -- what could go wrong, and how to undo it

## Step 3: The Critic Loop

Repeat for pass `N` = 1 to `max-passes`:

### 3a. Critique

Follow the **Plan Review Path** in [`.claude/commands/critique.md`](./critique.md). It owns
**P2 (assembling the requirements baseline)** and **P3 (the plan rubric, scoring, rounding and
evidence rules)**. Do not re-implement those here. Because this repo has no `critic` agent, that
path is written to be handed to a fresh `general-purpose` subagent verbatim.

Two of its steps are **overridden inside this loop**, because a loop is not a one-shot review:

| `critique.md` step | Inside `/validated-plan` |
|---|---|
| **P1** -- locate the plan | Already located in Step 1, from the plan-mode system message. Skip P1's search and its fallbacks entirely; they exist for a standalone `/critique plan` that must find a plan it did not write |
| **P4** -- record the verdict | Writes nothing during the loop (plan mode blocks it). Passes are recorded in the plan by 3c; the verdict file is written after `ExitPlanMode`, in Step 6 |

Everything else in that path applies unchanged.

Pass to the critic:

- The **full current plan file** contents
- The **requirements baseline** from Step 0 (the tracker issue, or the user's own words) --
  or an explicit statement that there is none
- The **unresolved findings** from previous passes -- so it can verify they were actually fixed
- **On pass 2 and later: the previous version of the plan**, so the critic can diff them

That last item is not optional. The cheapest way to raise a plan's score is to delete the
parts that attract findings -- a risk section, an awkward edge case, a caveat about scope. A
critic holding only the current plan cannot see that anything is gone, so it credits the
absence as cleanliness. Holding both versions, it can. Keep the previous plan text in
context across the loop; do not write a copy to disk, since plan mode permits writes only to
the plan file itself.

**Spawn a NEW reviewer every pass.** This repo has no `critic` agent -- `/critique` inlines its
protocol -- so each pass spawns a fresh **`general-purpose` subagent** and hands it the Plan
Review Path from `critique.md` verbatim. Never continue the previous pass's reviewer by messaging
it: a continued agent keeps its own transcript, including the score it just gave, which defeats
everything below.

**Never review the plan in this session.** You wrote it; you already believe it. Freshness is the
mechanism here, not the agent type -- a self-review inside the drafting context is the single
fastest way to turn this loop into theater.

**Withhold every previous score and verdict label.** Forward findings; never forward numbers.
A critic that knows the last pass scored 74 is anchored to beat 74, which converts the gate
into a formality.

Be honest about how far this reaches. The critic *will* see that earlier passes happened --
the revision records in the plan say `Critic pass 2` and carry `HIGH`/`MEDIUM` severities, and
the plan's own revision history is part of the deliverable, so it cannot be stripped without
destroying what this command produces. What is withheld is **the number and the
PASS/CONCERNS/BLOCK label**, which are what a critic would otherwise treat as a floor. Do not
claim, in the plan or to the user, that later passes were blind.

**A run with no requirements baseline scores on an easier rubric, and must say so.** With no
baseline the critic drops Requirements Coverage and renormalizes over the remaining four
dimensions -- all of which assess the plan against itself or the codebase, both of which the
planner controls. So a baseline-less 82 is not the same achievement as a baselined 82, and the
two are not comparable. If you reach the threshold without a baseline, say that in the delivery
summary and in the verdict record. Do not let "no acceptance criteria were handy" quietly
become the easier path to a passing score.

### 3b. Read the Score

Parse `**Score:**` from the critic's verdict block.

- **Score >= threshold** -- the gate is met. Go to Step 4. The comparison is on the integer
  the critic reports, which it rounds half-up from the weighted total; 79.5 is reported as 80
  and passes at the default threshold.
- **Score < threshold** -- continue to 3c.
- **No parsable score** -- treat as a failed pass, not a passing one. Re-spawn a fresh critic
  once with an explicit instruction to emit the verdict block. **The re-spawn does not consume
  a pass** -- the budget counts completed reviews, and a malformed verdict reviewed nothing.
  If it fails again, stop and report; never infer a score.

### 3c. Revise

Address the findings **in the plan file**:

- **Fix what is wrong.** A finding that the plan targets the wrong file, misses a
  requirement, or violates a documented invariant is a defect -- correct it.
- **Verify before you accept.** The critic reasons about a plan, not running code, and it
  can be wrong. Check its claim against the actual file. If it is mistaken, say so in the
  plan with the evidence that refutes it, and do not make the change.
- **Record disagreements, do not bury them.** A finding you consciously decline is an
  **accepted risk** and belongs in the plan under that name.

Then append a revision record to the plan file:

```markdown
> **Critic pass N (YYYY-MM-DD) -- addressed below:**
> - **F1 (HIGH)** -- [finding]. [What changed in the plan, and where.]
> - **F2 (MEDIUM)** -- [finding]. [What changed.]
> - **F3 (LOW)** -- [finding]. **Not applied:** [evidence that refutes it, or why accepted.]
```

Record the finding and the response. **Omit the score** -- it must not be visible to the
next pass.

**Number passes continuously for the life of the plan file.** If the user rejects at
`ExitPlanMode` and the loop resumes, the next record is pass N+1, not a second pass 1 -- two
blocks both labelled "Critic pass 1" make the history unreadable and hide how many attempts a
plan actually took. Agree the additional budget before resuming, and state the new total.

### 3d. No-Progress Guard

The guard fires when a pass changed **nothing in the plan body** -- where "body" means
everything except the `> **Critic pass N ...**` revision records, which 3c appends on every
pass and which therefore prove nothing on their own. Concretely: every finding was refuted or
logged as an accepted risk, and no Goal, Requirements, Approach, Files, Verification, or Risk
section was touched.

When it fires, the loop cannot improve further. Stop iterating and go to Step 4 with the
current score, reporting that it converged below threshold. Spending the remaining passes
re-litigates a plan that is not changing.

**Judge the body, not the file's mtime or byte count.** Appending a record of having refuted
three findings is not progress, and it is exactly what an unchanged plan looks like from the
outside.

## Step 4: Converged, or Out of Passes

### Threshold met

Report the passing score and the pass count. Proceed to Step 5.

### Threshold NOT met after max-passes (or the no-progress guard fired)

**Do not present the plan as validated, and do not ask whether to approve it anyway.**

Plan mode permits exactly one channel for plan approval -- `ExitPlanMode` -- and explicitly
forbids requesting it any other way, including with `AskUserQuestion`. So the shortfall is
disclosed *in the plan itself*, and the user then approves or rejects through the normal
gate. An "approve anyway?" question here would be both a protocol violation and the precise
moment this command is most tempted to launder a failure into a pass.

Write a banner as the **first thing in the plan file**, above the Goal:

```markdown
> ## ⚠ GATE NOT MET -- {score}/100, threshold {threshold}
>
> This plan did **not** reach the passing score after {N} critic pass(es).
> {"The score stalled: the last pass changed nothing in the plan body." if the no-progress guard fired}
>
> **Unresolved findings:**
> - **F{n} ({severity})** -- {finding, and why it was not resolved}
>
> Score by pass: {e.g. 48 -> 61 -> 67}. {"Improving but short." | "Stalled." | "Regressing."}
```

Then call `ExitPlanMode` (Step 5) with a summary that leads with the shortfall. The user sees
the banner, and the native approve/reject gate does the rest:

- **They approve** -- they accepted a disclosed shortfall, on the record, in the plan.
- **They reject** -- plan mode resumes with their feedback, and you continue the loop or
  redraft from Step 2 as they direct. This is the sanctioned way to ask for more passes;
  you do not need a question to offer it.

**Read the trend before you write the banner, and say what it means.** A score stalled in the
50s is evidence the *approach* is wrong, not that the prose needs another polish -- more
passes on the same design will not fix it, and saying so plainly is more useful than another
round. Recommend a redraft when that is what the numbers show.

## Step 5: Deliver

The plan file now contains the plan, its revision history, and -- if the gate was not met --
the shortfall banner. Call **`ExitPlanMode`**, which reads that file and presents it for
approval.

Precede it with a short summary. On success:

```
Validated plan ready.

Score:   86/100 (PASS) -- threshold 80
Passes:  3
Fixed:   2 HIGH, 3 MEDIUM
Accepted risks: 1 (see plan)
```

On a shortfall, lead with it -- never bury it under the word "ready":

```
Plan did NOT meet the gate.

Score:   67/100 (CONCERNS) -- threshold 80
Passes:  3 of 3 (48 -> 61 -> 67)
Unresolved: 1 HIGH, 2 MEDIUM (listed at the top of the plan)

Approve to proceed anyway, or reject to keep iterating.
```

## Step 6: Record the Verdict (after exiting plan mode)

Plan mode permits writes to the plan file only, so this happens **after** `ExitPlanMode`.

Write the final verdict to `.claude/last-plan-critique.md`:

```markdown
## Last Plan Verdict
- **Date:** [ISO timestamp]
- **Plan file:** [path]
- **Score:** [0-100]
- **Verdict:** PASS | CONCERNS | BLOCK
- **Passes:** [N]
- **Threshold:** [N]

### Key Decisions
[Decisions the plan locked in]

### Accepted Risks
[Findings deliberately not addressed, and why]

### Critical Action Items
[What implementation must not get wrong]
```

**Write to `.claude/last-plan-critique.md`, never `.claude/last-critique.md`.** The latter is
the code-review verdict that `/ship` reads and keys on a commit hash; a plan is not a commit, and
overwriting it would make `/ship` skip its own gate on the strength of a plan review.

---

## Loop Integrity Rules

The loop scores its own work, so it degrades into theater unless these hold:

1. **Scores never travel backward.** Findings carry forward between passes; scores do not.
   See 3a.
2. **A score rises only when the plan body changed.** The critic cannot enforce this -- it
   scores each version independently and is deliberately blind to the previous score. **You
   are the only party holding both numbers, so you enforce it.** If a pass reports a higher
   score while 3d's body test says nothing outside the revision records changed, the rise is
   an artifact of critic variance, not an improvement. Do not accept it as clearing the
   threshold: treat the pass as no-progress, go to Step 4, and report both scores and the
   fact that the plan did not change between them.
3. **Editing the plan to please the critic is not progress.** Deleting a risky section
   raises the score and lowers the plan's value. Reducing *scope* is a real fix; hiding it
   is not. This is the one integrity rule a fresh critic can actually police, which is why
   3a forwards the previous plan version -- without it the rule is unenforceable, since a
   removal nobody flagged leaves no trace in the current plan.
4. **The critic reports; it never edits.** It has no Write or Edit tool. Keep it that way --
   a critic that fixes what it finds cannot then judge it.
5. **A first-pass 90+ deserves suspicion.** Either the plan is genuinely small and
   well-grounded, or the critic skimmed. Check that its findings cite real `path:line`
   references before accepting it.
6. **Report the real number.** If it ends at 74, say 74. A fabricated pass is worse than no
   gate, because it is trusted.

## Error Handling

| Scenario | Action |
|---|---|
| No task in `$ARGUMENTS` | Ask what to plan; do not enter plan mode |
| Jira key given but MCP unavailable | Warn, ask the user for the acceptance criteria, continue |
| Critic emits no parsable score | Re-spawn a **fresh** critic once with explicit format instruction; then stop and report. Never infer a score |
| Critic BLOCKs (<50) on pass 1 | Do not patch: return to Step 2 and reconsider the approach |
| Score oscillates (up then down) | Later findings contradict earlier fixes. Stop, banner both scores and the contradiction, `ExitPlanMode` |
| Plan mode declined at Step 1 | Say so; offer to plan to a user-named path with the same loop, or stop. Do not call the result a plan-mode plan |
| Plan file path not in system message | Stop and report -- do not guess a path and write a plan somewhere unread |
| Max passes hit | Step 4 -- banner the shortfall into the plan, then `ExitPlanMode`. Never auto-approve, never ask for approval outside `ExitPlanMode` |

## Project Path

| Setting | Value |
|---|---|
| **Project** | `/data/Dev/job-radar` |
| **Dev Branch** | `main` |
