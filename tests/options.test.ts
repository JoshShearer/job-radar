import { describe, expect, it } from "vitest";
import { parseNonNegativeFlag, parseNumericFlag } from "../src/lib/options.js";

describe("parseNumericFlag", () => {
  it("returns undefined when the flag was not supplied", () => {
    // Distinct from 0 on purpose: the caller falls back to config with `??`,
    // and `0` is a real ceiling meaning "spend nothing".
    expect(parseNumericFlag(undefined, "--max-spend")).toBeUndefined();
  });

  it("parses integers and decimals", () => {
    expect(parseNumericFlag("2", "--max-spend")).toBe(2);
    expect(parseNumericFlag("1.50", "--max-spend")).toBe(1.5);
    expect(parseNumericFlag("0", "--max-spend")).toBe(0);
  });

  it("throws on a value that is not a number, naming the flag", () => {
    // The defect this exists for: Number("1.5O") is NaN, NaN fails every
    // comparison, and `spent >= NaN` is false - so a mistyped ceiling removed
    // the ceiling instead of falling back to the configured one.
    expect(() => parseNumericFlag("1.5O", "--max-spend")).toThrow(/--max-spend expects a number, got "1\.5O"/);
    expect(() => parseNumericFlag("abc", "--min-fit")).toThrow(/--min-fit expects a number/);
    expect(() => parseNumericFlag("", "--max-spend")).toThrow(/expects a number/);
  });

  it("rejects Infinity, which would also disable a ceiling", () => {
    expect(() => parseNumericFlag("Infinity", "--max-spend")).toThrow(/expects a number/);
  });
});

describe("parseNonNegativeFlag", () => {
  it("accepts zero and positives", () => {
    expect(parseNonNegativeFlag("0", "--max-spend")).toBe(0);
    expect(parseNonNegativeFlag("1.5", "--max-spend")).toBe(1.5);
  });

  it("rejects negatives rather than reading them as a small budget", () => {
    expect(() => parseNonNegativeFlag("-1", "--max-spend")).toThrow(/--max-spend must not be negative/);
  });

  it("still rejects non-numbers", () => {
    expect(() => parseNonNegativeFlag("abc", "--max-spend")).toThrow(/expects a number/);
  });
});
