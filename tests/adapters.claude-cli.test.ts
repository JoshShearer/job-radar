import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildInvocation,
  checkCwd,
  ClaudeCliClient,
  mapEnvelope,
  nodeRunner,
  resolveBinary,
  type RunInput,
  type RunResult,
} from "../src/adapters/claude-cli/client.js";
import { ModelCallError, type ModelRequest } from "../src/ports/io.js";
import { FAKE_ANTHROPIC_API_KEY, FAKE_ANTHROPIC_AUTH_TOKEN } from "./fixtures/fake-credentials.js";

/**
 * The claude-cli adapter, without ever spawning the real `claude`: a call
 * through it spends subscription quota. The runner is a fake; the real
 * runner is exercised against `process.execPath` scripts only.
 */
const FIX = resolve(import.meta.dirname, "fixtures/claude-cli");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "claude-sonnet-5",
  effort: "high",
  maxOutputTokens: 2000,
  system: "You are a test.",
  user: "Say hi.",
  jsonSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  maxBudgetUsd: 0.25,
  ...over,
});

const opts = { binary: "/opt/claude/bin/claude", cwd: "/home/x/data/claude-cli-cwd", timeoutMs: 1000 };
const SYS = "/home/x/data/claude-cli-prompts/system-1.txt";
const ran = (stdout: string, code: number | null = 0, more: Partial<RunResult> = {}): RunResult => ({
  code,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  overflow: false,
  ...more,
});

