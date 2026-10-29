# Model calls can run through the Claude Code CLI on the subscription

> Decided 2026-10-29 (JOB-73). Applies to `src/adapters/claude-cli/client.ts`, `src/ui/compose.ts`,
> `src/app/gateway.ts`, `operations.yaml` `model:`, and migration 2 (`model_call.provider`).

## Context

Every model call went through `AnthropicClient` on a paid `ANTHROPIC_API_KEY`. The owner wants
them on the claude.ai subscription instead, through `claude -p` (probed with claude 2.1.312,
`authMethod: claude.ai`). The CLI returns a JSON envelope with `structured_output` and a usage
block in the API's shape, but it is an agent, not an endpoint: one request can take several API
calls (observed: a success in 2 turns; a truncation in 4 turns producing 1200 output tokens
against a 300-token cap).

## Decision

`operations.yaml` `model.provider: api | claude-cli` picks the `ModelClient`. Absent means `api`,
so an existing install never changes billing on a pull; `config.example/` selects `claude-cli`.
`src/app/gateway.ts` stays the only caller, and its address, cache, reservation, receipts and Zod
validation are the same for both providers. The provider is not part of the request address, so
switching providers never re-buys an answer.

**The lane fence.** `src/ui/compose.ts` builds a `ClaudeCliClient` only when `JR_ALLOW_MODEL=1`,
`model.cli.binary` resolves to an executable, and the working directory
`<JR_HOME>/data/claude-cli-cwd` is a real 0700 directory owned by us and empty. Otherwise
`modelClient()` is null and the gateway throws `NoModelConfigured` **before reserving**: a missing
binary must not leave a worst-case receipt per attempt (each would count against the day and
month ceilings while spending nothing). `/run-tickets` strips and refuses `JR_ALLOW_MODEL`
(`scripts/run-tickets/ticket-ops.mjs`, the `.claude/project.md` fence), and `vitest.config.ts`
blanks it, so neither a lane nor `npm test` can spend quota. Tests never spawn the real `claude`.

**The invocation.** `claude -p --output-format json --safe-mode --tools "" --setting-sources ""
--strict-mcp-config --no-session-persistence --max-turns <reserve_turns> --model <m> [--effort <e>,
not on Haiku] --max-budget-usd <reserve> --json-schema <schema> --system-prompt-file <file>`, the
user prompt on stdin, and a child env built from an allowlist (below) plus
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` set to `max_output_tokens`. The cwd is stable rather than fresh
per call because the CLI tells the model its cwd, and a random path would change every prompt.

- **No prompt text in argv.** Any local user can read a process's argv from `/proc/<pid>/cmdline`,
  and the prompts carry the candidate's evidence and the posting. The system prompt is written to a
  0600 file (created with `wx`, a random name) in `<JR_HOME>/data/claude-cli-prompts/`, a 0700
  directory we own beside the cwd (not inside it, so the cwd stays empty), passed by
  `--system-prompt-file`, and deleted in a `finally` after success, error, timeout or a spawn
  failure. A crash of jr itself mid-call can leave one such file behind, still 0600 in a 0700
  directory. `--system-prompt-file` appears in `claude --help` 2.1.312 only inside the `--bare`
  text (`--system-prompt[-file]`), not as its own entry; it is unconfirmed until the owner's first
  real call. `--json-schema` has no file form, so the schema stays in argv: it is a non-secret
  structural description generated from our Zod schemas, never candidate or posting text.
- **The child env is an allowlist** (`childEnv` in the adapter): `HOME`, `PATH`, `USER`,
  `LOGNAME`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, the `XDG_*` base directories,
  `CLAUDE_CONFIG_DIR` if set, and nothing else. A denylist let `CLAUDE_CODE_USE_BEDROCK` /
  `VERTEX` / `FOUNDRY` and `ANTHROPIC_BASE_URL` reach the child, so a shell with any of them set
  would have billed a third party or a proxy while the ledger said "subscription"; it also passed
  `CLAUDECODE`, `JR_ALLOW_MODEL` and every `.env` secret (Gmail). Proxies (`HTTPS_PROXY`) and
  `NODE_OPTIONS` are dropped too. Separately, `compose` refuses to build the client when
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` or
  `ANTHROPIC_BASE_URL` is set in jr's own env: the allowlist already keeps it from the child, but
  the refusal tells the owner their shell would have billed elsewhere. **Owner check**: the
  allowlist is what the CLI needs to find its OAuth login (`~/.claude/.credentials.json`, under
  `HOME` or `CLAUDE_CONFIG_DIR`) as far as a free check can show: on 2026-10-29,
  `env -i HOME="$HOME" PATH="$PATH" USER="$USER" LOGNAME="$LOGNAME" LANG="$LANG" TERM=dumb claude
  auth status` (2.1.312) reported `loggedIn: true`, `authMethod: claude.ai`, `apiProvider:
  firstParty`. That is `auth status`, not `-p`; the owner's first real call confirms it for
  `-p`. If that call reports not logged in, the allowlist is missing a variable the CLI needs:
  add that one key with a test, never fall back to passing the whole env. Whether
  `--setting-sources ""` also keeps an `env` block in `~/.claude/settings.json` from setting a
  redirect is unverified.
