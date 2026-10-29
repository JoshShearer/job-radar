import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { operationsProblems, OperationsSchema } from "../src/domain/config/schema.js";
import { loadConfig } from "../src/adapters/fs/config-loader.js";
import { EXAMPLE_CONFIG } from "./helpers/context.js";

/** operations.yaml `model:`: the provider is config, strict, and cross-checked against the budgets. */
const example = () => parse(readFileSync(join(EXAMPLE_CONFIG, "operations.yaml"), "utf8"));

describe("operations.yaml model provider", () => {
  it("config.example selects claude-cli and loads coherently", () => {
    expect(loadConfig(EXAMPLE_CONFIG).operations.model.provider).toBe("claude-cli");
  });

  it("an install without the key keeps billing through the api, as before", () => {
    const o = example();
    delete o.model;
    const ops = OperationsSchema.parse(o);
    expect(ops.model.provider).toBe("api");
    expect(ops.model.cli).toEqual({ binary: "claude", timeout_ms: 600_000, reserve_turns: 4, overhead_input_tokens: 4000 });
  });

  it("is strict: an unknown key, an unknown cli key and an unknown provider are errors", () => {
    expect(OperationsSchema.safeParse({ ...example(), model: { provider: "claude-cli", extra: 1 } }).success).toBe(false);
    expect(OperationsSchema.safeParse({ ...example(), model: { provider: "claude-cli", cli: { extra: 1 } } }).success).toBe(false);
    expect(OperationsSchema.safeParse({ ...example(), model: { provider: "bogus" } }).success).toBe(false);
    expect(OperationsSchema.safeParse({ ...example(), model: { cli: { reserve_turns: 0 } } }).success).toBe(false);
  });

  it("refuses a relative binary path, which would resolve against the empty cwd", () => {
    const ops = OperationsSchema.parse({ ...example(), model: { provider: "claude-cli", cli: { binary: "bin/claude" } } });
    expect(operationsProblems(ops).join("\n")).toMatch(/model\.cli\.binary/);
    const abs = OperationsSchema.parse({ ...example(), model: { provider: "claude-cli", cli: { binary: "/home/x/.local/bin/claude" } } });
    expect(operationsProblems(abs)).toEqual([]);
  });

  it("refuses a per-run budget below one claude-cli worst case, which would refuse every call", () => {
    const o = { ...example(), budgets: { ...example().budgets, per_run_usd: 1 } };
    expect(operationsProblems(OperationsSchema.parse(o)).join("\n")).toMatch(/per_run_usd/);
    // The same budget is fine on the api provider's single-call reserve.
    expect(operationsProblems(OperationsSchema.parse({ ...o, model: { provider: "api" } }))).toEqual([]);
    expect(() => loadConfig(EXAMPLE_CONFIG, { operations: stringify(o) })).toThrow(/per_run_usd/);
  });
});
