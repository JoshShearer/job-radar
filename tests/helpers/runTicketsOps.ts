import { expect } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * scripts/run-tickets/ticket-ops.mjs is the only writer of a /run-tickets state file and the
 * only thing standing between an agent's return and a merge into main. These tests drive it as
 * the orchestrator does - a subprocess, from a real git lane with a real (bare) remote - so what
 * they pin is the CLI contract, not a function the CLI might stop calling. `gh` is a fake on PATH
 * backed by a JSON file; git is real.
 *
 * Every guard has a test that fails when that guard is deleted, and each such test writes a value
 * that ONLY that guard catches: a fixture an earlier check also refuses would mask the later one.
 */

export const REPO = resolve(__dirname, "..", "..");
export const OPS = resolve(REPO, "scripts", "run-tickets", "ticket-ops.mjs");

export interface Ctx {
  root: string;
  lane: string;
  primary: string;
  state: string;
  env: NodeJS.ProcessEnv;
}

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const f = process.env.FAKE_GH_STATE;
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { prs: {} };
const save = () => fs.writeFileSync(f, JSON.stringify(s));
const a = process.argv.slice(2);
const val = (n) => a[a.indexOf(n) + 1];
if (a[0] === "pr" && a[1] === "view") {
  const pr = s.prs[a[2]];
  const out = {};
  for (const k of val("--json").split(",")) out[k] = pr[k];
  console.log(JSON.stringify(out));
} else if (a[0] === "pr" && a[1] === "edit") {
  s.prs[a[2]].body = fs.readFileSync(0, "utf8"); save();
} else if (a[0] === "pr" && a[1] === "list") {
  console.log(JSON.stringify(Object.entries(s.prs).filter(([, p]) => p.headRefName === val("--head") && p.state === "OPEN")
    .map(([n, p]) => ({ number: Number(n), url: "https://github.com/o/r/pull/" + n, baseRefName: p.baseRefName }))));
} else if (a[0] === "pr" && a[1] === "create") {
  const n = String(Object.keys(s.prs).length + 1);
  s.prs[n] = { state: "OPEN", baseRefName: val("--base"), headRefName: val("--head"), body: val("--body"), title: val("--title"), mergeable: "UNKNOWN" };
  save(); console.log("https://github.com/o/r/pull/" + n);
} else { console.error("fake gh: unsupported " + a.join(" ")); process.exit(1); }
`;

export function sh(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

export function setup(): Ctx {
  const root = mkdtempSync(resolve(tmpdir(), "jr-ops-"));
  const bin = resolve(root, "bin");
  mkdirSync(bin);
  writeFileSync(resolve(bin, "gh"), FAKE_GH);
  chmodSync(resolve(bin, "gh"), 0o755);
  writeFileSync(resolve(root, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    XDG_CONFIG_HOME: resolve(root, "config"),
    GIT_CONFIG_GLOBAL: resolve(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    FAKE_GH_STATE: resolve(root, "gh.json"),
    RUN_TICKETS_MERGE_PAUSE: "0",
  };
  const remote = resolve(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote], { env });
  const primary = resolve(root, "job-radar");
  execFileSync("git", ["clone", "-q", remote, primary], { env });
  writeFileSync(
    resolve(primary, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(Number(process.env.FAIL_TEST||0))"', typecheck: "node -e 0" } }),
  );
  writeFileSync(resolve(primary, "vitest.config.ts"), "export default {};\n");
  mkdirSync(resolve(primary, "src"));
  writeFileSync(resolve(primary, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(resolve(primary, ".gitignore"), ".env\nnode_modules\n");
  sh(primary, env, "add", "-A");
  sh(primary, env, "commit", "-qm", "init");
  sh(primary, env, "push", "-q", "-u", "origin", "main");
  const lane = resolve(root, "job-radar-run-20261008-000000");
  sh(primary, env, "worktree", "add", "-q", "--no-track", "-b", "run/x", lane, "origin/main");
  const state = resolve(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({ runId: "r", stamp: "s", primary, worktree: lane, runBranch: "run/x", baseBranch: "main", manualMerge: false, tickets: [] }),
  );
  const c = { root, lane, primary, state, env };
  // A failing setup must not leak its fixture: afterEach only sees a context setup returned.
  const init = ops(c, ["guard", "--init"]);
  if (init.code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`guard --init failed in setup: ${init.raw}`);
  }
  return c;
}

export function ops(c: Ctx, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}, cwd = c.lane) {
  const r = spawnSync("node", [OPS, "--state", c.state, ...args], {
    cwd,
    env: { ...c.env, ...extraEnv },
    input: input ?? "",
    encoding: "utf8",
  });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split("\n").pop() || "{}"), raw: r.stdout + r.stderr };
}
export const st = (c: Ctx) => JSON.parse(readFileSync(c.state, "utf8"));
export const ticket = (c: Ctx, key = "JOB-1") => st(c).tickets.find((t: { id: string }) => t.id === key);
export const gh = (c: Ctx) => JSON.parse(readFileSync(c.env.FAKE_GH_STATE!, "utf8"));
export const setGh = (c: Ctx, v: unknown) => writeFileSync(c.env.FAKE_GH_STATE!, JSON.stringify(v));
export const setPr = (c: Ctx, patch: Record<string, unknown>) => setGh(c, { prs: { "1": { ...gh(c).prs["1"], ...patch } } });
export const rec = (c: Ctx, phase: string, body: unknown) => ops(c, ["record", "JOB-1", "--phase", phase], JSON.stringify(body));
export const BRANCH = "fix/job-1-fix-the-parser";

export function commitIn(c: Ctx, file: string, content: string, msg = "fix(parser): JOB-1") {
  mkdirSync(resolve(c.lane, file, ".."), { recursive: true });
  writeFileSync(resolve(c.lane, file), content);
  sh(c.lane, c.env, "add", "-A");
  sh(c.lane, c.env, "commit", "-qm", msg);
  return sh(c.lane, c.env, "rev-parse", "HEAD");
}
/** add + start + a committed change on the ticket branch, gated at HEAD. */
export function built(c: Ctx, file = "src/a.ts", content = "export const a = 2;\n") {
  expect(ops(c, ["add", "JOB-1"]).code).toBe(0);
  const s = ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug", description: "d" }));
  expect(s.code).toBe(0);
  const head = commitIn(c, file, content);
  expect(rec(c, "build", { result: "done", gatedSha: head }).code).toBe(0);
  return head;
}
/** Shipped, risk and snapshot taken: ready for a critic return. */
export function shipped(c: Ctx, file?: string) {
  const head = built(c, file);
  expect(ops(c, ["ship", "JOB-1"]).code).toBe(0);
  expect(ops(c, ["risk", "JOB-1"]).code).toBe(0);
  expect(ops(c, ["snapshot", "JOB-1"]).code).toBe(0);
  return head;
}
/** Shipped, then both gates passed on the pushed head; PR head set to it. */
export function graded(c: Ctx, file?: string) {
  const head = shipped(c, file);
  expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(0);
  expect(ops(c, ["snapshot", "JOB-1"]).code).toBe(0);
  expect(rec(c, "verify", { result: "pass", verifyVerdict: "pass", verifiedSha: head }).code).toBe(0);
  setPr(c, { headRefOid: head });
  return head;
}
export function moveBase(c: Ctx) {
  writeFileSync(resolve(c.primary, "other.txt"), `another run merged ${Math.random()}\n`);
  sh(c.primary, c.env, "add", "-A");
  sh(c.primary, c.env, "commit", "-qm", "other");
  sh(c.primary, c.env, "push", "-q", "origin", "main");
}

