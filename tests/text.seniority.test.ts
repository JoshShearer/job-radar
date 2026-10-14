import { describe, it, expect } from "vitest";
import { classifySeniority, isBelowSenior, classifyEmployment } from "../src/domain/text/seniority.js";

describe("classifySeniority", () => {
  it("detects senior", () => {
    expect(classifySeniority("Senior Software Engineer").level).toBe("senior");
    expect(classifySeniority("Sr. Full Stack Engineer").level).toBe("senior");
  });

  it("detects staff and principal", () => {
    expect(classifySeniority("Staff Engineer").level).toBe("staff");
    expect(classifySeniority("Principal Engineer").level).toBe("lead");
  });

  it("detects lead and founding", () => {
    expect(classifySeniority("Lead Software Engineer").level).toBe("lead");
    expect(classifySeniority("Founding Engineer").level).toBe("lead");
  });

  it("detects executive titles", () => {
    expect(classifySeniority("VP of Engineering").level).toBe("exec");
    expect(classifySeniority("Head of Growth").level).toBe("exec");
  });

  it("detects junior", () => {
    expect(classifySeniority("Junior Developer").level).toBe("junior");
    expect(classifySeniority("Software Engineering Intern").level).toBe("junior");
    expect(classifySeniority("New Grad Software Engineer").level).toBe("junior");
  });

  it("treats Engineer I/II as below senior", () => {
    expect(classifySeniority("Software Engineer I").atOrAboveSenior).toBe(false);
    expect(classifySeniority("Software Engineer II").atOrAboveSenior).toBe(false);
  });

  it("treats Engineer III as senior-ish", () => {
    expect(classifySeniority("Software Engineer III").atOrAboveSenior).toBe(true);
  });

  it("returns unknown for a bare title", () => {
    expect(classifySeniority("Software Engineer").level).toBe("unknown");
  });
});

describe("isBelowSenior", () => {
  const reject = ["intern", "junior", "new grad", "entry level"];

  it("rejects explicit junior titles", () => {
    expect(isBelowSenior("Junior Software Engineer", reject)).toBe(true);
    expect(isBelowSenior("Software Engineering Intern", reject)).toBe(true);
  });

  it("accepts senior and above", () => {
    expect(isBelowSenior("Senior Software Engineer", reject)).toBe(false);
    expect(isBelowSenior("Staff Engineer", reject)).toBe(false);
  });

  it("does NOT reject an ambiguous bare title", () => {
    // "Software Engineer" at a 30-person startup is frequently a senior role.
    // Rejecting it outright would throw away exactly the small-company roles
    // this system exists to surface.
    expect(isBelowSenior("Software Engineer", reject)).toBe(false);
  });
});

describe("classifyEmployment", () => {
  it("prefers the ATS field", () => {
    expect(classifyEmployment("Engineer", "FullTime", "")).toBe("full_time");
    expect(classifyEmployment("Engineer", "Contract", "")).toBe("contract");
    expect(classifyEmployment("Engineer", "Intern", "")).toBe("internship");
  });

  it("falls back to the title", () => {
    expect(classifyEmployment("Contract Engineer", null, "")).toBe("contract");
    expect(classifyEmployment("Part-time Engineer", null, "")).toBe("part_time");
  });

  it("falls back to the description head", () => {
    expect(classifyEmployment("Engineer", null, "This is a full-time position with benefits.")).toBe("full_time");
  });

  it("returns unknown when nothing says", () => {
    expect(classifyEmployment("Engineer", null, "Build great things.")).toBe("unknown");
  });
});
