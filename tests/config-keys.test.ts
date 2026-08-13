import { describe, it, expect } from "vitest";
import { checkTopLevelKeys } from "../src/config/unknown-keys.js";

const RESUME_KEYS = ["basics", "skills", "experience", "projects", "education", "certifications"];
const PERSONAL_KEYS = ["identity", "links", "work_eligibility", "preferences", "answers"];

describe("checkTopLevelKeys", () => {
  it("accepts a file with only known keys", () => {
    expect(() =>
      checkTopLevelKeys({ basics: {}, skills: [], experience: [] }, RESUME_KEYS, "config/resume.yaml"),
    ).not.toThrow();
  });

  it("rejects work-authorization keys pasted into the resume file", () => {
    // The real incident: these were added at the top level of resume.yaml,
    // Zod stripped them silently, lint reported "Ready to tailor", and the
    // work-authorization questions stayed blank on the form.
    const raw = {
      basics: {},
      authorized_to_work_us: true,
      requires_sponsorship: false,
      authorization_option_hint: "I am authorized to work in the country due to my nationality",
    };
    expect(() => checkTopLevelKeys(raw, RESUME_KEYS, "config/resume.yaml")).toThrow(
      /authorized_to_work_us/,
    );
  });

  it("names the file a misplaced key belongs in", () => {
    let message = "";
    try {
      checkTopLevelKeys({ work_eligibility: {} }, RESUME_KEYS, "config/resume.yaml");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("config/personal.yaml");
  });

  it("says when a key needs nesting, not just a different file", () => {
    let message = "";
    try {
      checkTopLevelKeys({ desired_salary: "x" }, PERSONAL_KEYS, "config/personal.yaml");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("nested under");
    expect(message).toContain("preferences");
  });

  it("reports a genuinely unrecognized key without inventing a home for it", () => {
    let message = "";
    try {
      checkTopLevelKeys({ favourite_colour: "blue" }, RESUME_KEYS, "config/resume.yaml");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("favourite_colour");
    expect(message).toContain("not a recognized key");
  });

  it("states that nothing was loaded, so the failure is not read as cosmetic", () => {
    let message = "";
    try {
      checkTopLevelKeys({ nope: 1 }, RESUME_KEYS, "config/resume.yaml");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Nothing was loaded");
  });

  it("ignores non-object input rather than throwing on an empty file", () => {
    for (const raw of [null, undefined, "text", 42, []]) {
      expect(() => checkTopLevelKeys(raw, RESUME_KEYS, "config/resume.yaml")).not.toThrow();
    }
  });

  it("does not flag a key that is valid for the file being checked", () => {
    // `work_eligibility` is misplaced in the resume but correct in personal.
    expect(() =>
      checkTopLevelKeys({ work_eligibility: {} }, PERSONAL_KEYS, "config/personal.yaml"),
    ).not.toThrow();
  });
});
