import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * scripts/run-tickets/ticket-ops.mjs is the only writer of a /run-tickets state file and the
 * only thing standing between an agent's return and a merge into main. These tests drive it as
 * the orchestrator does - a subprocess, from a real git lane with a real (bare) remote - so what
 * they pin is the CLI contract, not a function the CLI might stop calling. `gh` is a fake on PATH
 * backed by a JSON file; git is real.
 */

const OPS = resolve(__dirname, "..", "scripts", "run-tickets", "ticket-ops.mjs");

interface Ctx {
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

function sh(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function setup(): Ctx {
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
  };
  const remote = resolve(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote], { env });
  const primary = resolve(root, "job-radar");
  execFileSync("git", ["clone", "-q", remote, primary], { env });
  writeFileSync(
    resolve(primary, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"process.exit(Number(process.env.FAIL_TEST||0))\"", typecheck: "node -e 0" } }),
  );
  mkdirSync(resolve(primary, "src"));
  writeFileSync(resolve(primary, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(resolve(primary, ".gitignore"), ".env\n");
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
  return { root, lane, primary, state, env };
}

function ops(c: Ctx, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}, cwd = c.lane) {
  const r = spawnSync("node", [OPS, "--state", c.state, ...args], {
    cwd,
    env: { ...c.env, ...extraEnv },
    input: input ?? "",
    encoding: "utf8",
  });
  return { code: r.status, out: JSON.parse(r.stdout.trim().split("\n").pop() || "{}"), raw: r.stdout + r.stderr };
}
const st = (c: Ctx) => JSON.parse(readFileSync(c.state, "utf8"));
const ticket = (c: Ctx, key = "JOB-1") => st(c).tickets.find((t: { id: string }) => t.id === key);
const gh = (c: Ctx) => JSON.parse(readFileSync(c.env.FAKE_GH_STATE!, "utf8"));
const setGh = (c: Ctx, v: unknown) => writeFileSync(c.env.FAKE_GH_STATE!, JSON.stringify(v));

/** add + start + a committed change on the ticket branch, gated at HEAD. */
function built(c: Ctx, file = "src/a.ts") {
  expect(ops(c, ["add", "JOB-1"]).code).toBe(0);
  const s = ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug", description: "d" }));
  expect(s.code).toBe(0);
  mkdirSync(resolve(c.lane, file, ".."), { recursive: true });
  writeFileSync(resolve(c.lane, file), "export const a = 2;\n");
  sh(c.lane, c.env, "add", "-A");
  sh(c.lane, c.env, "commit", "-qm", "fix(parser): JOB-1");
  const head = sh(c.lane, c.env, "rev-parse", "HEAD");
  expect(ops(c, ["record", "JOB-1", "--phase", "build"], JSON.stringify({ result: "done", gatedSha: head })).code).toBe(0);
  return head;
}
/** Ship, then pass both gates on the pushed head. */
function graded(c: Ctx, file?: string) {
  const head = built(c, file);
  expect(ops(c, ["ship", "JOB-1"]).code).toBe(0);
  expect(ops(c, ["record", "JOB-1", "--phase", "critic"], JSON.stringify({ result: "pass", criticVerdict: "pass", criticSha: head })).code).toBe(0);
  expect(ops(c, ["record", "JOB-1", "--phase", "verify"], JSON.stringify({ result: "pass", verifyVerdict: "pass", verifiedSha: head })).code).toBe(0);
  return head;
}

let c: Ctx;
beforeEach(() => {
  c = setup();
});

describe("ticket-ops entry checks", () => {
  it("accepts only JOB-<n> keys, which reach branch names and shell commands", () => {
    for (const k of ["job-1", "JOB-01", "JOB-1;rm -rf /", "SHROOM-1"]) expect(ops(c, ["add", k]).code).toBe(1);
    expect(st(c).tickets).toEqual([]);
    expect(ops(c, ["add", "JOB-1"]).code).toBe(0);
  });

  it("refuses to run anywhere but the lane", () => {
    const r = ops(c, ["add", "JOB-1"], undefined, {}, c.primary);
    expect(r.code).toBe(2);
    expect(st(c).tickets).toEqual([]);
  });
});

