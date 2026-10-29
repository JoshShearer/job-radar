import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ModelCallError, type ModelClient, type ModelRequest } from "../../ports/io.js";
import { supportsEffort } from "../../domain/llm/models.js";

/**
 * The paid model through the Claude Code CLI (`claude -p`) on the claude.ai
 * subscription. Like AnthropicClient it owns nothing but the request shape:
 * budgets, receipts, caching and validation live in the gateway
 * (app/gateway.ts), the only caller. Whether this client may exist at all
 * (JR_ALLOW_MODEL, a resolvable binary, a clean cwd) is decided in
 * ui/compose.ts. See docs/adr/0004.
 *
 * It maps the CLI's result envelope onto the API's response shape and
 * classifies nothing: the gateway decides truncated / refusal / invalid_json /
 * schema / success exactly as it does for the API. The CLI's own --json-schema
 * check is advisory; the gateway's Zod validation is the only acceptance.
 *
 * The system prompt goes in a 0600 file passed by `--system-prompt-file`,
 * never in argv, which any local user can read from /proc/<pid>/cmdline. The
 * file lives in a 0700 prompt directory beside (not inside) the empty cwd, and
 * is deleted after the call whatever its outcome. The user prompt goes on
 * stdin. `--json-schema` has no file form, so the schema (a structural
 * description, not candidate text) stays in argv.
 *
 * Never `--bare`: it reads only ANTHROPIC_API_KEY / apiKeyHelper, never OAuth,
 * so it cannot bill the subscription. `--safe-mode` instead disables CLAUDE.md,
 * hooks, plugins, skills and MCP servers while keeping auth.
 */

export interface RunInput {
  binary: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout or stderr passed its cap and was cut. */
  overflow: boolean;
}

/** Spawns one process. Injected so tests never run the real `claude`. */
export type Runner = (input: RunInput) => Promise<RunResult>;

export interface ClaudeCliOptions {
  /** Absolute path (compose resolves it before building the client). */
  binary: string;
  cwd: string;
  /** A 0700 directory we own, for the per-call system prompt file. Not the cwd, which stays empty. */
  promptDir: string;
  timeoutMs: number;
  /**
   * `--max-turns`: model.cli.reserve_turns, the same number the gateway
   * multiplies its reserve by, so the CLI stops where the reserve stops.
   */
  maxTurns: number;
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** Linux MAX_ARG_STRLEN is 128 KiB per argv element; stay under it. */
const MAX_ARG_BYTES = 100 * 1024;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * The only variables the child may inherit: what the CLI needs to find the
 * owner's OAuth login (HOME or CLAUDE_CONFIG_DIR, where .credentials.json
 * lives) and to run (PATH, the user, locale, terminal, temp and XDG dirs).
 * Everything else is dropped: ANTHROPIC_* (API keys, ANTHROPIC_BASE_URL),
 * CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY (which would bill a third-party
 * provider while the ledger says subscription), CLAUDECODE and other nested-
 * session markers, JR_ALLOW_MODEL, JR_HOME, JOB_RADAR_* / GMAIL_* and any
 * other .env secret, proxies and NODE_OPTIONS. An allowlist, not a denylist:
 * a variable this list has never heard of cannot change where a call bills.
 */
const CHILD_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TMPDIR",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
]);

/** The child's environment: the allowlisted part of `base`, plus the output-token cap. Pure. */
export function childEnv(base: NodeJS.ProcessEnv | Record<string, string | undefined>, maxOutputTokens: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (CHILD_ENV_KEYS.has(k) || k.startsWith("LC_"))) env[k] = v;
  }
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return env;
}

/** The exact process to run for one request, given where its system prompt file is. Pure. */
export function buildInvocation(req: ModelRequest, o: Omit<ClaudeCliOptions, "promptDir">, systemPromptFile: string): RunInput {
  const argv = [
    "-p",
    "--output-format", "json",
    "--safe-mode",
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns", String(o.maxTurns),
    "--model", req.model,
    ...(supportsEffort(req.model) ? ["--effort", req.effort] : []),
    "--max-budget-usd", req.maxBudgetUsd.toFixed(6),
    "--json-schema", JSON.stringify(req.jsonSchema),
    "--system-prompt-file", systemPromptFile,
  ];
  for (const a of argv) {
    const bytes = Buffer.byteLength(a, "utf8");
    if (bytes > MAX_ARG_BYTES) throw new Error(`claude CLI argument too large (${bytes} bytes, limit ${MAX_ARG_BYTES}); nothing was run`);
  }
  const env = childEnv(o.baseEnv, req.maxOutputTokens);
  // The user prompt goes on stdin: it can exceed one argv element, and a
  // leading dash in it can never be parsed as a flag.
  return { binary: o.binary, argv, env, cwd: o.cwd, stdin: req.user, timeoutMs: o.timeoutMs };
}

const TRUNCATED = /exceeded the \d+ output token maximum/;
/**
 * The CLI's `--max-turns` early exit. Its JSON envelope has not been observed:
 * the binary's SDK schema names subtype `error_max_turns` with
 * `errors: ["Reached maximum number of turns (N)"]`, and its text elsewhere
 * says "reached its --max-turns limit", so any of those marks it.
 */
