import { describe, it, expect } from "vitest";
import { estimateCostUsd, describeSpend, PRICING } from "../src/lib/cost.js";

/**
 * JOB-22. `analyze` reported its spend to the cent while `resume tailor` and
 * `apply` reported nothing at all - and those two cost more per job. On the
 * day this was written, `analyze` logged $2.85 across 11 runs while 61 tailor
 * and apply runs logged no tokens and no cost, against a bill near $17.
 */

describe("estimating what a call cost", () => {
  it("prices Opus 5 at the published rates", () => {
    // 1M input + 1M output at $5 / $25.
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, "claude-opus-5")).toBeCloseTo(30, 6);
  });

  it("charges a premium for cache writes and a discount for cache reads", () => {
    const write = estimateCostUsd({ input: 0, cacheWrite: 1_000_000, output: 0 }, "claude-opus-5");
    const read = estimateCostUsd({ input: 0, cacheRead: 1_000_000, output: 0 }, "claude-opus-5");
    const plain = estimateCostUsd({ input: 1_000_000, output: 0 }, "claude-opus-5");
    expect(write).toBeGreaterThan(plain);
    expect(read).toBeLessThan(plain);
    expect(read).toBeCloseTo(plain * 0.1, 6);
  });

  it("counts output as the dominant cost, because it is", () => {
    // The measured shape of one `apply` call: ~4.3k in, ~8.7k out. Output was
    // ten times the input cost, which is why trimming what gets GENERATED is
    // the lever, not trimming what gets sent.
    const usage = { input: 4281, cacheRead: 0, output: 8675 };
    const total = estimateCostUsd(usage, "claude-opus-5");
    const outputOnly = estimateCostUsd({ input: 0, output: usage.output }, "claude-opus-5");
    expect(outputOnly / total).toBeGreaterThan(0.9);
  });

  it("errs high on an unknown model rather than reporting a low number", () => {
    const unknown = estimateCostUsd({ input: 1000, output: 1000 }, "some-future-model");
    const cheapest = estimateCostUsd({ input: 1000, output: 1000 }, "claude-haiku-4-5");
    expect(unknown).toBeGreaterThan(cheapest);
    expect(unknown).toBe(estimateCostUsd({ input: 1000, output: 1000 }, "claude-opus-5"));
  });

  it("treats missing cache fields as zero, not as an error", () => {
    expect(estimateCostUsd({ input: 100, output: 100 }, "claude-opus-5")).toBeGreaterThan(0);
  });

  it("is zero for a run that called nothing", () => {
    expect(estimateCostUsd({ input: 0, output: 0 }, "claude-opus-5")).toBe(0);
  });

  it("keeps the published rates for the models actually used", () => {
    // A wrong rate here produces a confident, wrong number - worse than none.
    expect(PRICING["claude-opus-5"]).toEqual({ input: 5, output: 25 });
    expect(PRICING["claude-sonnet-5"]).toEqual({ input: 3, output: 15 });
    expect(PRICING["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
  });
});

describe("describeSpend", () => {
  it("names the model and the dollar figure", () => {
    const line = describeSpend({ input: 4281, cacheRead: 0, output: 8675 }, "claude-opus-5");
    expect(line).toContain("4281 in");
    expect(line).toContain("8675 out");
    expect(line).toMatch(/\$0\.2\d\d/);
    expect(line).toContain("claude-opus-5");
  });

  it("omits the cached figure when nothing was cached", () => {
    expect(describeSpend({ input: 10, cacheRead: 0, output: 10 }, "claude-opus-5")).not.toContain("cached");
    expect(describeSpend({ input: 10, cacheRead: 99, output: 10 }, "claude-opus-5")).toContain("99 cached");
  });
});
