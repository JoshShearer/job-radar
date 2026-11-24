import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { compose } from "../src/ui/compose.js";
import { callModel, NoModelConfigured } from "../src/app/gateway.js";
import { ClaudeCliClient, type RunInput } from "../src/adapters/claude-cli/client.js";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { fill } from "../src/app/fill.js";
import { applicationViews } from "../src/app/pursuit.js";
import { withRun } from "../src/app/run.js";
import { FixedClock } from "../src/kernel/clock.js";
import { FakeBrowser, FakeTransport, GH_ACME, ghBoard, TEST_EVIDENCE } from "./helpers/context.js";
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

/** JOB-81: the retention limit reaches both writers, and an invalid config never costs the human their typed answers. */
describe("config backup retention wiring", () => {
  const V1 = ["2026-08-14T19-30-00", "2026-08-15T09-00-01", "2026-08-19T23-59-59"].map((t) => `personal.yaml.${t}.bak`);
  const answer = (i: number) => [{ match: `question ${i}?`, answer: `answer ${i}` }];
  const env = (h: string) => ({ PATH: process.env.PATH ?? "", JR_HOME: h, JR_ALLOW_MODEL: "", ANTHROPIC_API_KEY: "" });
  const baks = (h: string, base: string) => readdirSync(join(h, "config/candidate")).filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"));
  const open = (h: string, over: Parameters<typeof compose>[1] = {}) => {
    const logs: string[] = [];
    const rt = compose(env(h), { log: (l) => logs.push(l), clock: new FixedClock("2027-01-01T00:00:00.000Z"), ...over });
    return { rt, logs };
  };
  const breakConfig = (h: string) => writeFileSync(join(h, "config/operations.yaml"), readFileSync(join(h, "config/operations.yaml"), "utf8") + "\nnot_a_key: 1\n");

  it.each([2, 3])("config_backups.keep %i is what both writers keep; config/ root backups with the v1 name are untouched", (keep) => {
    const h = home((o) => (o.config_backups = { keep }));
    for (const n of V1) writeFileSync(join(h, "config", n), "v1");
    const { rt, logs } = open(h);
    for (let i = 0; i < 6; i++) rt.ctx.saveLearnedAnswers(answer(i));
    for (let i = 0; i < 6; i++) rt.ctx.saveEvidence(TEST_EVIDENCE);
    rt.close();
    expect(baks(h, "personal.yaml")).toHaveLength(keep);
    expect(baks(h, "evidence.yaml")).toHaveLength(keep);
    for (const n of V1) expect(readFileSync(join(h, "config", n), "utf8")).toBe("v1");
    expect(logs).toEqual([]);
  });

  it("a failed prune from either writer is reported through the runtime's log", () => {
    const h = home((o) => (o.config_backups = { keep: 1 }));
    for (const base of ["personal.yaml", "evidence.yaml"]) mkdirSync(join(h, "config/candidate", `${base}.2025-01-01T00-00-00.bak`));
    const { rt, logs } = open(h);
    rt.ctx.saveLearnedAnswers(answer(0));
    rt.ctx.saveEvidence(TEST_EVIDENCE);
    rt.close();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/could not prune.*personal\.yaml\.2025/);
    expect(logs[1]).toMatch(/could not prune.*evidence\.yaml\.2025/);
  });

  it.each([
    ["an unknown key in operations.yaml", breakConfig],
    ["keep 0", (h: string) => writeFileSync(join(h, "config/operations.yaml"), stringify({ ...parse(readFileSync(join(h, "config/operations.yaml"), "utf8")), config_backups: { keep: 0 } }))],
    ["operations.yaml that is not YAML", (h: string) => writeFileSync(join(h, "config/operations.yaml"), "a: [")],
    ["an invalid sources.yaml", (h: string) => writeFileSync(join(h, "config/sources.yaml"), "nope: 1\n")],
  ])("with %s, both writers still save, delete no backup, and say why", (_n, spoil) => {
    const h = home();
    spoil(h);
    for (const t of ["personal.yaml", "evidence.yaml"]) for (let i = 10; i < 22; i++) writeFileSync(join(h, "config/candidate", `${t}.2026-08-14T19-30-${i}.bak`), "old");
    const { rt, logs } = open(h);
    expect(existsSync(rt.ctx.saveLearnedAnswers(answer(1))!)).toBe(true);
    expect(existsSync(rt.ctx.saveEvidence(TEST_EVIDENCE)!)).toBe(true);
    rt.close();
    expect(readFileSync(join(h, "config/candidate/personal.yaml"), "utf8")).toContain("question 1?");
    expect(readFileSync(join(h, "config/candidate/evidence.yaml"), "utf8")).toContain(TEST_EVIDENCE.experience[0]!.id);
    expect(baks(h, "personal.yaml")).toHaveLength(13);
    expect(baks(h, "evidence.yaml")).toHaveLength(13);
    expect(logs).toHaveLength(2);
    for (const l of logs) expect(l).toMatch(/WARNING.*no old backups were deleted.*\.yaml/s);
  });

  it("a config file broken before `fill` costs neither the typed answers nor the submission prompt", async () => {
    const h = home((o) => (o.model.provider = "api"));
    const clock = new FixedClock("2026-10-01T12:00:00.000Z");
    const src = join(h, "config/sources.yaml");
    const sources = parse(readFileSync(src, "utf8"));
    sources.sources.greenhouse = { ...sources.sources.greenhouse, enabled: true, boards: [{ token: "acme", company: "Acme" }] };
    sources.sources.lever.boards = [];
    sources.sources.ashby.boards = [];
    sources.sources.remoteok.enabled = false;
    sources.watchlist = [];
    writeFileSync(src, stringify(sources));
    const transport = new FakeTransport({ [GH_ACME]: () => ghBoard([{ id: 1, title: "Senior Software Engineer" }]) });
    const first = open(h, { clock, transport }).rt;
    const runId = first.ctx.store.startRun("sweep", clock.now().toISOString());
    await sweep(first.ctx, runId);
    evaluate(first.ctx, runId);
    const id = first.ctx.store.ranking()[0]!.opportunityId;
    first.close();

    breakConfig(h);
    const asked: string[] = [];
    const { rt, logs } = open(h, {
      clock,
      browser: new FakeBrowser([{ label: "What is your favourite editor?", intent: "question", kind: "text", value: "Vim, since 2009" }]),
      prompter: {
        confirm: async (q) => {
          asked.push(q);
          return true;
        },
      },
    });
    expect(() => rt.ctx.config()).toThrow(/not_a_key/); // the premise: this config is refused
    const r = await withRun(rt.ctx, "fill", (run) => fill(rt.ctx, run, id));
    expect(r.outcome).toBe("ok");
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/Did you submit it yourself/);
    expect(r.value.submittedRecorded).toBe(true);
    expect(applicationViews(rt.ctx)).toHaveLength(1);
    expect(readFileSync(join(h, "config/candidate/personal.yaml"), "utf8")).toContain("Vim, since 2009");
    expect(logs.join("\n")).toMatch(/WARNING.*not_a_key/s);
    rt.close();
  });
});