describe("record", () => {
  it("rejects a malformed return and writes nothing", () => {
    built(c);
    const before = readFileSync(c.state, "utf8");
    for (const bad of ["not json", "[]", JSON.stringify({ result: "maybe" }), JSON.stringify({ result: "done", planNote: 3 }), JSON.stringify({ result: "done", clarificationAdd: "x" })]) {
      expect(ops(c, ["record", "JOB-1", "--phase", "build"], bad).code).toBe(1);
    }
    expect(ops(c, ["record", "JOB-1", "--phase", "ship"], JSON.stringify({ result: "done" })).code).toBe(1);
    // a well-formed Fix return, but the ticket is at ship, not fix
    expect(ops(c, ["record", "JOB-1", "--phase", "fix"], JSON.stringify({ result: "done" })).code).toBe(1);
    expect(readFileSync(c.state, "utf8")).toBe(before);
  });

  it("drops fields the phase may not set, and routes on the result", () => {
    expect(ops(c, ["add", "JOB-1"]).code).toBe(0);
    ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "t", type: "feature" }));
    const r = ops(c, ["record", "JOB-1", "--phase", "build"], JSON.stringify({ result: "handoff", handoff: "next: x", commitSha: "abc", verifyVerdict: "pass" }));
    expect(r.code).toBe(0);
    expect(r.out.dropped).toEqual(["commitSha", "verifyVerdict"]);
    expect(ticket(c).phase).toBe("build");
    expect(ticket(c).commitSha).toBeUndefined();
  });

  it("refuses a verdict for any commit but the pushed one", () => {
    const head = built(c);
    ops(c, ["ship", "JOB-1"]);
    const r = ops(c, ["record", "JOB-1", "--phase", "critic"], JSON.stringify({ result: "pass", criticVerdict: "pass", criticSha: "0".repeat(40) }));
    expect(r.code).toBe(1);
    expect(ticket(c).criticVerdict).toBeNull();
    expect(ops(c, ["record", "JOB-1", "--phase", "critic"], JSON.stringify({ result: "pass", criticVerdict: "concerns", criticSha: head })).code).toBe(1);
  });

  it("blocks a critic that changed the lane", () => {
    built(c);
    ops(c, ["ship", "JOB-1"]);
    writeFileSync(resolve(c.lane, "src", "a.ts"), "edited by the critic\n");
    const head = ticket(c).commitSha;
    const r = ops(c, ["record", "JOB-1", "--phase", "critic"], JSON.stringify({ result: "pass", criticVerdict: "pass", criticSha: head }));
    expect(r.code).toBe(3);
    expect(ticket(c).status).toBe("blocked");
    expect(ticket(c).criticVerdict).toBeNull();
  });

  it("never turns a not-owned ticket back into an owned one", () => {
    ops(c, ["add", "JOB-1"]);
    ops(c, ["record", "JOB-1", "--phase", "triage"], JSON.stringify({ result: "blocked", noTracker: true, blockedReason: "assigned elsewhere" }));
    ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ noTracker: false }));
    expect(ticket(c).noTracker).toBe(true);
    const r = ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ clarificationAdd: [{ question: "q", answer: "a" }] }));
    expect(r.out.toPost).toEqual([]);
  });

  it("lists each pipeline decision for posting until the orchestrator reports it posted", () => {
    ops(c, ["add", "JOB-1"]);
    const q = { question: "which?", answer: "this", reason: "convention" };
    expect(ops(c, ["record", "JOB-1", "--phase", "triage"], JSON.stringify({ clarificationAdd: [q] })).out.toPost).toHaveLength(1);
    expect(ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ postedAdd: ["which?"] })).out.toPost).toEqual([]);
  });
});

