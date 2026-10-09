import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRANCH, REPO, built, commitIn, gh, graded, moveBase, ops, rec, setGh, setPr, setup, sh, shipped, st, ticket, type Ctx } from "./helpers/runTicketsOps.js";

/** /run-tickets ticket-ops: see tests/helpers/runTicketsOps.ts for the harness and why it is a subprocess. */
let c: Ctx;
beforeEach(() => {
  c = setup();
});
afterEach(() => {
  rmSync(c.root, { recursive: true, force: true });
});

describe("ship", () => {
  it("skips the gates on the gated sha, pushes, reads back and opens the PR against the base", () => {
    const head = built(c);
    expect(ops(c, ["ship", "JOB-1"], undefined, { FAIL_TEST: "1" }).code).toBe(0); // would fail if the gates ran
    expect(sh(c.lane, c.env, "ls-remote", "origin", `refs/heads/${BRANCH}`).split(/\s/)[0]).toBe(head);
    expect(ticket(c)).toMatchObject({ commitSha: head, prNumber: 1, phase: "critic" });
    expect(gh(c).prs["1"].baseRefName).toBe("main");
    expect(gh(c).prs["1"].body).toContain("NOT VERIFIED BY A HUMAN");
  });

  it("refuses to run out of phase", () => {
    ops(c, ["add", "JOB-1"]);
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(1);
  });

  it("never takes the gated-sha shortcut when the diff changes a gate definition", () => {
    built(c, "vitest.config.ts");
    expect(ops(c, ["ship", "JOB-1"], undefined, { FAIL_TEST: "1" }).code).toBe(4);
    expect(ticket(c).verifyFindings).toContain("npm test");
  });

  it("sees a gate file moved away by a rename", () => {
    ops(c, ["add", "JOB-1"]);
    ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug", description: "d" }));
    sh(c.lane, c.env, "mv", "vitest.config.ts", "src/unwatched.ts");
    sh(c.lane, c.env, "commit", "-qm", "move");
    rec(c, "build", { result: "done", gatedSha: sh(c.lane, c.env, "rev-parse", "HEAD") });
    expect(ops(c, ["ship", "JOB-1"], undefined, { FAIL_TEST: "1" }).code).toBe(4);
  });

  it("refuses to push an Anthropic key value, the primary path, or the timer's key file", () => {
    built(c, "src/k.ts", `const k = "sk-ant-${"a".repeat(30)}";\n`);
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
    expect(sh(c.lane, c.env, "ls-remote", "origin", `refs/heads/${BRANCH}`)).toBe("");
  });

  it("refuses to push the primary's path", () => {
    built(c, "src/k.ts", `const p = "${c.primary}/data/job-radar.sqlite";\n`);
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
  });

  it("refuses to push a reference to ~/.config/job-radar", () => {
    built(c, "src/k.ts", 'const p = "~/.config/job-radar/env";\n');
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
  });

  it("passes ordinary code and placeholders, and docs that name the timer's key file", () => {
    built(c, "src/k.ts", 'const k = process.env.ANTHROPIC_API_KEY ?? "sk-ant-test";\n');
    commitIn(c, "docs/timer.md", "The timer reads ~/.config/job-radar/env.\n");
    rec(c, "orchestrator", {});
    const s = st(c);
    s.tickets[0].gatedSha = sh(c.lane, c.env, "rev-parse", "HEAD");
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(0);
  });

  it("refuses a committed env file", () => {
    built(c);
    writeFileSync(resolve(c.lane, ".env.local"), "JOB_RADAR_CONTACT=x\n");
    sh(c.lane, c.env, "add", "-f", ".env.local");
    sh(c.lane, c.env, "commit", "-qm", "env");
    const s = st(c);
    s.tickets[0].gatedSha = sh(c.lane, c.env, "rev-parse", "HEAD");
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
    expect(ticket(c).blockedReason).toContain(".env.local");
  });

  it("refuses a key added in one commit and removed in the next", () => {
    built(c, "src/k.ts", `const k = "sk-ant-${"c".repeat(24)}";\n`);
    const head = commitIn(c, "src/k.ts", "const k = process.env.ANTHROPIC_API_KEY;\n", "fix: drop it");
    const s = st(c);
    s.tickets[0].gatedSha = head;
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
    expect(sh(c.lane, c.env, "ls-remote", "origin", `refs/heads/${BRANCH}`)).toBe("");
  });

  it("blocks a commit whose env loader can see a paid key", () => {
    symlinkSync(resolve(REPO, "node_modules"), resolve(c.lane, "node_modules"));
    built(c, "src/config/env.ts", 'export function loadEnvFile() { process.env.ANTHROPIC_API_KEY = "x"; }\n');
    const r = ops(c, ["ship", "JOB-1"]);
    expect(r.code).toBe(3);
    expect(ticket(c).blockedReason).toContain("paid key");
  });

  it("blocks when the remote branch holds a commit the run did not push", () => {
    built(c);
    sh(c.primary, c.env, "push", "-q", "origin", `main:refs/heads/${BRANCH}`);
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("not the run's");
  });

  it("adopts an open PR for the branch instead of opening a second", () => {
    built(c);
    setGh(c, { prs: { "7": { state: "OPEN", baseRefName: "main", headRefName: BRANCH, body: "x" } } });
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(0);
    expect(ticket(c).prNumber).toBe(7);
    expect(Object.keys(gh(c).prs)).toEqual(["7"]);
  });

  it("refuses a wip: commit", () => {
    built(c);
    commitIn(c, "src/b.ts", "x\n", "wip: half");
    expect(ops(c, ["ship", "JOB-1"]).code).toBe(4);
  });
});

