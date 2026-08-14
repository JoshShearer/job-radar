import { describe, it, expect } from "vitest";
import {
  documentBase,
  coverLetterName,
  resumeName,
  renderCoverLetterMarkdown,
  renderCoverLetterHtml,
} from "../src/resume/documents.js";

/**
 * JOB-16. Five applications went out with every attachment named
 * `resume.pdf`, and no cover letter attached to any of them.
 *
 * The filename is what a recruiter sees in the attachment list. "resume.pdf"
 * reads as a mass application, and gives the candidate no way to tell one of
 * their own documents from another without opening it.
 */
describe("document naming", () => {
  it("names a resume for the person and the company", () => {
    expect(resumeName("Josh A. Shearer", "Vanta")).toBe("Josh_A_Shearer_Resume_Vanta.pdf");
  });

  it("names a cover letter the same way", () => {
    expect(coverLetterName("Josh A. Shearer", "Vanta")).toBe("Josh_A_Shearer_Cover_Letter_Vanta.pdf");
  });

  it("produces a safe filename from a company with punctuation", () => {
    // Real companies in the index: "Customer.io", "Lemon.io".
    expect(documentBase("Josh A. Shearer", "Customer.io", "Resume")).toBe("Josh_A_Shearer_Resume_Customer_io");
    expect(documentBase("Ada Lovelace", "Foo   Bar", "Resume")).toBe("Ada_Lovelace_Resume_Foo_Bar");
  });

  it("never emits a path separator or a traversal, however the company is written", () => {
    for (const company of ["A/B Testing Co", "Back\\Slash", "../etc", "..", "with space"]) {
      const base = documentBase("Ada Lovelace", company, "Resume");
      expect(base).not.toMatch(/[/\\]/);
      expect(base).not.toContain("..");
      expect(base).not.toContain(" ");
    }
  });

  it("is deterministic, so the writer and the reader agree without a stored mapping", () => {
    expect(documentBase("Josh A. Shearer", "Vanta", "Resume")).toBe(
      documentBase("Josh A. Shearer", "Vanta", "Resume"),
    );
  });

  it("falls back to something usable when the company is empty", () => {
    expect(documentBase("Ada Lovelace", "", "Resume")).toBe("Ada_Lovelace_Resume");
    expect(documentBase("Ada Lovelace", "   ", "Resume")).toBe("Ada_Lovelace_Resume");
  });

  it("does not run away on a very long company name", () => {
    const base = documentBase("Ada Lovelace", "A".repeat(300), "Resume");
    expect(base.length).toBeLessThanOrEqual(120);
  });
});

/**
 * The renderer lays out text it was given. It does not write prose about the
 * candidate - `prepareApplication` does that, under the never-invent-experience
 * prompt - so there is nothing here that can add a claim.
 */
describe("cover letter rendering", () => {
  const note = "Hi - applying for the role.\n\nI built a thing.\n\nJosh Shearer";
  const contact = ["ShearerJosh@protonmail.com", "(360) 461-3810", "Austin, Texas"];

  it("renders the note verbatim, with a header", () => {
    const md = renderCoverLetterMarkdown("Josh A. Shearer", "Vanta", "Sr. AI GTM Engineer", note, contact);
    expect(md).toContain("Josh A. Shearer");
    expect(md).toContain("ShearerJosh@protonmail.com");
    expect(md).toContain("Sr. AI GTM Engineer");
    expect(md).toContain("Vanta");
    for (const line of note.split("\n").filter(Boolean)) expect(md).toContain(line);
  });

  it("adds no prose of its own beyond the header and the note", () => {
    const md = renderCoverLetterMarkdown("Ada Lovelace", "Acme", "Engineer", "Just this.", []);
    const body = md.slice(md.indexOf("Just this."));
    expect(body.trim()).toBe("Just this.");
  });

  it("escapes HTML rather than letting the note inject markup", () => {
    const html = renderCoverLetterHtml("Ada", "Acme", "Eng", "<script>alert(1)</script> & co", []);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("keeps paragraph breaks", () => {
    const html = renderCoverLetterHtml("Ada", "Acme", "Eng", "One.\n\nTwo.\n\nThree.", []);
    expect((html.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("works with no contact line configured", () => {
    const md = renderCoverLetterMarkdown("Ada", "Acme", "Eng", "Body.", []);
    expect(md).toContain("Body.");
    expect(md).not.toContain("undefined");
  });
});
