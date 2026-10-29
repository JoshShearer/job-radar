# /ship override - job-radar

## Run what changed

After the gates and before the critic: run the command the diff touches, per the area table in
`.claude/overrides/verify.md`, and put what you ran and saw in the PR body under Testing. The
`assess` row costs money and the `fill` row types into a live employer's form: both are
interactive-only and are reported as not run otherwise.

## Constraint gate

Run `/check-constraints` (the local command). Any **BLOCK** row stops the ship; the constraints it
checks are the ones `CLAUDE.md` calls non-negotiable.

## Ticket

There is no `In Review` status: leave the issue In Progress and post the PR link as a comment.
Footer: `Resolves JOB-{N}` is for humans reading history; it closes nothing (no GitHub
integration), `/finish` does.
