# /update-packages override - job-radar

## Risks per package

- **better-sqlite3**: ships prebuilt bindings; `allowBuilds` in `pnpm-workspace.yaml` keeps it
  `false` on purpose and `tests/toolchain.test.ts` pins that. A bump that drops the prebuild for
  this platform makes every command fail at startup (`Could not locate the bindings file`). Held;
  its own ticket.
- **esbuild**: `allowBuilds` must stay `true` (its postinstall links the binary tsx and vitest
  use). A bump that changes `keepNames` behaviour can break page-side code (`CLAUDE.md`
  "Verification"). Held; its own ticket.
- **playwright**: pins the Chromium the refusal harness drives. After a bump run
  `npx playwright install chromium` before `npm test`, or the suite fails loudly for a reason
  unrelated to the update.
- **vitest / @vitest/\***: move together.

## Runtime check after an update

`npm test`, `npm run typecheck`, then `npm run cli -- check` and `npm run cli -- sources` (free,
read-only), so a transport or config regression shows up before the PR.

Both lockfiles are tracked: an update moves `pnpm-lock.yaml` **and** `package-lock.json`, or the
two installs diverge.
