import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { chooseResume, describeResumeChoice, findResume } from "../src/apply/resume-file.js";
import { renderOutcomes, type AutofillResult, type FieldOutcome } from "../src/apply/autofill.js";
import type { EnrichedJob } from "../src/model/job.js";

/**
 * Attaching the wrong resume to a real application is silent and unrecoverable
 * once a human presses submit. These tests pin the two properties that make the
 * choice trustworthy: it follows the filesystem's recency, and it produces the
 * same answer every run on the same directory.
 */

let dir: string;

/** Write a file and set its mtime. Seconds apart, because some filesystems
 * only carry 1s granularity and a sub-second gap would collapse into a tie. */
function file(name: string, ageSeconds: number): string {
  const path = resolve(dir, name);
  writeFileSync(path, "%PDF-1.4\n", "utf8");
  const when = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - ageSeconds * 1000);
  utimesSync(path, when, when);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "job-radar-resumes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findResume", () => {
  it("picks the newest file when alphabetical order disagrees with mtime", () => {
    // The exact pair from the issue. Alphabetically `Dev_March2025` sorts last,
    // so the old implementation returned it; by mtime it is a year stale.
    const stale = file("Shearer_Resume_Dev_March2025.pdf", 400 * 24 * 3600);
    const current = file("Shearer_Resume_2026.pdf", 10);

    expect(basename(stale) > basename(current)).toBe(true); // alphabetical says stale
    expect(findResume(dir)).toBe(current); // mtime says otherwise, and mtime wins
  });

  it("returns an absolute path", () => {
    const p = file("resume.pdf", 5);
    expect(findResume(dir)).toBe(p);
    expect(findResume(dir)?.startsWith("/")).toBe(true);
  });

  it("accepts the documented resume extensions and nothing else", () => {
    file("a.pdf", 100);
    file("b.doc", 200);
    file("c.docx", 300);
    file("d.txt", 400);
    file("e.rtf", 500);
    file("notes.md", 1);
    file("headshot.png", 2);
    file("README", 3);

    const choice = chooseResume(undefined, dir);
    const names = [choice!.path, ...choice!.passedOver].map((p) => basename(p)).sort();
    expect(names).toEqual(["a.pdf", "b.doc", "c.docx", "d.txt", "e.rtf"]);
  });

  it("is case-insensitive about the extension", () => {
    const upper = file("Resume.PDF", 5);
    expect(findResume(dir)).toBe(upper);
  });

  it("ignores a directory whose name ends in a resume extension", () => {
    // `setInputFiles` throws on a directory, which would abort a real run.
    mkdirSync(resolve(dir, "archive.pdf"));
    const real = file("resume.pdf", 500);
    expect(findResume(dir)).toBe(real);
  });

  it("returns null for an empty directory and for one that does not exist", () => {
    expect(findResume(dir)).toBeNull();
    expect(findResume(resolve(dir, "nope"))).toBeNull();
  });

  it("returns null when a directory holds no resume-shaped files", () => {
    file("notes.md", 1);
    expect(findResume(dir)).toBeNull();
  });
});

describe("tie-breaking", () => {
  it("resolves identical mtimes deterministically", () => {
    file("aardvark.pdf", 60);
    file("mongoose.pdf", 60);
    file("zebra.pdf", 60);

    const first = chooseResume(undefined, dir)!;
    expect(basename(first.path)).toBe("zebra.pdf");
    expect(first.passedOver.map((p) => basename(p))).toEqual(["mongoose.pdf", "aardvark.pdf"]);

    // Same directory, same answer, every run - including the full ordering,
    // not just the winner.
    for (let i = 0; i < 5; i++) {
      const again = chooseResume(undefined, dir)!;
      expect(again.path).toBe(first.path);
      expect(again.passedOver).toEqual(first.passedOver);
    }
  });

  it("compares byte-wise, so the ordering does not depend on the machine's locale", () => {
    // Byte-wise, every uppercase letter precedes every lowercase one, so "a"
    // wins a descending sort against "B". A locale-aware collator orders these
    // the other way round, which would make the same directory resolve
    // differently on two machines.
    file("a.pdf", 60);
    file("B.pdf", 60);
    expect(basename(chooseResume(undefined, dir)!.path)).toBe("a.pdf");
  });

  it("breaks ties only after mtime, never instead of it", () => {
    file("zebra.pdf", 9000); // alphabetically first in a descending sort, but old
    const newer = file("aardvark.pdf", 5);
    expect(findResume(dir)).toBe(newer);
  });
});

