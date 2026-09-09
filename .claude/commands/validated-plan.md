---
description: Plan mode with an adversarial critic loop - iterates the plan until no HIGH findings remain
argument-hint: "<what to plan> [--max-passes=3] [--threshold=N]"
---

# /validated-plan -- Plan, Critique, Revise, Repeat

Produce an implementation plan that has **already survived adversarial review** before you
are asked to approve it.

Ordinary plan mode ends the moment the plan reads well. This command does not end there: it
hands the finished draft to the **critic** agent, applies the findings, and re-critiques --
looping until no HIGH finding survives a pass. **The finalized plan is the deliverable.**

## The gate is HIGH findings, not the score

**Read this before changing the threshold.** The score is reported; it is not what the loop
waits for. That is a deliberate correction to an earlier version of this command, which
looped on `score >= 80` and could not terminate.

The Mode 3 rubric weights Soundness 25%, Requirements / Codebase / Gaps 20% each, and Scope
15%. Work the arithmetic against the rubric's own calibration anchors:

| Dimension ratings | Score |
|---|---|
| Soundness 6, all others 8 | 75 |
| Soundness 7, all others 8 | 78 |
| **Soundness 8, all others 8** | **80** |
| Everything 7 | 70 |

**80 requires a straight 8 on every dimension at once.** The anchor for 7-8 is "minor gaps
or unverified assumptions"; for 5-6 it is "notable gaps that could cause rework". A HIGH
finding *is* a notable gap, so an honest critic filing one must rate that dimension 5-6 --
which caps the total at **75, below the gate, no matter how good the plan is.**

So `--threshold=80` asks an adversarial reviewer for a clean bill of health. On a plan of
any real complexity it will not give one, and the loop burns its whole budget while the
plan improves and the number does not. Observed on a real run: **62 -> 70 -> 66** across
three passes, with every pass's findings correctly applied and the plan materially better
each time.

Gate on **unresolved HIGH findings** instead. The score stays in the report because the
trend is informative, and a stalled score in the 50s still means the *approach* is wrong.

## Usage

- `/validated-plan <what to plan>` -- plan and validate until no HIGH findings remain
- `/validated-plan <what> --threshold=90` -- also require a numeric score (see the warning above)
- `/validated-plan <what> --max-passes=4` -- allow more revision rounds (default 3, max 4)
- `/validated-plan JOB-1234` -- a bare issue key: fetch the issue first, plan against it

Related: `/critique plan` reviews a plan **once**, without the loop. `/ship` runs the
equivalent gate against code. This command is the planning-time counterpart.

## Contract

| | |
|---|---|
| **Delivers** | One plan file plus its full revision history -- normally one with no unresolved HIGH findings |
| **Gate** | **No unresolved HIGH findings.** The score is reported, not waited on -- see above |
| **When the gate is not met** | The plan is still delivered, carrying a `GATE NOT MET` banner with its score, trend, and unresolved findings (Step 4). Falling short is a disclosed outcome, not a hidden one |
| **Never delivers** | A plan that failed the gate, presented as if it passed |
| **Scale** | 0-100, reported only. PASS >= 80, CONCERNS 50-79, BLOCK < 50 |
| **Default budget** | 3 critic passes. **Hard maximum 4** |
| **Writes during the loop** | The plan file only -- *provided plan mode was entered* (Step 1) -- and **never while a critic is running** (3a) |

---

## Step 0: Parse Arguments

From `$ARGUMENTS`, extract:

- **Task** -- everything that is not a flag. This is what gets planned.
- **`--threshold=N`** -- an *additional* numeric bar on top of the HIGH-findings gate.
  **Unset by default.** Only apply one if the user passed it, and if they passed 80 or
  above, say once that the rubric makes it near-unreachable (see "The gate is HIGH
  findings") and proceed as they asked. Clamp to 0-100.
- **`--max-passes=N`** -- maximum critic passes. Default **3**. **Clamp to 1-4.** If the
  user asks for more than 4, cap it and say so: past four passes the loop is re-reviewing
  its own revisions rather than the plan, and the fix is a redraft or a human, not another
  critic.

If the task names an issue in this repo's tracker, **fetch it** and use its summary,
description, and acceptance criteria as the requirements baseline. This repo tracks work in
**Linear** (`JOB-\d+`); `/create-issue` in this same directory shows the exact
tooling, and is the reference to follow rather than a tool name hardcoded here.

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
- Check `CLAUDE.md`, and any path-scoped rules files this repo keeps under `.claude/`. These encode hard-won invariants; a plan that violates one is a BLOCK.
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

**Do not touch the plan file while a critic is running.** It reads the file itself, so an
edit mid-pass produces findings against text that no longer exists -- two of them on the run
that motivated this rule, both already fixed before the report arrived, and both counted
against the score anyway. Queue every revision until the verdict is in. If you notice a
defect of your own mid-pass, hold it and apply it in 3c with the rest.

**Tell the critic two things that keep its severities honest**, in the prompt alongside the
findings:

- **Do not penalise scope that the acceptance criteria mandate.** Scope Feasibility is for
  work the plan failed to anticipate, not for work the requirements demand. Without this,
  every fix lowers the score, because every fix adds scope -- observed as Scope Feasibility
  falling 7 -> 6 purely from absorbing the previous pass's findings.
- **Label each finding `new` or `carried`**, and say whether a `new` one concerns text that
  a previous finding introduced. This is what makes 3b's self-generated-findings guard
  checkable rather than a judgment call.

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
two are not comparable. If you clear the gate without a baseline, say that in the delivery
summary and in the verdict record. Do not let "no acceptance criteria were handy" quietly
become the easier path to a clean run. Note that dropping Requirements Coverage also removes
the one dimension the loop cannot move -- it sat at 8 for all three passes of the run that
motivated these rules -- so a baseline-less run is both easier and noisier.

### 3b. Read the Verdict

Parse `**Score:**` and the findings list from the critic's verdict block.

**The gate is the findings, not the number:**

- **No HIGH findings** (and any `--threshold` the user set is met) -- the gate is met. Go to
  Step 4.
- **Any HIGH finding** -- continue to 3c, whatever the score says.
- **No parsable score** -- treat as a failed pass, not a passing one. Re-spawn a fresh critic
  once with an explicit instruction to emit the verdict block. **The re-spawn does not consume
  a pass** -- the budget counts completed reviews, and a malformed verdict reviewed nothing.
  If it fails again, stop and report; never infer a score.

**Then check two termination conditions before spending another pass.**

**Regression guard.** If the score fell while the plan body only *gained* content, that is
critic variance, not decline -- a fresh critic each pass has no anchor, and ±8 between
passes on an improving plan has been observed. Do not spend a pass chasing it. Apply the
findings, then go to Step 4 and report both scores, the trend, and the fact that the plan
did not shrink.

**Self-generated-findings guard.** Count how many of this pass's HIGH findings are about
text that a *previous* pass's findings put there. If it is most of them, the loop is
reviewing its own revisions rather than the plan: each fix adds specificity, and
specificity is surface. Stop, apply them, and say so in Step 4's banner. On the run that
motivated this rule, **all four** of pass 3's HIGH findings were about pass 1 and pass 2's
fixes.

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
current score, reporting that it converged with findings outstanding. Spending the remaining
passes re-litigates a plan that is not changing.

**Judge the body, not the file's mtime or byte count.** Appending a record of having refuted
three findings is not progress, and it is exactly what an unchanged plan looks like from the
outside.

## Step 4: Converged, or Out of Passes

### Gate met -- no HIGH findings survived

Report the score, the pass count, and what was fixed. Proceed to Step 5.

### Gate NOT met after max-passes (or any guard in 3b fired)

**Do not present the plan as validated, and do not ask whether to approve it anyway.**

Plan mode permits exactly one channel for plan approval -- `ExitPlanMode` -- and explicitly
forbids requesting it any other way, including with `AskUserQuestion`. So the shortfall is
disclosed *in the plan itself*, and the user then approves or rejects through the normal
gate. An "approve anyway?" question here would be both a protocol violation and the precise
moment this command is most tempted to launder a failure into a pass.

Write a banner as the **first thing in the plan file**, above the Goal:

```markdown
> ## ⚠ GATE NOT MET -- {N} unresolved HIGH finding(s), score {score}/100
>
> {N} critic pass(es). Score by pass: {e.g. 62 -> 70 -> 66}.
> {"Stopped early: " + which 3b guard fired, if one did}
>
> **Unresolved findings:**
> - **F{n} ({severity})** -- {finding, and why it was not resolved}
>
> {If the score moved but HIGH findings persisted, say which -- they are different
> outcomes and the reader needs to know which one this is.}
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

**A score that moves within a narrow band while HIGH findings keep arriving means something
different**, and it is the common case: the plan is getting better and the metric cannot see
it. Say that, rather than implying the plan is stuck. The useful recommendation there is a
human read, or implementing the plan and letting `/ship`'s gate review real code -- a plan
review has a floor it cannot get under, because a plan is a set of claims about code that
does not exist yet, and past a certain specificity the remaining findings are about the
task's difficulty rather than the plan's quality.

## Step 5: Deliver

The plan file now contains the plan, its revision history, and -- if the gate was not met --
the shortfall banner. Call **`ExitPlanMode`**, which reads that file and presents it for
approval.

Precede it with a short summary. On success:

```
Validated plan ready. No HIGH findings survived the last pass.

Score:   86/100 (reported, not the gate)
Passes:  3
Fixed:   2 HIGH, 3 MEDIUM
Accepted risks: 1 (see plan)
```

On a shortfall, lead with it -- never bury it under the word "ready":

```
Plan did NOT meet the gate.

Unresolved: 1 HIGH, 2 MEDIUM (listed at the top of the plan)
Passes:  3 of 3
Score:   67/100 (reported; the gate is the HIGH finding)

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
the code-review verdict that `/ship` reads and keys on a commit hash; a plan is not a
commit, and overwriting it would make `/ship` skip its own gate on the strength of a plan
review.

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
7. **The loop must be able to terminate.** Before adding any numeric bar, work the rubric
   arithmetic and check that an honest critic filing findings can actually clear it. A gate
   that requires the reviewer to find nothing is not a quality bar, it is a budget burner --
   which is what `--threshold=80` was, and why the gate is now HIGH findings. If you tighten
   this command, tighten it somewhere a good plan can still pass.
8. **More passes is rarely the answer.** Four is the ceiling for a reason: by pass four the
   critic is mostly reviewing the previous passes' revisions. If HIGH findings persist at
   four, the plan needs a human or a different approach, not a fifth critic.

## Error Handling

| Scenario | Action |
|---|---|
| No task in `$ARGUMENTS` | Ask what to plan; do not enter plan mode |
| Issue key given but Linear MCP unavailable | Warn, ask the user for the acceptance criteria, continue |
| Critic emits no parsable score | Re-spawn a **fresh** critic once with explicit format instruction; then stop and report. Never infer a score |
| Critic BLOCKs (<50) on pass 1 | Do not patch: return to Step 2 and reconsider the approach |
| Score oscillates (up then down) | Usually critic variance, not decline -- see 3b's regression guard. Stop, apply the findings, banner both scores and the trend, `ExitPlanMode` |
| Most of a pass's HIGH findings target the previous pass's fixes | 3b's self-generated-findings guard. Stop; the loop is reviewing itself |
| User asks for more than 4 passes | Cap at 4 and say why: past four the critic reviews revisions, not the plan. Offer a human read or `/ship`'s gate on real code instead |
| Plan mode declined at Step 1 | Say so; offer to plan to a user-named path with the same loop, or stop. Do not call the result a plan-mode plan |
| Plan file path not in system message | Stop and report -- do not guess a path and write a plan somewhere unread |
| Max passes hit | Step 4 -- banner the shortfall into the plan, then `ExitPlanMode`. Never auto-approve, never ask for approval outside `ExitPlanMode` |

## Project Path

| Setting | Value |
|---|---|
| **Project** | `/data/Dev/job-radar` |
| **Dev Branch** | `main` |