describe("start", () => {
  it("branches off the run branch with the linear.md name", () => {
    built(c);
    expect(ticket(c).branch).toBe("fix/job-1-fix-the-parser");
    expect(sh(c.lane, c.env, "merge-base", "HEAD", "origin/main")).toBe(sh(c.lane, c.env, "rev-parse", "origin/main"));
  });

  it("blocks on a branch that already exists on the remote", () => {
    sh(c.primary, c.env, "push", "-q", "origin", "main:refs/heads/fix/job-1-fix-the-parser");
    ops(c, ["add", "JOB-1"]);
    const r = ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug" }));
    expect(r.code).toBe(3);
    expect(ticket(c).status).toBe("blocked");
  });
});

describe("ship", () => {
  it("skips the gates on the gated sha, pushes, reads back and opens the PR against the base", () => {
    const head = built(c);
    const r = ops(c, ["ship", "JOB-1"], undefined, { FAIL_TEST: "1" }); // would fail if the gates ran
    expect(r.code).toBe(0);
    expect(sh(c.lane, c.env, "ls-remote", "origin", "refs/heads/fix/job-1-fix-the-parser").split(/\s/)[0]).toBe(head);
    expect(ticket(c)).toMatchObject({ commitSha: head, prNumber: 1, phase: "critic" });
    expect(gh(c).prs["1"].baseRefName).toBe("main");
    expect(gh(c).prs["1"].body).toContain("NOT VERIFIED BY A HUMAN");
  });

  it("never takes the gated-sha shortcut when the diff changes a gate definition", () => {
    built(c, "vitest.config.ts");
    const r = ops(c, ["ship", "JOB-1"], undefined, { FAIL_TEST: "1" });
    expect(r.code).toBe(4);
    expect(ticket(c).phase).toBe("fix");
    expect(ticket(c).verifyFindings).toContain("npm test");
  });

  it("adopts an open PR for the branch instead of opening a second", () => {
    built(c);
    setGh(c, { prs: { "7": { state: "OPEN", baseRefName: "main", headRefName: "fix/job-1-fix-the-parser", body: "x" } } });
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(0);
    expect(ticket(c).prNumber).toBe(7);
    expect(Object.keys(gh(c).prs)).toEqual(["7"]);
  });

  it("refuses a wip: commit", () => {
    built(c);
    writeFileSync(resolve(c.lane, "src", "b.ts"), "x\n");
    sh(c.lane, c.env, "add", "-A");
    sh(c.lane, c.env, "commit", "-qm", "wip: half");
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(4);
  });
});

describe("risk", () => {
  it("gives a gate-definition change the deepest critic and says so", () => {
    built(c, "tsconfig.json");
    ops(c, ["ship", "JOB-1"]);
    const r = ops(c, ["risk", "JOB-1"]);
    expect(r.out).toMatchObject({ depth: "L2+Double", gatesChanged: true });
  });
});

describe("merge", () => {
  it("prints the merge pinned to the graded head, for the orchestrator to run", () => {
    const head = graded(c);
    setGh(c, { prs: { "1": { ...gh(c).prs["1"], headRefOid: head } } });
    const r = ops(c, ["merge", "JOB-1"]);
    expect(r.code).toBe(0);
    expect(r.out.run).toEqual([`gh pr merge 1 --squash --match-head-commit ${head}`]);
  });

  it("refuses a run that is manual-merge or predates the field", () => {
    const head = graded(c);
    setGh(c, { prs: { "1": { ...gh(c).prs["1"], headRefOid: head } } });
    const s = st(c);
    delete s.manualMerge;
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(3);
  });

  it("refuses without both verdicts on the current head", () => {
    built(c);
    ops(c, ["ship", "JOB-1"]);
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(2);
  });

  it("routes to Fix when the base moved after Verify", () => {
    const head = graded(c);
    setGh(c, { prs: { "1": { ...gh(c).prs["1"], headRefOid: head } } });
    writeFileSync(resolve(c.primary, "other.txt"), "another run merged\n");
    sh(c.primary, c.env, "add", "-A");
    sh(c.primary, c.env, "commit", "-qm", "other");
    sh(c.primary, c.env, "push", "-q", "origin", "main");
    const r = ops(c, ["merge", "JOB-1"]);
    expect(r.code).toBe(4);
    expect(ticket(c).phase).toBe("fix");
  });

  it("leaves an src/apply/ change open for the owner's live autofill run", () => {
    const head = graded(c, "src/apply/x.ts");
    setGh(c, { prs: { "1": { ...gh(c).prs["1"], headRefOid: head } } });
    const r = ops(c, ["merge", "JOB-1"]);
    expect(r.code).toBe(3);
    expect(ticket(c).blockedReason).toContain("owner gate");
  });
});

