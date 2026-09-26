---
description: Plan mode plus one verification pass - checks the plan's claims against the repo before you approve it
argument-hint: "<what to plan>"
---

# /validated-plan -- Plan, Verify Once, Deliver

Produce an implementation plan whose **factual claims have been checked against the
repository** before you are asked to approve it.

Ordinary plan mode ends the moment the plan reads well. A plan reads well while asserting
that a helper exists when it does not, that a change touches three files when it touches
twelve, or that it satisfies an acceptance criterion it never mentions. This command adds
exactly one thing: a fresh reader who opens the files and checks.

## What this checks -- and what it deliberately does not

**Checked.** Every one of these is a fact about a repository that exists right now:

1. **Claims about the codebase.** Does each cited `path:line` exist and say what the plan
   says? Does each helper, hook, or utility it reuses exist with that signature? Is the
   blast radius honest?
2. **Requirements coverage.** Does the plan address every acceptance criterion in the
   issue, or is one missing or partial?
3. **Documented invariants.** Does it violate `CLAUDE.md` or a path-scoped rules file
   covering the files in scope?
4. **Verifiability.** Are the verification steps commands someone can actually run, or
   restatements of the goal? Is there a rollback?

**Not checked, on purpose.** No pre-mortems, no invented failure scenarios, no predicted
bugs in code nobody has written, no opinions on wording or structure.

That boundary is the whole design, and it is not a matter of taste -- see **Why one pass**
at the end. A plan is a set of claims about code that does not exist, so a reviewer has
ground truth for group one and only guesses for everything else. Guesses are where the
noise, the score churn, and the bloat come from.

## Usage

- `/validated-plan <what to plan>` -- plan, verify once, deliver
- `/validated-plan JOB-1234` -- a bare issue key: fetch the issue first, plan against it

There are no flags. **There is no loop and no passing score** -- see **Why one pass**. If
the verification turns up something that changes the shape of the plan, reject at
`ExitPlanMode` and run it again; that is the native mechanism and it keeps you in the loop
rather than the command.

Related: `/critique plan` is this same verification pass, standalone, on a plan that already
exists. `/ship` runs the real gate against real code.

## Contract

| | |
|---|---|
| **Delivers** | One plan whose repository claims have been checked, with anything unresolved disclosed in it |
| **Passes** | Exactly one |
| **Score** | Reported if the reviewer gives one. **Advisory** -- nothing gates on it |
| **Never delivers** | A plan with known-false claims left in it, or unresolved findings hidden |
| **Writes during the run** | The plan file only -- *provided plan mode was entered* (Step 1) -- and **never while the reviewer is running** (Step 3) |

---

## Step 0: Parse Arguments

Everything in `$ARGUMENTS` is the task. There are no flags to parse.

If the task names an issue in this repo's tracker, **fetch it** and use its summary,
description, and acceptance criteria as the requirements baseline. This repo tracks work in
**Linear** (`JOB-\d+`); `/create-issue` in this same directory shows the exact tooling,
and is the reference to follow rather than a tool name hardcoded here.

**Fetching is not optional when a key is given.** Requirements Coverage is the only one of
the four checks measured against something *outside* the plan -- the other three compare the
plan to the repo, and a plan is trivially complete with respect to itself. Skipping the
fetch does not merely lose information; it removes the check most likely to find something.

If no task was supplied, stop and ask what to plan. Do not enter plan mode with nothing to
plan.

## Step 1: Enter Plan Mode

Call **`EnterPlanMode`**. This is the harness's plan mode -- the same one shift+tab toggles.
(There is no `/plan` slash command in this repo; `EnterPlanMode` and shift+tab are the two
affordances.)

The plan-mode system message names the **plan file** you are to write to. **That path is
authoritative -- use it verbatim** and record it; every later step reads and rewrites this
one file. Do not invent a path, and do not assume `.claude/plan.md`: it is a legacy location
that may or may not be what this session was given.

**The user can decline this.** If they do, you are not in plan mode: nothing restricts
writes, there is no plan file, and the write-confinement this command advertises does not
hold. Say plan mode was declined, and offer to either draft to an explicit path the user
names and verify that, or stop. Never quietly continue and later call the result a
plan-mode plan.

