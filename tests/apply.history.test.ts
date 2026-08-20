import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readApplicationHistory, alreadyWorked, describeHistory } from "../src/apply/history.js";

/**
 * The bug: `status` answers "did a human confirm they submitted?" and was read
 * as if it answered "have I been here before?". Four jobs with finished packs,
 * tailored resumes and autofill screenshots on disk were offered back as fresh
 * work, two of them labelled "companies you have never applied to".
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "job-radar-history-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(name: string, when?: string): void {
  const p = resolve(dir, name);
  writeFileSync(p, "x");
  if (when) {
    const t = new Date(when);
    utimesSync(p, t, t);
  }
}

describe("readApplicationHistory", () => {
  it("reports nothing for a job never worked on", () => {
    const h = readApplicationHistory(resolve(dir, "does-not-exist"));
    expect(h.autofillRuns).toBe(0);
    expect(h.hasPack).toBe(false);
    expect(alreadyWorked(h)).toBe(false);
    expect(describeHistory(h)).toBeNull();
  });

  it("counts autofill screenshots and reports the most recent", () => {
    touch("autofill-2026-08-14T22-57-33.png", "2026-08-14T22:57:33Z");
    touch("autofill-2026-08-19T01-58-02.png", "2026-08-19T01:58:02Z");
    touch("pack.json");

    const h = readApplicationHistory(dir);
    expect(h.autofillRuns).toBe(2);
    expect(h.hasPack).toBe(true);
    expect(h.lastAutofill?.slice(0, 10)).toBe("2026-08-19");
    expect(alreadyWorked(h)).toBe(true);
    expect(describeHistory(h)).toContain("FORM ALREADY FILLED 2026-08-19");
  });

  /*
   * This is the exact state the four missed jobs were in: everything generated,
   * the form driven, and `status` still APPLY because `autofill` will not write
   * APPLIED without an explicit human yes. That refusal is correct and stays -
   * so the "have I been here" signal has to come from somewhere else.
   */
  it("detects work done even though nothing confirms submission", () => {
    touch("pack.json");
    touch("Josh_A_Shearer_Resume_Resend.pdf");
    touch("autofill-2026-08-14T23-36-37.png", "2026-08-14T23:36:37Z");
    touch("autofill-report.md");

    const h = readApplicationHistory(dir);
    expect(alreadyWorked(h)).toBe(true);
    expect(h.hasResume).toBe(true);
    // It must not claim submission, only that the work happened.
    expect(JSON.stringify(h)).not.toContain("submitted");
  });

  /*
   * A pack alone is not evidence of engagement. `apply` generates one cheaply
   * and a human may never have looked at it, so treating it as "already worked"
   * would hide jobs that genuinely still need doing - the opposite failure.
   */
  it("does not treat a generated pack alone as work already done", () => {
    touch("pack.json");
    touch("application-pack.md");

    const h = readApplicationHistory(dir);
    expect(h.hasPack).toBe(true);
    expect(alreadyWorked(h)).toBe(false);
    expect(describeHistory(h)).toBe("pack prepared");
  });

  it("ignores non-screenshot files that merely start with autofill", () => {
    touch("autofill-report.md");
    const h = readApplicationHistory(dir);
    expect(h.autofillRuns).toBe(0);
    expect(alreadyWorked(h)).toBe(false);
  });

  it("notes repeat attempts", () => {
    for (let i = 1; i <= 4; i += 1) touch(`autofill-2026-08-1${i}T10-00-00.png`, `2026-08-1${i}T10:00:00Z`);
    expect(describeHistory(readApplicationHistory(dir))).toContain("x4");
  });

  it("survives an unreadable directory rather than throwing mid-listing", () => {
    const nested = resolve(dir, "sub");
    mkdirSync(nested);
    expect(() => readApplicationHistory(nested)).not.toThrow();
    expect(readApplicationHistory(nested).autofillRuns).toBe(0);
  });
});
