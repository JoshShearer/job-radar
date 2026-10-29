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
--strict-mcp-config --no-session-persistence --model <m> [--effort <e>, not on Haiku]
--max-budget-usd <reserve> --json-schema <schema> --system-prompt-file <file>`, the user prompt on
stdin, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed from the child env,
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
`structured_output` missing -> no text block (`invalid_json`); any other error with an envelope ->
`ModelCallError` carrying its usage (`api_error` at that usage); no parseable envelope, timeout,
signal, overflow or a spawn failure -> `api_error` at the reserve. The envelope's prose `result`
is never passed through as the answer: the CLI's own `--json-schema` check is advisory, and the
gateway's Zod validation is the only acceptance.

**The reserve is empirical, not CLI-enforced.** On claude-cli the gateway reserves
`reserve_turns` x (prompt bytes / 3 + `overhead_input_tokens` + `max_output_tokens`) at `PRICING`
(defaults 4 and 4000; 4 is the most turns observed). Nothing makes that a hard ceiling: the
installed CLI has no `--max-turns`, and `--max-budget-usd` is enforced in the CLI's own prices,
which on the observed success were about 9x below ours ($0.00068 against $0.0059 at `PRICING`), so
a cap equal to our reserve admits several times our reserve in our units. What happens when
`--max-budget-usd` is exceeded is unobserved. An overshoot is therefore receipted at its real
usage with the gateway's `WARNING`, and the receipt's `error` carries `turns=N` (also on every
failure), so `reserve_turns` can be re-tuned from the ledger. Streaming the CLI's output and
killing it after `reserve_turns` turns would make the ceiling real; it was considered and not
built (owner decision, JOB-73).

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