describe("merged and finish", () => {
  it("records the merge, prints the ref delete, then resyncs and deletes the branch by head equality", () => {
    const head = graded(c);
    setGh(c, { prs: { "1": { ...gh(c).prs["1"], headRefOid: head, state: "MERGED", mergeCommit: { oid: "m".repeat(40) } } } });
    expect(ops(c, ["finish", "JOB-1", "--run-branch", "run/x"]).code).toBe(2); // no merge recorded yet
    const m = ops(c, ["merged", "JOB-1"]);
    expect(m.code).toBe(0);
    expect(m.out.run).toEqual(["gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/fix/job-1-fix-the-parser"]);
    expect(ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ status: "done" })).code).toBe(1);
    sh(c.lane, c.env, "push", "-q", "origin", "--delete", "fix/job-1-fix-the-parser");
    const f = ops(c, ["finish", "JOB-1", "--run-branch", "run/x"]);
    expect(f.code).toBe(0);
    expect(f.out.trackerDone).toBe(true);
    expect(sh(c.lane, c.env, "branch", "--show-current")).toBe("run/x");
    expect(sh(c.lane, c.env, "branch", "--list", "fix/job-1-fix-the-parser")).toBe("");
    expect(ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ status: "done" })).code).toBe(0);
    expect(ops(c, ["record", "JOB-1", "--phase", "orchestrator"], JSON.stringify({ fixRound: 9 })).code).toBe(1);
  });
});

describe("guard", () => {
  beforeEach(() => {
    writeFileSync(
      resolve(c.primary, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-live\nJOB_RADAR_DB=/home/x/real.sqlite\nJOB_RADAR_CONTACT=me@example.com\n# JOB_RADAR_MODEL=x\n",
    );
  });

  it("generates the lane .env from the allowlist only", () => {
    expect(ops(c, ["guard", "--init"]).code).toBe(0);
    const env = readFileSync(resolve(c.lane, ".env"), "utf8");
    expect(env).toBe("JOB_RADAR_CONTACT=me@example.com\n");
    expect(ops(c, ["guard"]).code).toBe(0);
  });

  it("refuses a key in the lane .env, an exported key, a personal file, or a changed timer", () => {
    ops(c, ["guard", "--init"]);
    writeFileSync(resolve(c.lane, ".env"), "JOB_RADAR_CONTACT=x\nANTHROPIC_API_KEY=sk-ant-1\n");
    expect(ops(c, ["guard"]).code).toBe(2);
    ops(c, ["guard", "--init"]);
    expect(ops(c, ["guard"], undefined, { ANTHROPIC_API_KEY: "sk-ant-2" }).code).toBe(2);
    expect(ops(c, ["guard"], undefined, { JOB_RADAR_DB: "/x" }).code).toBe(2);
    mkdirSync(resolve(c.lane, "config"), { recursive: true });
    writeFileSync(resolve(c.lane, "config", "personal.yaml"), "x");
    expect(ops(c, ["guard"]).code).toBe(2);
    execFileSync("rm", [resolve(c.lane, "config", "personal.yaml")]);
    expect(ops(c, ["guard"]).code).toBe(0);
    mkdirSync(resolve(c.root, "config", "systemd", "user"), { recursive: true });
    writeFileSync(resolve(c.root, "config", "systemd", "user", "job-radar-daily.service"), "WorkingDirectory=/lane\n");
    expect(ops(c, ["guard"]).code).toBe(2);
    expect(existsSync(resolve(c.lane, ".env"))).toBe(true);
  });
});