- **`--bare` is unusable**: it reads only `ANTHROPIC_API_KEY` / `apiKeyHelper`, never OAuth.
- **`--safe-mode`** (in `claude --help` 2.1.312: "CLAUDE.md, skills, installed plugins, hooks, MCP
  servers ... disabled ... Auth, model selection ... work normally") is what keeps the owner's
  `~/.claude/CLAUDE.md`, hooks and plugins out of the call. One probe without it (with
  `--setting-sources ""`) had the model list its context verbatim, and the list held no
  CLAUDE.md text or hook output, but that is model self-report, not proof that hooks did not run.
  **Residual risk**: that `--safe-mode` coexists with `--tools ""` and `--system-prompt`, and that
  the prompt is read from stdin, are unconfirmed until the owner's first real call.

**Outcome mapping** (shape only; the gateway classifies): success -> the `structured_output` as
the text block; "exceeded the N output token maximum" -> `max_tokens` (`truncated`);
`stop_reason: refusal` -> `refusal` (no CLI refusal has been observed; its fixture is synthetic);
`structured_output` missing -> no text block (`invalid_json`); the `--max-turns` early exit
(subtype `error_max_turns`, or any failed envelope whose text mentions max turns) ->
`ModelCallError` at its usage (`api_error`), checked before truncation; any other error with an envelope ->
`ModelCallError` carrying its usage (`api_error` at that usage); no parseable envelope, timeout,
signal, overflow or a spawn failure -> `api_error` at the reserve. The envelope's prose `result`
is never passed through as the answer: the CLI's own `--json-schema` check is advisory, and the
gateway's Zod validation is the only acceptance.

**The turn count is CLI-enforced; the dollar ceiling is still ours.** On claude-cli the gateway
reserves `reserve_turns` x (prompt bytes / 3 + `overhead_input_tokens` + `max_output_tokens`) at
`PRICING` (defaults 4 and 4000; 4 is the most turns observed), and the adapter passes the same
`reserve_turns` as `--max-turns`, so the CLI stops where the reserve's turn multiplier stops.
`--max-turns <turns>` is a hidden option in 2.1.312 (absent from `claude -p --help`; the binary's
strings define it as "Maximum number of agentic turns in non-interactive mode. This will early
exit the conversation after the specified number of turns. (only works with --print)"), and
`claude -p --max-turns 1 --help` parses it (exit 0). **Unverified until the owner's first real
call**: whether the CLI's internal output-token-truncation retries count as turns (if they do
not, a truncating call can still exceed `reserve_turns` x `max_output_tokens`), and the JSON
envelope of the max-turns exit (the binary's SDK schema names subtype `error_max_turns` with
`errors: ["Reached maximum number of turns (N)"]`; its fixture is synthetic). Per-turn usage
can also exceed our per-turn estimate (prompt bytes / 3 + overhead). `--max-budget-usd` is
enforced in the CLI's own prices, which on the observed success were about 9x below ours
($0.00068 against $0.0059 at `PRICING`), so a cap equal to our reserve admits several times our
reserve in our units; what happens when it is exceeded is unobserved. An overshoot is therefore
still receipted at its real usage with the gateway's `WARNING`, and the receipt's `error` carries
`turns=N` (also on every failure), so `reserve_turns` can be re-tuned from the ledger.

**Accounting.** claude-cli dollars are our `PRICING` applied to the usage the CLI reports: a
**list-price equivalent** of subscription quota, not money spent. They count against the same
`per_run_usd`, `per_day_usd` and `per_month_usd` ceilings. Migration 2 adds `model_call.provider`,
written once at reservation (NULL rows predate it and read as `api`), so `jr spend`, `jr show`, the
web view and the run summaries label claude-cli figures "subscription, list-price equivalent" even
in mixed history. `check` refuses a `per_run_usd` below one claude-cli worst case; the example
budget moved from 1.5 to 2.5 for that reason (4 x 16,000 opus output tokens + overhead is $1.68).

## Consequences

- The CLI injects context we do not control: the account email, its cwd and today's date. They
  are outside our prompt, so the request address and the cache are unaffected, but the model sees
  the date. Prompts must still carry nothing volatile of their own.
- The envelope's `modelUsage` could name a model other than the one requested (aliases); the
  adapter does not enforce a match, because a false mismatch would fail every call.
- The two-stage routing gate (`jr benchmark-triage --mode routing`) has not been re-measured on
  this provider.
- The plan's own usage windows (5-hour, weekly) are not tracked; hitting one is an `api_error`.
- The scheduled `daily --assess` needs `JR_ALLOW_MODEL=1` in `~/.config/job-radar/env` and an
  absolute `model.cli.binary` (the unit's `PATH` lacks `~/.local/bin`). `deploy/**` is unchanged.