describe("risk", () => {
  it("gives a gate-definition change the deepest critic and says so", () => {
    shipped(c, "tsconfig.json");
    expect(ticket(c).risk).toMatchObject({ depth: "L2+Double", gatesChanged: true });
  });
});

describe("merge", () => {
  it("prints the merge pinned to the graded head, for the orchestrator to run", () => {
    const head = graded(c);
    const r = ops(c, ["merge", "JOB-1"]);
    expect(r.code).toBe(0);
    expect(r.out.run).toEqual([`gh pr merge 1 --squash --match-head-commit ${head}`]);
  });

  it("treats a PR already merged at the graded head as merged, though the merge moved the base", () => {
    graded(c);
    setPr(c, { state: "MERGED" });
    moveBase(c);
    const r = ops(c, ["merge", "JOB-1"]);
    expect(r.code).toBe(0);
    expect(r.out.run).toEqual([]);
    expect(ticket(c).phase).toBe("merge");
  });

  it("blocks when the PR head is not the graded commit", () => {
    graded(c);
    setPr(c, { headRefOid: "f".repeat(40) });
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(3);
  });

  it("refuses a run that is manual-merge or predates the field", () => {
    graded(c);
    const s = st(c);
    delete s.manualMerge;
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(3);
  });

  it("refuses a gate change whose justifications are not on record for this commit", () => {
    const head = shipped(c, "vitest.config.ts");
    rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head, gateJustifications: ["a", "b"] });
    ops(c, ["snapshot", "JOB-1"]);
    rec(c, "verify", { result: "pass", verifyVerdict: "pass", verifiedSha: head });
    setPr(c, { headRefOid: head });
    const s = st(c);
    s.tickets[0].gateJustifications = ["a"];
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(2);
  });

  it("routes to Fix when the base moved after Verify", () => {
    graded(c);
    moveBase(c);
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(4);
    expect(ticket(c).phase).toBe("fix");
  });

  it("leaves an src/apply/ change open for the owner's live autofill run", () => {
    graded(c, "src/apply/x.ts");
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("owner gate");
  });

  it("caps attempts at two per head", () => {
    graded(c);
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(0);
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(0);
    expect(ops(c, ["merge", "JOB-1"]).code).toBe(3);
  });
});

describe("merged and finish", () => {
  it("records the merge, prints the ref delete, then resyncs and deletes the branch by head equality", () => {
    const head = graded(c);
    setPr(c, { state: "MERGED", mergeCommit: { oid: "m".repeat(40) } });
    expect(ops(c, ["finish", "JOB-1", "--run-branch", "run/x"]).code).toBe(1); // not at finish yet
    const m = ops(c, ["merged", "JOB-1"]);
    expect(m.code).toBe(0);
    expect(m.out.run).toEqual([`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/${BRANCH}`]);
    expect(rec(c, "orchestrator", { status: "done" }).code).toBe(1);
    sh(c.lane, c.env, "push", "-q", "origin", "--delete", BRANCH);
    const f = ops(c, ["finish", "JOB-1", "--run-branch", "run/x"]);
    expect(f.code).toBe(0);
    expect(f.out.trackerDone).toBe(true);
    expect(sh(c.lane, c.env, "branch", "--show-current")).toBe("run/x");
    expect(sh(c.lane, c.env, "branch", "--list", BRANCH)).toBe("");
    expect(rec(c, "orchestrator", { status: "done" }).code).toBe(0);
    expect(rec(c, "orchestrator", { fixRound: 9 }).code).toBe(1);
    expect(head).toBeTruthy();
  });

  it("routes a CONFLICTING merge to Fix", () => {
    graded(c);
    setPr(c, { mergeable: "CONFLICTING" });
    expect(ops(c, ["merged", "JOB-1"]).code).toBe(4);
    expect(ticket(c).phase).toBe("fix");
  });

  it("blocks when the PR head moved before it merged, and refuses a merge at an ungraded head", () => {
    graded(c);
    setPr(c, { headRefOid: "e".repeat(40) });
    expect(ops(c, ["merged", "JOB-1"]).code).toBe(3);
  });

  it("refuses a PR that reads back merged at an ungraded head", () => {
    graded(c);
    setPr(c, { state: "MERGED", headRefOid: "e".repeat(40), mergeCommit: { oid: "m".repeat(40) } });
    expect(ops(c, ["merged", "JOB-1"]).code).toBe(2);
    expect(ticket(c).mergeCommit).toBeUndefined();
  });

  it("keeps a local branch that holds commits the merge did not include", () => {
    graded(c);
    setPr(c, { state: "MERGED", mergeCommit: { oid: "m".repeat(40) } });
    ops(c, ["merged", "JOB-1"]);
    sh(c.lane, c.env, "push", "-q", "origin", "--delete", BRANCH);
    commitIn(c, "src/late.ts", "x\n", "late");
    sh(c.lane, c.env, "checkout", "-q", "run/x");
    expect(ops(c, ["finish", "JOB-1", "--run-branch", "run/x"]).code).toBe(3);
    expect(sh(c.lane, c.env, "branch", "--list", BRANCH)).not.toBe("");
  });
});

