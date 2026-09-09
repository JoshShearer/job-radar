# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary.
- **`CLAUDE.md`** at the repo root — the **standing rules**. This repo keeps its
  non-negotiable constraints there, not in ADRs. An empty or sparse `docs/adr/` does
  **not** mean nothing was decided; it means the decision is stated as a rule in
  `CLAUDE.md` instead. Read it before proposing a change to `src/resume/`,
  `src/apply/`, `src/analysis/`, `src/sources/`, `src/pipeline/`, or `src/report/`.
- **`docs/adr/`** — read the ADRs that touch the area you're about to work in.

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/`, both at the root.
There is no `CONTEXT-MAP.md`. `pnpm-workspace.yaml` exists only to set `allowBuilds`
for native dependencies — it is not a monorepo signal.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't
suggest creating them upfront. `/domain-modeling` creates them lazily, when a term or a
decision actually gets resolved.

## File structure

```
/
├── CLAUDE.md        ← standing rules an agent must obey
├── CONTEXT.md       ← glossary: what the words mean
├── docs/adr/        ← why a reversible-looking decision went the way it did
│   └── 0001-....md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a
hypothesis, a test name — use the term as `CONTEXT.md` defines it. Don't drift to
synonyms the glossary explicitly distinguishes.

This matters more here than in most repos. Several of this project's terms are
near-synonyms in ordinary English but denote different things in the code, and
collapsing them has caused real regressions. If the concept you need isn't in the
glossary, that's a signal: either you're inventing language the project doesn't use
(reconsider), or there's a real gap (note it for `/domain-modeling`).

## Rules vs. decisions

- A **rule** in `CLAUDE.md` is binding. Don't "improve" it, loosen it, or reason around
  it. Several are load-bearing refusals whose whole value is that they never yield.
- An **ADR** records the reasoning and the alternatives rejected, for a decision a
  future reader would otherwise reopen. ADRs are written going forward; the pre-existing
  decisions live as rules in `CLAUDE.md` and are not backfilled.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it rather than silently overriding:

> _Contradicts ADR-0002 (retiring the absolute fit gate), but worth reopening because…_

If your output contradicts a **rule** in `CLAUDE.md`, that is not a conflict to weigh —
stop and raise it with the user.
