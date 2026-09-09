# Triage Labels

The engineering skills speak in terms of five canonical triage roles. **This repo has no
triage labels, and skills must not create any.**

Issues live in Linear, team `JOB`, which has exactly three labels — `Bug`, `Feature`,
`Improvement` (verified; see `.claude/linear.md`). Creating a label is a change to a
shared workspace and is the user's call, not an agent's.

## The mapping

| Role in mattpocock/skills | In this repo         | Meaning                                  |
| ------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`            | status `Backlog`     | Not yet evaluated                        |
| `needs-info`              | **no representation** | Waiting on the reporter                  |
| `ready-for-agent`         | **no representation** | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | **no representation** | Requires human implementation            |
| `wontfix`                 | status `Canceled`    | Will not be actioned                     |

Two roles map onto statuses the team already has. Three do not, and that is deliberate.

## What to do about the three that don't map

**Classify, report, and do not persist.** A skill may reach the judgement that an issue is
`ready-for-agent` and say so in its output. It must not try to record the distinction in
Linear.

Specifically, do **not**:

- create a label to hold it;
- borrow the priority field to encode it, which would corrupt a field that means something
  else;
- write a `**Triage:** ready-for-agent` comment as a stand-in. That invents a second state
  machine inside comment bodies which nothing else in this repo's tooling reads, and a
  state store only one tool can see is worse than no state store.

The reason the gap is tolerable: `.claude/commands/start-issue.md` moves an issue to
`In Progress` when work begins, so "who picked this up" is answered by whoever ran the
command. There is no window in this workflow where a stored `ready-for-agent` flag would be
read by anything.

If that changes — if agents start selecting their own work from the backlog unattended —
the gap becomes real, and the fix is to ask the user to create the labels in Linear and
then record them here and in `.claude/linear.md`.
