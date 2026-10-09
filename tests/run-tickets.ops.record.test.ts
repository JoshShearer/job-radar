import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRANCH, built, commitIn, ops, rec, setup, sh, shipped, st, ticket, moveBase, type Ctx } from "./helpers/runTicketsOps.js";

/** /run-tickets ticket-ops: see tests/helpers/runTicketsOps.ts for the harness and why it is a subprocess. */
let c: Ctx;
beforeEach(() => {
  c = setup();
});
afterEach(() => {
  rmSync(c.root, { recursive: true, force: true });
});

describe("ticket-ops entry checks", () => {
  it("accepts only JOB-<n> keys, which reach branch names and shell commands", () => {
    for (const k of ["job-1", "JOB-01", "JOB-1;rm -rf /", "SHROOM-1"]) expect(ops(c, ["add", k]).code).toBe(1);
    expect(st(c).tickets).toEqual([]);
    expect(ops(c, ["add", "JOB-1"]).code).toBe(0);
  });

  it("refuses to run anywhere but the lane", () => {
    expect(ops(c, ["add", "JOB-1"], undefined, {}, c.primary).code).toBe(2);
    expect(st(c).tickets).toEqual([]);
  });
});

describe("record", () => {
  it("rejects a malformed return and writes nothing", () => {
    built(c);
    // A sentinel heartbeat: any save at all would replace it, whatever second it happens in.
    writeFileSync(c.state, JSON.stringify({ ...st(c), heartbeat: "SENTINEL" }));
    const before = readFileSync(c.state, "utf8");
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ result: "maybe" }),
      JSON.stringify({ result: "done", planNote: 3 }),
      JSON.stringify({ result: "done", clarificationAdd: "x" }),
    ])
      expect(ops(c, ["record", "JOB-1", "--phase", "build"], bad).code).toBe(1);
    expect(rec(c, "orchestrator", { status: "finished" }).code).toBe(1);
    expect(rec(c, "orchestrator", { phase: "implement" }).code).toBe(1);
    expect(rec(c, "ship", { result: "done" }).code).toBe(1);
    expect(rec(c, "fix", { result: "done" }).code).toBe(1); // well-formed, wrong phase
    expect(readFileSync(c.state, "utf8")).toBe(before);
  });

  it("drops fields the phase may not set, and routes on the result", () => {
    ops(c, ["add", "JOB-1"]);
    ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "t", type: "feature", description: "d" }));
    const r = rec(c, "build", { result: "handoff", handoff: "next: x", commitSha: "abc", verifyVerdict: "pass" });
    expect(r.code).toBe(0);
    expect(r.out.dropped).toEqual(["commitSha", "verifyVerdict"]);
    expect(ticket(c).phase).toBe("build");
    expect(ticket(c).commitSha).toBeUndefined();
  });

  it("refuses a verdict for any commit but the pushed one", () => {
    const head = shipped(c);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: "0".repeat(40) }).code).toBe(1);
    expect(ticket(c).criticVerdict).toBeNull();
    expect(rec(c, "critic", { result: "pass", criticVerdict: "concerns", criticSha: head }).code).toBe(1);
  });

  it("refuses a critic return without risk and a snapshot for the current commit", () => {
    const head = built(c);
    ops(c, ["ship", "JOB-1"]);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(1); // no snapshot
    ops(c, ["snapshot", "JOB-1"]);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(1); // no risk
    ops(c, ["risk", "JOB-1"]);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(0);
  });

  it("refuses a Verify return whose snapshot was taken for the critic, not for it", () => {
    const head = shipped(c);
    rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head });
    expect(rec(c, "verify", { result: "pass", verifyVerdict: "pass", verifiedSha: head }).code).toBe(1);
    ops(c, ["snapshot", "JOB-1"]);
    expect(rec(c, "verify", { result: "pass", verifyVerdict: "pass", verifiedSha: head }).code).toBe(0);
  });

  it("requires a justification from every critic when the diff changes a gate", () => {
    const head = shipped(c, "vitest.config.ts");
    expect(ticket(c).risk).toMatchObject({ gatesChanged: true, critics: 2 });
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head, gateJustifications: ["ok"] }).code).toBe(1);
    expect(
      rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head, gateJustifications: ["ok", "also ok"] }).code,
    ).toBe(0);
  });

  it("blocks a critic that changed the lane", () => {
    const head = shipped(c);
    writeFileSync(resolve(c.lane, "src", "a.ts"), "edited by the critic\n");
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(3);
    expect(ticket(c).status).toBe("blocked");
    expect(ticket(c).criticVerdict).toBeNull();
  });

  it("blocks a Verify that left the lane off the branch, and keeps its own block reason", () => {
    const head = shipped(c);
    rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head });
    ops(c, ["snapshot", "JOB-1"]);
    sh(c.lane, c.env, "checkout", "-q", "--detach", "origin/main");
    expect(rec(c, "verify", { result: "pass", verifyVerdict: "pass", verifiedSha: head }).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("verify left changes");
  });

  it("keeps a Verify's 'main is red' reason when it also left the lane changed", () => {
    const head = shipped(c);
    rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head });
    ops(c, ["snapshot", "JOB-1"]);
    sh(c.lane, c.env, "checkout", "-q", "--detach", "origin/main");
    expect(rec(c, "verify", { result: "blocked", blockedReason: "main is red" }).code).toBe(3);
    expect(ticket(c).blockedReason).toMatch(/^main is red; also verify left changes/);
  });

  it("blocks a critic that wrote in the primary, or moved the remote branch", () => {
    const head = shipped(c);
    writeFileSync(resolve(c.primary, "scribble.txt"), "x");
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("primary");
  });

  it("blocks a critic that touched the primary's ignored files (the .env, the database)", () => {
    const head = shipped(c);
    writeFileSync(resolve(c.primary, ".env"), "ANTHROPIC_API_KEY=changed\n");
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("ignored files included");
  });

  it("blocks a critic return when origin/main moved under it", () => {
    const head = shipped(c);
    moveBase(c);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(3);
    expect(ticket(c).blockedReason).toContain("origin/main moved");
  });

  it("blocks a critic that pushed to the ticket branch", () => {
    const head = shipped(c);
    const other = commitIn(c, "src/x.ts", "x\n", "sneaky");
    sh(c.lane, c.env, "push", "-q", "origin", `${other}:refs/heads/${BRANCH}`);
    sh(c.lane, c.env, "reset", "-q", "--hard", head);
    expect(rec(c, "critic", { result: "pass", criticVerdict: "pass", criticSha: head }).code).toBe(3);
    expect(ticket(c).blockedReason).toContain(`origin/${BRANCH}`);
  });

  it("lets a Fix switch to the followup branch only as a pair", () => {
    const head = shipped(c);
    rec(c, "critic", { result: "block", criticVerdict: "block", criticSha: head, verifyFindings: "x" });
    expect(ticket(c).phase).toBe("fix");
    expect(rec(c, "fix", { result: "done", prNumber: null }).code).toBe(1);
    expect(rec(c, "fix", { result: "done", branch: `${BRANCH}-followup` }).code).toBe(1);
    expect(rec(c, "fix", { result: "done", branch: "fix/elsewhere", prNumber: null }).code).toBe(1);
    expect(rec(c, "fix", { result: "done", branch: `${BRANCH}-followup`, prNumber: null }).code).toBe(0);
    expect(ticket(c)).toMatchObject({ branch: `${BRANCH}-followup`, prNumber: null });
  });

  it("never turns a not-owned ticket back into an owned one", () => {
    ops(c, ["add", "JOB-1"]);
    rec(c, "triage", { result: "blocked", noTracker: true, blockedReason: "assigned elsewhere" });
    rec(c, "orchestrator", { noTracker: false });
    expect(ticket(c).noTracker).toBe(true);
    expect(rec(c, "orchestrator", { blockedReason: "x" }).out.toPost).toEqual([]);
  });

  it("lists each pipeline decision for posting until the orchestrator reports it posted", () => {
    ops(c, ["add", "JOB-1"]);
    const q = { question: "which?", answer: "this", reason: "convention" };
    expect(rec(c, "triage", { clarificationAdd: [q] }).out.toPost).toHaveLength(1);
    expect(rec(c, "orchestrator", { postedAdd: ["which?"] }).out.toPost).toEqual([]);
  });
});

