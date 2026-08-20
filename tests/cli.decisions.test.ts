import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CLI = readFileSync(resolve(__dirname, "../src/cli.ts"), "utf8");

/**
 * JOB-38 asks for a defect CLASS to be closed, not one instance of it: "every
 * branch that decides spend/send/status becomes a small named pure function".
 *
 * A fix alone does not close a class - the same mistake can be made again next
 * week, in a new command, and nothing would notice. These are ratchets. They
 * read the source of cli.ts and fail when a decision reappears inside a command
 * body, which is the only way "no spend or status decision lives inline" can
 * stay true rather than having been true once.
 *
 * They are deliberately blunt. A blunt guard that fires on a real regression
 * and occasionally needs a deliberate update is worth more than a precise one
 * nobody writes.
 */
describe("no spend decision lives inline in a command body", () => {
  it("never hands runAnalysis an inline options object", () => {
    // The bug this exists for: `analyze` built its options inline and so did
    // `daily`, and they drifted. `daily` omitted maxSpendUsd entirely, so
    // shouldStopForBudget saw undefined and the DAILY, UNATTENDED, TIMED pass
    // ran with no ceiling at all.
    //
    // Asserted on the third argument specifically rather than "contains no
    // brace" - the resolver legitimately takes an env object of its own, and a
    // guard that cannot tell those apart gets deleted the first time it cries
    // wolf.
    const total = (CLI.match(/runAnalysis\s*\(/g) ?? []).length;
    const viaResolver = (CLI.match(/runAnalysis\s*\(\s*repo,\s*profile,\s*resolveAnalyzeOptions\s*\(/g) ?? [])
      .length;
    expect(total).toBeGreaterThan(0);
    expect(viaResolver).toBe(total);
  });

  it("resolves every analyze pass through the one tested function", () => {
    const runCalls = (CLI.match(/runAnalysis\s*\(/g) ?? []).length;
    const resolved = (CLI.match(/resolveAnalyzeOptions\s*\(/g) ?? []).length;
    expect(runCalls).toBeGreaterThan(0);
    expect(resolved).toBe(runCalls);
  });

  it("does not reintroduce a hand-rolled spend ceiling", () => {
    // `max_spend_per_run_usd` should be reached only through the resolver.
    const inline = [...CLI.matchAll(/max_spend_per_run_usd/g)];
    expect(inline).toHaveLength(0);
  });
});

describe("no status decision lives inline in a command body", () => {
  /**
   * Every `setStatus` call in cli.ts, with the named decision that produced
   * its value. Adding a call without updating this list fails, which forces
   * the question "where is the pure function for this?" at the time it is
   * written rather than during the next audit.
   */
  const KNOWN_STATUS_WRITES = [
    // apply: advanceStatus refuses every backwards move.
    { call: "repo.setStatus(job.id, nextStatus,", decidedBy: "advanceStatus" },
    // autofill: only ever writes APPLIED on an explicit human yes.
    { call: "repo.setStatus(job.id, recorded)", decidedBy: "statusAfterAutofill" },
    // daily: the GHOSTED sweep. The literal is the outcome; `ghostable`
    // decides WHICH jobs, which is the part with judgement in it.
    { call: 'repo.setStatus(g.id, "GHOSTED"', decidedBy: "ghostable" },
    // the `status` command itself: the human names the status. Not a decision.
    { call: "repo.setStatus(job.id, upper, opts.note)", decidedBy: "the user" },
  ];

  it("has exactly the status writes it is known to have", () => {
    const found = (CLI.match(/repo\.setStatus\(/g) ?? []).length;
    expect(found).toBe(KNOWN_STATUS_WRITES.length);
  });

  it("each one is present and traceable to a named decision", () => {
    for (const w of KNOWN_STATUS_WRITES) {
      expect(CLI).toContain(w.call);
      expect(w.decidedBy.length).toBeGreaterThan(0);
    }
  });

  it("each extracted decision function is actually imported here", () => {
    for (const fn of ["advanceStatus", "statusAfterAutofill", "ghostable"]) {
      expect(CLI).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b`));
    }
  });
});
