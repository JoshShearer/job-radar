# /worktrees override - job-radar

## Setup, after `pnpm install --frozen-lockfile`

1. `npm run cli -- init` copies `config.example/` into `config/` (never overwriting).
2. The evidence ledger, the personal file and `.env` are gitignored, so a fresh worktree has none.
   For an **interactive** worktree, link them from the primary so `tailor`, `prepare` and `fill`
   work on the owner's real material:

   ```bash
   for f in config/candidate/evidence.yaml config/candidate/personal.yaml .env; do
     [ -e "<primary>/$f" ] && ln -s "<primary>/$f" "$f"
   done
   ls -l config/candidate/ .env
   ```

   Report what was linked and what was not found (`tailor`/`prepare` refuse without the evidence
   file). Confirm they are symlinks, never copies: the primary is the one place those files live.
3. A `/run-tickets` lane does none of step 2: `## Autonomous runs` fences those files, and a lane
   starts with no personal material by design.

## Pool

Interactive worktrees are `job-radar-job-{N}`, siblings of the primary. `job-radar-run-*` lanes
are `/run-tickets`'; this command lists them and refuses to remove them.
