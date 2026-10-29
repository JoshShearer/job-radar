import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { compose } from "../src/ui/compose.js";
import { callModel, NoModelConfigured } from "../src/app/gateway.js";
import { ClaudeCliClient, type RunInput } from "../src/adapters/claude-cli/client.js";
import { FAKE_ANTHROPIC_API_KEY } from "./fixtures/fake-credentials.js";

/**
 * The provider policy lives in the composition root: which client exists,
 * and whether one may exist at all. A lane must never spend subscription
 * quota, so every refusal here is pinned with zero spawns and zero receipts.
 */
const ROOT = resolve(import.meta.dirname, "..");
const FIX = resolve(import.meta.dirname, "fixtures/claude-cli");

function home(edit?: (ops: Record<string, any>) => void): string {
  const h = mkdtempSync(join(tmpdir(), "jr-compose-"));
  cpSync(resolve(ROOT, "config.example"), join(h, "config"), { recursive: true });
  const file = join(h, "config/operations.yaml");
  const ops = parse(readFileSync(file, "utf8"));
  edit?.(ops);
  writeFileSync(file, stringify(ops));
  return h;
}

function setup(env: Record<string, string>, edit?: (ops: Record<string, any>) => void) {
  const h = home(edit);
  const spawns: RunInput[] = [];
  const rt = compose(
    { PATH: process.env.PATH ?? "", JR_HOME: h, JR_ALLOW_MODEL: "", ANTHROPIC_API_KEY: "", ...env },
    {
      log: () => {},
      runner: async (i) => {
        spawns.push(i);
        return { code: 0, signal: null, stdout: readFileSync(join(FIX, "success.reconstructed.json"), "utf8"), stderr: "", timedOut: false, overflow: false };
      },
    },
  );
  return { rt, h, spawns };
}

const schema = z.object({ answer: z.string(), score: z.number().int() }).strict();
const call = (rt: ReturnType<typeof compose>) =>
  callModel(rt.ctx, {
    kind: "test:compose",
    purpose: "test",
    subjectId: null,
    runId: null,
    choice: { model: "claude-haiku-5-5", effort: "medium", max_output_tokens: 2000 },
    prompt: { system: "s", user: "u" },
    schema,
  });