describe("chooseResume", () => {
  it("reports what it passed over, newest first", () => {
    const oldest = file("2024.pdf", 3000);
    const middle = file("2025.pdf", 2000);
    const newest = file("2026.pdf", 1000);

    const choice = chooseResume(undefined, dir)!;
    expect(choice.path).toBe(newest);
    expect(choice.source).toBe("newest");
    expect(choice.passedOver).toEqual([middle, oldest]);
  });

  it("passes over nothing when there is only one candidate", () => {
    const only = file("resume.pdf", 10);
    const choice = chooseResume(undefined, dir)!;
    expect(choice.path).toBe(only);
    expect(choice.passedOver).toEqual([]);
  });

  it("prefers the tailored resume over a newer generic one", () => {
    const generic = file("generic.pdf", 1); // newer than the tailored file
    const packDir = mkdtempSync(resolve(tmpdir(), "job-radar-pack-"));
    const tailored = resolve(packDir, "resume.pdf");
    writeFileSync(tailored, "%PDF-1.4\n", "utf8");
    const old = new Date(Date.UTC(2020, 0, 1));
    utimesSync(tailored, old, old);

    try {
      const choice = chooseResume(tailored, dir)!;
      expect(choice.path).toBe(tailored);
      expect(choice.source).toBe("tailored");
      expect(choice.passedOver).toEqual([generic]);
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("never lists the chosen file as something it passed over", () => {
    const inside = file("resume.pdf", 10);
    file("other.pdf", 20);
    const choice = chooseResume(inside, dir)!;
    expect(choice.path).toBe(inside);
    expect(choice.passedOver).not.toContain(inside);
    expect(choice.passedOver.map((p) => basename(p))).toEqual(["other.pdf"]);
  });

  it("falls back to the newest generic when the preferred file is not on disk", () => {
    const generic = file("generic.pdf", 10);
    const choice = chooseResume(resolve(dir, "does-not-exist.pdf"), dir)!;
    // Reported as `newest`, not `tailored` - the report must not claim a
    // provenance the attached file does not have.
    expect(choice.path).toBe(generic);
    expect(choice.source).toBe("newest");
  });

  it("returns null when there is neither a preferred file nor a candidate", () => {
    expect(chooseResume(undefined, dir)).toBeNull();
    expect(chooseResume(resolve(dir, "missing.pdf"), dir)).toBeNull();
  });
});

describe("describeResumeChoice", () => {
  it("names the attached file and what it passed over", () => {
    const newest = file("2026.pdf", 10);
    const older = file("2025.pdf", 2000);
    const detail = describeResumeChoice(chooseResume(undefined, dir)!);
    expect(detail).toContain(basename(newest));
    expect(detail).toContain(basename(older));
    expect(detail).toContain("newest in resumes/");
  });

  it("says nothing about alternatives when there were none", () => {
    file("resume.pdf", 10);
    const detail = describeResumeChoice(chooseResume(undefined, dir)!);
    expect(detail).toBe("attached resume.pdf");
  });

  it("marks a tailored resume as tailored", () => {
    file("generic.pdf", 10);
    const packDir = mkdtempSync(resolve(tmpdir(), "job-radar-pack-"));
    const tailored = resolve(packDir, "resume.pdf");
    writeFileSync(tailored, "%PDF-1.4\n", "utf8");
    try {
      const detail = describeResumeChoice(chooseResume(tailored, dir)!);
      expect(detail).toContain("tailored to this posting");
      expect(detail).toContain("generic.pdf");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  it("caps a long passed-over list instead of printing every file", () => {
    file("newest.pdf", 1);
    for (let i = 0; i < 12; i++) file(`old-${i}.pdf`, 100 + i);
    const detail = describeResumeChoice(chooseResume(undefined, dir)!);
    expect(detail).toContain("more");
    expect(detail.length).toBeLessThan(300);
  });
});

describe("the autofill report", () => {
  it("carries the resume choice through to the rendered markdown", () => {
    // The join between `autofillApplication` and this string needs a live Page
    // and is pinned by JOB-11. What is checked here is that a detail carrying
    // the choice survives into the report a human actually reads.
    const newest = file("2026.pdf", 10);
    file("2025.pdf", 2000);
    const detail = describeResumeChoice(chooseResume(undefined, dir)!);

    const outcomes: FieldOutcome[] = [
      { label: "Resume", intent: "resume", status: "filled", detail },
    ];
    const job = { title: "Staff Engineer", company: "Acme" } as EnrichedJob;
    const result = {
      url: "https://example.com/apply",
      outcomes,
      screenshot: null,
    } as unknown as AutofillResult;

    const md = renderOutcomes(job, result);
    expect(md).toContain(basename(newest));
    expect(md).toContain("2025.pdf");
    expect(md).toContain("NOT SUBMITTED");
  });
});
