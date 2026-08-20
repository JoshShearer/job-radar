import { describe, it, expect } from "vitest";
import { supportsEffort } from "../src/analysis/analyzer.js";

describe("supportsEffort", () => {
  it("omits effort for the model family that rejects it", () => {
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("keeps effort for the models that take it", () => {
    expect(supportsEffort("claude-opus-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-5")).toBe(true);
    expect(supportsEffort("claude-opus-4-8")).toBe(true);
  });

  /*
   * Unknown models default to sending it. A newer model is far likelier to
   * accept the parameter than not, and guessing wrong that way costs one 400 -
   * whereas defaulting to omit would silently drop the setting on every call
   * and quietly change what every analysis costs.
   */
  it("defaults an unknown model to sending effort", () => {
    expect(supportsEffort("claude-something-6")).toBe(true);
  });
});