describe("claude-cli invocation", () => {
  it("pins the exact argv: no tools, no setting sources, safe mode, strict MCP, no session, our system prompt and schema", () => {
    const inv = buildInvocation(req(), { ...opts, baseEnv: {} }, SYS);
    expect(inv.binary).toBe("/opt/claude/bin/claude");
    expect(inv.argv).toEqual([
      "-p",
      "--output-format", "json",
      "--safe-mode",
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", "claude-sonnet-5",
      "--effort", "high",
      "--max-budget-usd", "0.250000",
      "--json-schema", JSON.stringify(req().jsonSchema),
      "--system-prompt-file", SYS,
    ]);
    // Argv is world-readable (/proc/<pid>/cmdline): no prompt text in it.
    expect(inv.argv.join("\n")).not.toContain("You are a test.");
    expect(inv.argv.join("\n")).not.toContain("Say hi.");
    expect(inv.argv).not.toContain("--system-prompt");
    expect(inv.stdin).toBe("Say hi.");
    expect(inv.cwd).toBe(opts.cwd);
    expect(inv.argv).not.toContain("--bare");
    expect(inv.argv).not.toContain("--fallback-model");
  });

  it("omits --effort on Haiku, which rejects it", () => {
    const inv = buildInvocation(req({ model: "claude-haiku-5-5" }), { ...opts, baseEnv: {} }, SYS);
    expect(inv.argv).not.toContain("--effort");
  });

  it("strips API credentials from the child env and caps output tokens at max_output_tokens", () => {
    const inv = buildInvocation(req(), {
      ...opts,
      baseEnv: { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: FAKE_ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "99" },
    }, SYS);
    expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect("ANTHROPIC_API_KEY" in inv.env).toBe(false);
    expect(inv.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("2000");
    expect(inv.env.PATH).toBe("/usr/bin");
    expect(inv.env.HOME).toBe("/home/x");
  });

  it("refuses an argv element over the kernel's per-argument limit rather than spawning", () => {
    // A long system prompt is fine: it is in a file, not argv.
    expect(() => buildInvocation(req({ system: "x".repeat(200 * 1024) }), { ...opts, baseEnv: {} }, SYS)).not.toThrow();
    const bigSchema = { type: "object", description: "y".repeat(200 * 1024) };
    expect(() => buildInvocation(req({ jsonSchema: bigSchema }), { ...opts, baseEnv: {} }, SYS)).toThrow(/too large/);
  });
});

describe("claude-cli envelope mapping (shape only; the gateway classifies)", () => {
  it("success: structured_output becomes the text block, usage passes through, turns are carried", () => {
    const r = mapEnvelope(ran(fixture("success.observed.json"))) as Record<string, unknown>;
    expect(r.stop_reason).toBe("end_turn");
    expect(r.content).toEqual([{ type: "text", text: JSON.stringify({ answer: "hi", score: 5 }) }]);
    expect(r.usage).toMatchObject({ input_tokens: 2, cache_creation_input_tokens: 1156, cache_read_input_tokens: 0, output_tokens: 891 });
    expect(r.num_turns).toBe(2);
  });

  it("the output-token-maximum error (exit 1) maps to max_tokens with its usage", () => {
    const r = mapEnvelope(ran(fixture("truncation.observed.json"), 1)) as Record<string, unknown>;
    expect(r.stop_reason).toBe("max_tokens");
    expect((r.usage as { output_tokens: number }).output_tokens).toBe(1200);
    expect(r.num_turns).toBe(4);
  });

  it("a refusal maps to stop_reason refusal (synthetic fixture)", () => {
    const r = mapEnvelope(ran(fixture("refusal.synthetic.json"))) as Record<string, unknown>;
    expect(r.stop_reason).toBe("refusal");
  });

  it("missing structured_output gives no text block (the gateway receipts invalid_json), even when result has prose", () => {
    const env = { ...JSON.parse(fixture("success.observed.json")), structured_output: null, result: '{"answer":"hi","score":5}' };
    const r = mapEnvelope(ran(JSON.stringify(env))) as { content: unknown[] };
    expect(r.content).toEqual([]);
  });

  it("any other error throws a ModelCallError that carries the usage it reported, and the turn count", () => {
    let caught: unknown;
    try {
      mapEnvelope(ran(fixture("error.synthetic.json"), 1));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModelCallError);
    const e = caught as ModelCallError;
    expect(e.message).toMatch(/429|usage limit/);
    expect(e.message).toMatch(/turns 1/);
    expect((e.response as { usage: { input_tokens: number } }).usage.input_tokens).toBe(120);
  });

  it("a non-zero exit with a success-shaped envelope is still an error", () => {
    expect(() => mapEnvelope(ran(fixture("success.observed.json"), 2))).toThrow(ModelCallError);
  });

  it("unparseable stdout, a timeout, a signal and an overflow throw a plain Error (settled at the reserve)", () => {
    const plain = (r: RunResult) => {
      try {
        mapEnvelope(r);
      } catch (e) {
        return e instanceof Error && !(e instanceof ModelCallError);
      }
      return false;
    };
    expect(plain(ran("not json", 1))).toBe(true);
    expect(plain(ran("", 0))).toBe(true);
    expect(plain(ran(fixture("success.observed.json"), null, { timedOut: true, signal: "SIGTERM" }))).toBe(true);
    expect(plain(ran(fixture("success.observed.json"), null, { signal: "SIGKILL" }))).toBe(true);
    expect(plain(ran(fixture("success.observed.json"), 0, { overflow: true }))).toBe(true);
  });
});

describe("ClaudeCliClient", () => {
  const promptDir = () => {
    const d = join(mkdtempSync(join(tmpdir(), "jr-prompts-")), "claude-cli-prompts");
    mkdirSync(d, { mode: 0o700 });
    return d;
  };
  const sysFile = (i: RunInput) => i.argv[i.argv.indexOf("--system-prompt-file") + 1]!;

  it("passes the system prompt in a 0600 file it removes after success, error, timeout and a spawn failure", async () => {
    const outcomes: Array<[string, () => Promise<RunResult>]> = [
      ["success", async () => ran(fixture("success.observed.json"))],
      ["cli error", async () => ran(fixture("error.synthetic.json"), 1)],
      ["timeout", async () => ran("", null, { timedOut: true, signal: "SIGTERM" })],
      ["spawn failure", async () => Promise.reject(new Error("spawn /x ENOENT"))],
    ];
    for (const [name, result] of outcomes) {
      const dir = promptDir();
      // Observed inside the runner, asserted outside it: create() swallows nothing,
      // but an expect() thrown in the runner would be caught by the .catch below.
      let seen: { file: string; content: string | null; mode: number; argv: string; stdin: string } | null = null;
      const client = new ClaudeCliClient({
        ...opts,
        promptDir: dir,
        baseEnv: {},
        runner: async (i) => {
          const at = i.argv.indexOf("--system-prompt-file");
          const file = at >= 0 ? i.argv[at + 1]! : "";
          const present = file !== "" && existsSync(file);
          seen = { file, content: present ? readFileSync(file, "utf8") : null, mode: present ? statSync(file).mode & 0o777 : -1, argv: i.argv.join("\n"), stdin: i.stdin };
          return result();
        },
      });
      await client.create(req()).catch(() => null);
      expect(seen, name).not.toBeNull();
      const s = seen!;
      expect(s.file.startsWith(dir + "/"), name).toBe(true);
      expect(s.content, name).toBe("You are a test.");
      expect(s.mode, name).toBe(0o600);
      expect(s.argv, name).not.toContain("You are a test.");
      expect(s.stdin, name).toBe("Say hi.");
      expect(existsSync(s.file), name).toBe(false);
      expect(readdirSync(dir), name).toEqual([]);
    }
  });

  it("runs one invocation through the injected runner and maps its envelope", async () => {
    const seen: RunInput[] = [];
    const client = new ClaudeCliClient({
      ...opts,
      promptDir: promptDir(),
      baseEnv: { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_API_KEY, PATH: "/usr/bin" },
      runner: async (i) => {
        seen.push(i);
        return ran(fixture("success.observed.json"));
      },
    });
    const r = (await client.create(req())) as { stop_reason: string };
    expect(r.stop_reason).toBe("end_turn");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.timeoutMs).toBe(1000);
    expect(seen[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("nodeRunner (against process.execPath only, never claude)", () => {
  const base = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 };

  it("writes the prompt on stdin, closes it, and captures stdout and the exit code", async () => {
    const r = await nodeRunner({
      ...base,
      binary: process.execPath,
      argv: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.stringify({got:s}));process.exit(3)})"],
      stdin: "hello -p --flag",
    });
    expect(JSON.parse(r.stdout)).toEqual({ got: "hello -p --flag" });
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it("kills a child that outlives its timeout", async () => {
    const r = await nodeRunner({ ...base, binary: process.execPath, argv: ["-e", "setInterval(()=>{},1000)"], stdin: "", timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it("rejects when the binary does not exist", async () => {
    await expect(nodeRunner({ ...base, binary: "/nonexistent/claude", argv: [], stdin: "" })).rejects.toThrow(/ENOENT/);
  });
});

describe("binary and working directory", () => {
  it("resolves an absolute executable, refuses a missing one, and searches PATH for a bare name", () => {
    expect(resolveBinary(process.execPath, "")).toBe(process.execPath);
    expect(resolveBinary("/nonexistent/claude", "")).toBeNull();
    expect(resolveBinary("node", dirname(process.execPath))).toBe(join(dirname(process.execPath), "node"));
    expect(resolveBinary("definitely-not-a-binary-jr", dirname(process.execPath))).toBeNull();
    expect(resolveBinary("bin/claude", "/usr/bin")).toBeNull();
  });

  it("creates the stable cwd as an empty 0700 directory, and refuses one that is not empty or is a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "jr-cwd-"));
    const dir = join(root, "data", "claude-cli-cwd");
    expect(checkCwd(dir)).toBeNull();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "CLAUDE.md"), "planted");
    expect(checkCwd(dir)).toMatch(/not empty/);
    const real = join(root, "elsewhere");
    mkdirSync(real);
    const link = join(root, "link-cwd");
    symlinkSync(real, link);
    expect(checkCwd(link)).toMatch(/symlink/);
    // The prompt directory need not be empty, but must still be ours and private.
    expect(checkCwd(dir, false)).toBeNull();
    expect(checkCwd(link, false)).toMatch(/symlink/);
  });
});
