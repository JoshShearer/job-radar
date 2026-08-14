Create a handoff document capturing all context from the current conversation, so the work
continues in a fresh session with no information loss.

## Instructions

**Comprehensive detail and precision over brevity.** The goal is for a fresh instance to
pick up exactly where you left off.

1. **Original task** — what was initially requested, not scope that accreted later

2. **Work completed** — everything accomplished, in detail
   - Artifacts created, modified, or analyzed
   - Specific changes (files with line numbers, content written, data analyzed)
   - Actions taken (commands run, APIs called, searches performed)
   - Findings discovered
   - Decisions made and the reasoning

3. **Work remaining** — exactly what still needs doing
   - Broken into specific, actionable steps
   - Precise locations and references
   - Dependencies and ordering
   - Verification steps needed

4. **Attempted approaches** — including failures
   - What didn't work and why
   - Errors, blockers, limitations
   - Dead ends to avoid repeating
   - Alternatives considered but not pursued

5. **Critical context**
   - Key decisions and trade-offs
   - Constraints and boundaries
   - Gotchas, edge cases, non-obvious behavior
   - Environment and configuration details
   - Assumptions that need validation
   - References consulted

6. **Current state**
   - Status of each deliverable
   - Committed vs draft
   - Temporary changes or workarounds in place
   - Open questions

### Job Radar specifics to capture

These are the things a fresh session gets wrong most often here:

- **Which gates were actually run**, with output — `npm test`, `npm run typecheck`, and the
  command that was exercised. "Tests pass" without the command having been run is
  precisely the claim `CLAUDE.md` forbids.
- **Whether the analyze stage was invoked**, and roughly how many jobs it hit. It is the
  only thing that costs money.
- **Any cached analysis that was invalidated** by a description change, since
  `repo.upsert` clears the cached analysis and score.
- **Personal data state** — whether `config/personal.yaml` and `config/resume.yaml` are
  present in this workspace, since their absence makes the resume and apply commands fail
  in a way that looks like a bug but is not.
- **The Linear issue** this work belongs to, and its current status.
- **Config changes**, since `config/career-profile.yaml` is validated with cross-field
  coherence checks — lane weights summing to 1, ordered compensation bands, signals
  referencing real lanes.

## Where it goes

Write to `.claude/scratch/YYYY-MM-DD-job-{N}-handoff.md` when the work maps to a Linear
issue, otherwise `.claude/scratch/YYYY-MM-DD-<topic>-handoff.md`.

`.claude/scratch/` is gitignored — handoffs are working notes, not project documentation.
Anything that belongs in the repo goes in `TODO.md` or `README.md` via `/update-docs`.

## Output format

```xml
<original_task>
[The specific task initially requested — be precise about scope]
</original_task>

<work_completed>
[Artifacts created/modified/analyzed with specific references; changes with locations;
commands run and their output; discoveries; decisions and reasoning; side tasks]
</work_completed>

<work_remaining>
[Specific tasks with precise locations; exact targets; dependencies and ordering;
verification steps needed]
</work_remaining>

<attempted_approaches>
[What didn't work and why; errors and blockers; dead ends; alternatives considered]
</attempted_approaches>

<critical_context>
[Key decisions and trade-offs; constraints; gotchas and edge cases; environment and
config details; assumptions needing validation; references consulted]
</critical_context>

<verification_state>
[Which gates ran and their exact output. Which command was actually executed against real
data. What was NOT verified — state this explicitly rather than leaving it implied.]
</verification_state>

<current_state>
[Status of deliverables; finalized vs draft; temporary changes in place; position in the
workflow; open questions; Linear issue and its status]
</current_state>
```

## When to use

- Hitting context limits mid-task
- Ending a long session with work incomplete
- Handing off to a parallel worktree session
- Before switching to an unrelated area of the pipeline