describe("model provider composition", () => {
  it("config.example selects claude-cli, and without JR_ALLOW_MODEL=1 no client exists: nothing spawned, nothing reserved", async () => {
    const { rt, spawns } = setup({});
    const p = rt.ctx.modelProvider();
    expect(p.provider).toBe("claude-cli");
    expect(p.available).toBe(false);
    expect(p.reason).toMatch(/JR_ALLOW_MODEL/);
    expect(rt.ctx.modelClient()).toBeNull();
    await expect(call(rt)).rejects.toBeInstanceOf(NoModelConfigured);
    await expect(call(rt)).rejects.toThrow(/JR_ALLOW_MODEL/);
    expect(spawns).toHaveLength(0);
    expect(rt.ctx.store.modelCalls()).toHaveLength(0);
    rt.close();
  });

  it("JR_ALLOW_MODEL=1 with a missing binary is unavailable BEFORE any reservation (no orphaned worst-case receipts)", async () => {
    const { rt, spawns } = setup({ JR_ALLOW_MODEL: "1" }, (o) => (o.model.cli = { binary: "/nonexistent/claude" }));
    const p = rt.ctx.modelProvider();
    expect(p.available).toBe(false);
    expect(p.reason).toMatch(/\/nonexistent\/claude/);
    expect(rt.ctx.modelClient()).toBeNull();
    await expect(call(rt)).rejects.toBeInstanceOf(NoModelConfigured);
    expect(spawns).toHaveLength(0);
    expect(rt.ctx.store.modelCalls()).toHaveLength(0);
    rt.close();
  });

  it("JR_ALLOW_MODEL=1 with an executable binary builds a ClaudeCliClient and spawns nothing until a call", () => {
    const { rt, spawns } = setup({ JR_ALLOW_MODEL: "1" }, (o) => (o.model.cli = { binary: process.execPath }));
    expect(rt.ctx.modelProvider().available).toBe(true);
    expect(rt.ctx.modelClient()).toBeInstanceOf(ClaudeCliClient);
    expect(spawns).toHaveLength(0);
    rt.close();
  });

  it("a real call through the gateway runs in the empty cwd under the data dir and receipts the provider", async () => {
    const { rt, h, spawns } = setup({ JR_ALLOW_MODEL: "1", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_API_KEY }, (o) => (o.model.cli = { binary: process.execPath }));
    const r = await call(rt);
    expect(r.value).toEqual({ answer: "hi", score: 5 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cwd).toBe(join(h, "data", "claude-cli-cwd"));
    expect(spawns[0]!.binary).toBe(process.execPath);
    expect(spawns[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    const sys = spawns[0]!.argv[spawns[0]!.argv.indexOf("--system-prompt-file") + 1]!;
    expect(sys.startsWith(join(h, "data", "claude-cli-prompts") + "/")).toBe(true);
    expect(existsSync(sys)).toBe(false);
    expect(readdirSync(join(h, "data", "claude-cli-cwd"))).toEqual([]);
    const [c] = rt.ctx.store.modelCalls();
    expect(c!.provider).toBe("claude-cli");
    expect(c!.outcome).toBe("success");
    expect(c!.usage).toEqual({ input: 2, cacheWrite: 1156, cacheRead: 0, output: 891 });
    expect(c!.actualUsd!).toBeLessThanOrEqual(c!.reservedUsd);
    rt.close();
  });

  it("the child process gets only the allowlisted env, and --max-turns equal to model.cli.reserve_turns", async () => {
    const { rt, spawns } = setup(
      { JR_ALLOW_MODEL: "1", HOME: "/home/probe", CLAUDECODE: "1", JOB_RADAR_CONTACT: "someone", GMAIL_CLIENT_SECRET: "fake", ANTHROPIC_MODEL: "claude-other" },
      (o) => (o.model.cli = { binary: process.execPath, reserve_turns: 3 }),
    );
    await call(rt);
    expect(spawns).toHaveLength(1);
    const env = spawns[0]!.env;
    for (const k of ["JR_ALLOW_MODEL", "JR_HOME", "CLAUDECODE", "JOB_RADAR_CONTACT", "GMAIL_CLIENT_SECRET", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"]) expect(k in env, k).toBe(false);
    expect(env.HOME).toBe("/home/probe");
    expect(env.PATH).toBe(process.env.PATH ?? "");
    const argv = spawns[0]!.argv;
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("3");
    expect(rt.ctx.store.modelCalls()[0]!.reservedUsd).toBeGreaterThan(0);
    rt.close();
  });

  for (const v of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL"]) {
    it(`claude-cli is unavailable when ${v} is set in jr's env (the owner's shell would bill elsewhere): nothing spawned, nothing reserved`, async () => {
      const { rt, spawns } = setup({ JR_ALLOW_MODEL: "1", [v]: v === "ANTHROPIC_BASE_URL" ? "https://example.invalid" : "1" }, (o) => (o.model.cli = { binary: process.execPath }));
      const p = rt.ctx.modelProvider();
      expect(p.available).toBe(false);
      expect(p.reason).toContain(v);
      expect(rt.ctx.modelClient()).toBeNull();
      await expect(call(rt)).rejects.toBeInstanceOf(NoModelConfigured);
      expect(spawns).toHaveLength(0);
      expect(rt.ctx.store.modelCalls()).toHaveLength(0);
      rt.close();
    });
  }

  it("the api provider is unchanged: no key, no client, the same reason", async () => {
    const { rt, spawns } = setup({}, (o) => (o.model.provider = "api"));
    const p = rt.ctx.modelProvider();
    expect(p.provider).toBe("api");
    expect(p.available).toBe(false);
    expect(p.reason).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(rt.ctx.modelClient()).toBeNull();
    expect(spawns).toHaveLength(0);
    rt.close();
  });

  it("the api provider ignores JR_ALLOW_MODEL", () => {
    const { rt } = setup({ ANTHROPIC_API_KEY: FAKE_ANTHROPIC_API_KEY }, (o) => (o.model.provider = "api"));
    expect(rt.ctx.modelProvider().available).toBe(true);
    expect(rt.ctx.modelClient()).not.toBeNull();
    rt.close();
  });
});