describe("start", () => {
  it("branches off the run branch with the linear.md name", () => {
    built(c);
    expect(ticket(c).branch).toBe(BRANCH);
    expect(sh(c.lane, c.env, "merge-base", "HEAD", "origin/main")).toBe(sh(c.lane, c.env, "rev-parse", "origin/main"));
  });

  it("blocks a ticket with no description to grade against", () => {
    ops(c, ["add", "JOB-1"]);
    expect(ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "t", description: " " })).code).toBe(3);
  });

  it("blocks on a branch that already exists on the remote", () => {
    sh(c.primary, c.env, "push", "-q", "origin", `main:refs/heads/${BRANCH}`);
    ops(c, ["add", "JOB-1"]);
    const r = ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug", description: "d" }));
    expect(r.code).toBe(3);
  });

  it("on resume, checks out its own branch from the remote when the lane lost it", () => {
    const head = shipped(c);
    sh(c.lane, c.env, "checkout", "-q", "run/x");
    sh(c.lane, c.env, "branch", "-q", "-D", BRANCH);
    const s = st(c);
    s.tickets[0].phase = "build"; // as a resumed Start sees it
    writeFileSync(c.state, JSON.stringify(s));
    expect(ops(c, ["start", "JOB-1", "--run-branch", "run/x"], JSON.stringify({ title: "Fix the parser!", type: "bug", description: "d" })).code).toBe(0);
    expect(sh(c.lane, c.env, "rev-parse", "HEAD")).toBe(head);
  });
});

