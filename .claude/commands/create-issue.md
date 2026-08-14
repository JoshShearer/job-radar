Create a Linear issue in the **JOB** team from our conversation.

Conventions: `.claude/linear.md`.

## Input

Argument: `$ARGUMENTS` (optional)

- `feature` — new capability
- `bug` — something is broken
- `tech-debt` — needs improvement, not broken
- `blocker` — blocking issue
- `plan` — decompose current work into a structured issue
- *(omit)* — auto-detect from conversation context

## Step 1: Determine type

| Argument | Type label | Default priority | Title prefix |
|---|---|---|---|
| `feature` | `Feature` | Normal (3) | — |
| `bug` | `Bug` | High (2) | — |
| `tech-debt` | `Improvement` | Low (4) | — |
| `blocker` | (none) | Urgent (1) | `[BLOCKER]` |
| `plan` | auto-detect | varies | — |
| *(omitted)* | auto-detect | varies | — |

The JOB team has exactly three labels — `Bug`, `Feature`, `Improvement` (verified; see
`.claude/linear.md`). There is no `Chore` and no `Documentation`. Applying a label that does
not exist fails the create call, so use only these three or none.

## Step 2: Gather details from the conversation

- **Feature**: proposed capability, problem it solves, requirements, acceptance criteria
- **Bug**: what's broken, repro steps, expected vs actual, error output
- **Tech debt**: what needs improvement, why it's debt, impact
- **Blocker**: what's blocked, cause, impact, how to unblock
- **Plan**: review the todo list, split completed from remaining, summarize the goal

**Bugs need a real reproduction.** Per the global CLAUDE.md, a bug is reproduced
end-to-end as a user before it is fixed. If the conversation has not actually run the
failing command, say so in the issue body under **Steps to Reproduce** rather than
inventing plausible steps.

## Step 3: Labels

Apply the type label from the table above, and nothing else.

**There are no area labels in this workspace.** Area is carried by the commit scope
(`feat(sources): …`) and the branch name instead. Do not invent `Pipeline`, `Sources`, or
similar — creating labels is a change to the shared workspace and is the user's call. If they
are added later, record them in `.claude/linear.md` and extend this step.

## Step 4: Assignee

Default `"me"`.

## Step 5: Issue body

Section headings per type (markdown `##`):

- **Feature**: Description, Problem/Value, Requirements, Acceptance Criteria, Notes
- **Bug**: Bug Description, Steps to Reproduce, Expected Behavior, Actual Behavior, Additional Context
- **Tech Debt**: What, Why, Impact, Suggested Approach
- **Blocker**: What is Blocked, Cause, Impact, To Unblock, Workaround
- **Plan**: Overview, Tasks (completed `[x]` + remaining `[ ]`), Notes

### Constraint note (required when relevant)

If the work touches any of these, add a `## Constraints` section naming the rule from
`CLAUDE.md` that governs it, so the constraint travels with the ticket:

| Area | Rule the issue must respect |
|---|---|
| `src/resume/` | Resume text is a selection from `config/resume.yaml`; provenance is enforced, never loosened |
| `src/apply/` | Fills and stops. Never submits, never ticks a checkbox, never answers demographics or attestations |
| `src/analysis/` | Costs money — the four cost-control mechanisms stay intact |
| `src/sources/` | Public documented endpoints only; adapters do no classification |
| `src/pipeline/` | Deterministic. No model calls for comparison, parsing, or arithmetic |
| `src/report/` | Remote OK attribution is a condition of use |

## Step 6: Confirm before creating

Show title, labels, priority, assignee, and the constraint note. Wait for a yes.

## Step 7: Create and report

`mcp__linear-jr__save_issue` in the **JOB** team. Use the `url` the response returns — do not
construct one.

```
Issue created: JOB-{id}
Title: {issue title}
Type: {feature|bug|tech-debt|blocker}
URL: {url from the MCP response}

Suggested branch: feature/job-{id}-{slug}

Next: /start-issue JOB-{id}
```

## Examples

```
/create-issue feature
/create-issue bug
/create-issue tech-debt
/create-issue blocker
/create-issue plan
/create-issue
```

## Degradation

| Failure | Handling |
|---|---|
| Linear MCP not connected | Print the issue as a formatted table for manual creation, and still suggest the branch name |
