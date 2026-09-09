import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { addUsage, emptyUsage, estimateCostUsd, readUsage } from "../src/lib/cost.js";
import { applyDataCleanups } from "../src/db/index.js";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { log } from "../src/lib/log.js";
import { classifyAnalysisFailure } from "../src/analysis/failures.js";

/**
 * `analyze` wrote `inputTokens`/`outputTokens`; `resume tailor` and `apply`
 * wrote `input`/`cacheWrite`/`cacheRead`/`output`. Dollar totals worked because
 * `estimatedCostUsd` was common, so nothing looked broken - but no single query
 * could total TOKENS across the tool. That is the same shape of gap that let a
 * $17 day record $0: a convention rather than a mechanism.
 */

afterEach(() => vi.restoreAllMocks());

describe("readUsage is the one place a response becomes a TokenUsage", () => {
  it("reads a full envelope, cache fields included", () => {
    const r = readUsage(
      { usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40 } },
      "test",
    );
    expect(r.missing).toBe(false);
    expect(r.usage).toEqual({ input: 100, cacheWrite: 20, cacheRead: 300, output: 40 });
  });

  it("defaults absent cache fields to 0 without calling the receipt missing", () => {
    const r = readUsage({ usage: { input_tokens: 10, output_tokens: 5 } }, "test");
    expect(r.missing).toBe(false);
    expect(r.usage).toEqual({ input: 10, cacheWrite: 0, cacheRead: 0, output: 5 });
  });

  it("flags a usage-less response loudly and returns zeros, rather than throwing", () => {
    // Throwing here would discard work already paid for. See below for why
    // that matters more than it looks.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const r = readUsage({ content: [] }, "analyze job-123 (full)");

    expect(r.missing).toBe(true);
    expect(r.usage).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    expect(warn).toHaveBeenCalledOnce();
    // Named, so the log says WHICH call lost its receipt.
    expect(warn.mock.calls[0]![0]).toContain("analyze job-123 (full)");
    // And honest that the money was still spent.
    expect(warn.mock.calls[0]![0]).toContain("still billed");
  });

  it("survives null, undefined and a non-numeric usage without throwing", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    for (const bad of [null, undefined, {}, { usage: null }, { usage: { input_tokens: "many" } }]) {
      expect(() => readUsage(bad, "test")).not.toThrow();
      expect(readUsage(bad, "test").missing).toBe(true);
    }
  });

  it("does not treat a genuinely free-looking zero-token response as missing", () => {
    const r = readUsage({ usage: { input_tokens: 0, output_tokens: 0 } }, "test");
    expect(r.missing).toBe(false);
  });
});

describe("a missing receipt must not consume the job's attempt budget", () => {
  it("is not the kind of failure that counts against a job", () => {
    // The chain that makes this load-bearing: throwing on missing usage would
    // route into `classifyAnalysisFailure`, where anything not classified
    // `api` counts against the job and consumes one of its two attempts. A
    // provider reporting quirk would then park a perfectly analysable job -
    // inverting the purpose of the attempt budget, which exists to stop
    // re-buying DETERMINISTIC failures.
    //
    // `readUsage` never throws, so no message ever reaches this function.
    // This test pins the reasoning: the classifier would have got it wrong.
    const kind = classifyAnalysisFailure("the response carried no usage metadata");
    expect(kind).not.toBe("api");
  });
});

describe("the envelope arithmetic", () => {
  it("starts from a known shape rather than undefined", () => {
    expect(emptyUsage()).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });

  it("accumulates, treating absent cache fields as zero", () => {
    const total = addUsage({ input: 1, output: 2 }, { input: 10, cacheWrite: 5, cacheRead: 7, output: 20 });
    expect(total).toEqual({ input: 11, cacheWrite: 5, cacheRead: 7, output: 22 });
  });

  it("costs a zeroed envelope at nothing, so a missing receipt never invents spend", () => {
    expect(estimateCostUsd(emptyUsage(), "claude-opus-5")).toBe(0);
  });
});

describe("the runaway dashboard rows", () => {
  function runsDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    const ins = db.prepare("INSERT INTO runs (command, started_at, ok) VALUES (?, ?, 1)");
    for (let i = 0; i < 5; i++) ins.run("dashboard", "2026-08-14T06:28:57.702Z");
    ins.run("dashboard", "2026-08-20T05:38:47.733Z"); // the one legitimate run
    ins.run("analyze", "2026-08-14T01:00:00.000Z"); // an unrelated command, same day
    return db;
  }

  it("purges the loop's rows and keeps the legitimate one", () => {
    const db = runsDb();
    const done = applyDataCleanups(db);
    expect(done[0]).toContain("5");

    const rows = db.prepare("SELECT command, started_at FROM runs ORDER BY started_at").all() as {
      command: string;
      started_at: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.command).sort()).toEqual(["analyze", "dashboard"]);
    // The surviving dashboard row is the one logged after the fix landed.
    expect(rows.find((r) => r.command === "dashboard")!.started_at).toContain("2026-08-20");
  });

  it("is idempotent, so migrate can be re-run", () => {
    const db = runsDb();
    applyDataCleanups(db);
    expect(applyDataCleanups(db)).toEqual([]);
  });

  it("leaves other commands alone even on the same day", () => {
    const db = runsDb();
    applyDataCleanups(db);
    const analyze = db.prepare("SELECT COUNT(*) c FROM runs WHERE command = 'analyze'").get() as { c: number };
    expect(analyze.c).toBe(1);
  });
});