## Step 2: Research and Draft

Research properly before writing. **Every unverified claim you write becomes a finding in
Step 3**, so the cheapest pass is the one where you opened the files yourself.

- Read the files the plan proposes to change. Cite them as `path:line`.
- Check `CLAUDE.md`, and any path-scoped rules files this repo keeps, for invariants covering the files in scope. A plan that
  violates one is not a style problem -- those were paid for with production incidents.
- Confirm every helper, hook, or utility the plan says it will reuse actually exists.
- Use a `general-purpose` or `Explore` subagent for broad fan-out searches so the main
  context stays clean.

Write the draft to the plan file:

1. **Goal** -- what and why, in a sentence or two
2. **Requirements** -- the acceptance criteria this must satisfy
3. **Approach** -- the design, and what was rejected and why
4. **Files to change** -- each with `path:line` and what happens to it
5. **Verification** -- the exact commands or observations that prove it works
6. **Risks and rollback** -- what could go wrong, and how to undo it

Keep it decisive. A plan is written to be executed from, not to survive review; hedging
every claim makes it longer and worse.

## Step 3: Verify (one pass)

Follow the **Plan Review Path** in [`.claude/commands/critique.md`](./critique.md). It owns
how the reviewer is briefed and what the four checks mean. Do not re-implement that here.

Two of its steps are **overridden inside this command**:

| `critique.md` step | Inside `/validated-plan` |
|---|---|
| **P1** -- locate the plan | Already located in Step 1, from the plan-mode system message. Skip P1's search and its fallbacks; they exist for a standalone `/critique plan` that must find a plan it did not write |
| **P4** -- record the verdict | Writes nothing here (plan mode blocks it). The verdict file is written after `ExitPlanMode`, in Step 6 |

Pass to the reviewer: the full plan, and the requirements baseline from Step 0 or an
explicit note that there is none.

**Spawn a **fresh `general-purpose` subagent** and hand it the Plan Review Path from `critique.md` verbatim -- this repo has no `critic` agent, so `/critique` inlines the protocol. Never continue an agent that has already seen this plan.**

**Never review the plan in this session.** You wrote it; you already believe it. A fresh
reader is the entire mechanism -- a self-review inside the drafting context finds nothing,
because the blind spot that produced the error is still in place.

**Do not touch the plan file while the reviewer is running.** It reads the file itself, so
an edit mid-pass produces findings against text that no longer exists. If you notice a
defect of your own, hold it and apply it in Step 4 with the rest.

## Step 4: Apply and Disclose

Address the findings in the plan file:

- **A false claim is a defect -- fix it.** The plan cites a line that does not exist, misses
  a requirement, or contradicts a documented invariant: correct it.
- **Verify before you accept.** The reviewer can be wrong. Check its claim against the
  actual file. If it is mistaken, say so in the plan with the evidence that refutes it, and
  do not make the change.
- **Do not pad.** Absorbing a finding means correcting a fact, not appending a paragraph of
  caveats. If a finding does not change what someone would *do*, note it and move on.
- **Record disagreements as accepted risks**, under that name.

Append one record to the plan:

```markdown
> **Verification pass (YYYY-MM-DD):**
> - **F1 (HIGH)** -- [finding]. [What changed, and where.]
> - **F2 (LOW)** -- [finding]. **Not applied:** [evidence refuting it, or why accepted.]
```

**If any finding could not be resolved**, put a banner as the first thing in the plan file,
above the Goal:

```markdown
> ## ⚠ UNRESOLVED -- {N} finding(s) outstanding
>
> - **F{n} ({severity})** -- {finding, and why it is unresolved}
```

Do not present such a plan as verified, and **do not ask whether to approve it anyway**.
Plan mode permits exactly one channel for plan approval -- `ExitPlanMode` -- and forbids
requesting it any other way, `AskUserQuestion` included. The banner discloses it; the native
gate decides it. If the user rejects, plan mode resumes with their feedback.

## Step 5: Deliver

Call **`ExitPlanMode`**, which reads the plan file and presents it for approval. Precede it
with a short summary:

```
Plan verified. Claims checked against the repo; no findings outstanding.

Fixed:  2 false path references, 1 missing acceptance criterion
Score:  84/100 (advisory -- reported by the reviewer, not a gate)
Accepted risks: 1 (see plan)
```

If something is outstanding, lead with that -- never bury it under "verified":

```
Plan delivered with 1 UNRESOLVED finding (banner at the top of the plan).

Fixed:      3 findings
Unresolved: 1 HIGH -- the migration order is unverifiable until the schema lands
```

## Step 6: Record the Verdict (after exiting plan mode)

Plan mode permits writes to the plan file only, so this happens **after** `ExitPlanMode`.
Write to ``.claude/last-plan-critique.md``:

```markdown
## Last Plan Verdict
- **Date:** [ISO timestamp]
- **Plan file:** [path]
- **Findings:** [N fixed, N unresolved]
- **Score:** [advisory, if given]

### Key Decisions
### Accepted Risks
### Critical Action Items
```

****Write to `.claude/last-plan-critique.md`, never `.claude/last-critique.md`.**** That file is the code-review verdict `/ship` reuses in place of
running its own gate whenever the commit hash in it matches HEAD. A plan is not a commit,
and a plan verdict landing there would let unreviewed code ship on the strength of a review
that never read any code.

---

## Why one pass

This command looped until the plan scored 80+. That gate could not terminate, and the
reason generalises.

**The score was unreachable by construction.** The rubric weights Soundness 25% and
Requirements / Codebase / Gaps 20% each, so 80 requires a straight 8 on every dimension at
once. But the calibration anchor for 5-6 is "notable gaps that could cause rework" -- which
is what a HIGH finding *is*. An honest reviewer filing one must rate that dimension 5-6,
capping the total at **75**. The gate asked an adversarial reviewer for a clean bill of
health.

**And iterating did not converge, because there is nothing to converge on.** Measured over
three passes on a real plan: **62 -> 70 -> 66**, every finding correctly applied, the plan
better each time, the number wandering. Code review has ground truth -- fixing a bug removes
it permanently. Plan review does not: **adding specificity creates new surface to
criticise**. By pass three, *all four* HIGH findings were about passes one and two's own
fixes. Scope Feasibility fell 7 -> 6 purely from absorbing findings the acceptance criteria
mandated -- the metric moving the wrong way under correct action.

**The bloat is the real cost.** One critique round grew this command's own file from 257 to
363 lines, +41%, mostly hedging added to survive review rather than substance. A loop
optimises a plan for *reviewability*; those diverge from *executability*. A plan that
survives adversarial review is verbose and caveat-laden. A plan that is good to execute from
is short and decisive.

So: **one pass, and only the checks with ground truth.** Pass one pays for itself -- a
confident `path:line` that does not exist is invisible until implementation and expensive
then. Everything after it is the reviewer talking to itself. When findings persist, the
honest next step is a human read, or implementing the plan and letting `/ship` review real
code, where a critic has something solid to stand on.

**If you are tempted to add a second pass or a numeric gate:** work the arithmetic first and
check that an honest reviewer filing findings can actually clear it. A gate that requires
the reviewer to find nothing is a budget burner, not a quality bar.

## Error Handling

| Scenario | Action |
|---|---|
| No task in `$ARGUMENTS` | Ask what to plan; do not enter plan mode |
| Issue key given but Linear MCP unavailable | Warn, ask the user for the acceptance criteria, continue |
| Plan mode declined at Step 1 | Say so; offer to plan to a user-named path and verify that, or stop. Do not call the result a plan-mode plan |
| Plan file path not in system message | Stop and report -- do not guess a path and write a plan somewhere unread |
| Reviewer finds the approach itself wrong | Do not patch around it. Redraft from Step 2; that is one plan, not a second pass |
| Reviewer emits no findings and no verdict | Check that it cited real `path:line` references. A silent pass on a complex plan usually means it skimmed; re-run it once with an explicit brief |
| Findings unresolved | Banner them into the plan, then `ExitPlanMode`. Never auto-approve, never ask for approval outside `ExitPlanMode` |

## Project Path

| Setting | Value |
|---|---|
| **Project** | `/data/Dev/job-radar` |
| **Dev Branch** | `main` |