const MAX_TURNS = /max[-_ ]turns|maximum number of turns/i;

/**
 * The CLI's result envelope as the API's response shape. Throws a plain Error
 * when nothing usable came back (the gateway settles at the reserve), and a
 * ModelCallError when the CLI failed but reported its usage.
 */
export function mapEnvelope(run: RunResult): unknown {
  if (run.timedOut) throw new Error(`claude CLI timed out after ${run.signal ?? "kill"}; usage unknown`);
  if (run.overflow) throw new Error("claude CLI output exceeded its capture limit; usage unknown");
  if (run.signal) throw new Error(`claude CLI was killed by ${run.signal}; usage unknown`);
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    env = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`claude CLI output was not a JSON envelope (exit ${run.code}): ${(run.stderr || run.stdout).slice(0, 300)}`);
  }
  const base = { usage: env.usage, num_turns: env.num_turns };
  const result = typeof env.result === "string" ? env.result : "";
  if (env.stop_reason === "refusal") return { stop_reason: "refusal", content: [], ...base };
  const failed = env.is_error === true || run.code !== 0 || (env.api_error_status !== null && env.api_error_status !== undefined);
  const errors = Array.isArray(env.errors) ? env.errors.filter((e): e is string => typeof e === "string") : [];
  const text = [result, ...errors].join("\n");
  if (env.subtype === "error_max_turns" || (failed && MAX_TURNS.test(text))) {
    // Checked before truncation: a run that spent its turns on truncation
    // retries stopped because of the turn limit, and is an error at its usage.
    throw new ModelCallError(
      `claude CLI stopped at its --max-turns limit (exit ${run.code}, turns ${String(env.num_turns ?? "?")}): ${text.slice(0, 300)}`,
      base,
    );
  }
  if (failed) {
    if (TRUNCATED.test(text)) return { stop_reason: "max_tokens", content: [], ...base };
    const why = String(env.terminal_reason ?? env.subtype ?? "error");
    throw new ModelCallError(`claude CLI error (exit ${run.code}, ${why}, turns ${String(env.num_turns ?? "?")}): ${text.slice(0, 300)}`, base);
  }
  // No structured_output: no text block, so the gateway receipts invalid_json.
  // The prose `result` is deliberately not passed through (ADR-0004).
  if (env.structured_output === null || env.structured_output === undefined) return { stop_reason: "end_turn", content: [], ...base };
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(env.structured_output) }], ...base };
}

export class ClaudeCliClient implements ModelClient {
  constructor(private readonly o: ClaudeCliOptions & { runner: Runner }) {}

  async create(req: ModelRequest): Promise<unknown> {
    const file = join(this.o.promptDir, `system-${randomUUID()}.txt`);
    // wx: never follow or reuse an existing path; 0600: only this user reads it.
    writeFileSync(file, req.system, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      return mapEnvelope(await this.o.runner(buildInvocation(req, this.o, file)));
    } finally {
      rmSync(file, { force: true });
    }
  }
}

/** The real runner: child_process.spawn, prompt on stdin, capped capture, SIGTERM then SIGKILL at the timeout. */
export const nodeRunner: Runner = (i) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(i.binary, i.argv, { cwd: i.cwd, env: i.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, i.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length + d.length > MAX_STDOUT_BYTES) overflow = true;
      else stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length + d.length > MAX_STDERR_BYTES) overflow = true;
      else stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolvePromise({ code, signal, stdout, stderr, timedOut, overflow });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(i.stdin);
  });

/** The binary as an absolute executable path, or null. Spawns nothing. */
export function resolveBinary(binary: string, pathEnv: string): string | null {
  const executable = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return lstatSync(p).isDirectory() ? null : p;
    } catch {
      return null;
    }
  };
  if (binary.includes("/")) return binary.startsWith("/") ? executable(binary) : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir.startsWith("/")) continue;
    const hit = executable(join(dir, binary));
    if (hit) return hit;
  }
  return null;
}

/**
 * Make sure the CLI's working directory (or, with requireEmpty false, the
 * prompt directory) is ours, creating it 0700, and for the cwd empty.
 * The CLI tells the model its cwd and would auto-discover a CLAUDE.md there,
 * so a directory someone else could write to is refused. Returns the problem, or null.
 */
export function checkCwd(dir: string, requireEmpty = true): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return `${dir} is a symlink; the claude CLI's working directory must be a real directory`;
    if (!st.isDirectory()) return `${dir} is not a directory`;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${dir} is not owned by this user`;
    if ((st.mode & 0o077) !== 0) return `${dir} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}); expected 700`;
    const entries = readdirSync(dir);
    if (requireEmpty && entries.length) return `${dir} is not empty (${entries.slice(0, 3).join(", ")}); the claude CLI must run in an empty directory`;
    return null;
  } catch (err) {
    return `${dir}: ${(err as Error).message}`;
  }
}
