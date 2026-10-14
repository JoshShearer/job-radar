import { describe, it, expect } from "vitest";
import { matchEmailToJob, mentionsCompany, type Candidate } from "../src/domain/outcomes/match.js";

const NOW = Date.parse("2026-08-20T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const job = (over: Partial<Candidate>): Candidate => ({
  id: "j1",
  company: "Vanta",
  title: "Senior Fullstack Engineer",
  state: "submitted",
  submittedAt: daysAgo(10),
  ...over,
});

const mail = (over: Partial<{ from: string; subject: string; body: string; receivedAt: string }> = {}) => ({
  from: "no-reply@greenhouse.io",
  subject: "Your application to Vanta",
  body: "Thank you for applying to Vanta.",
  receivedAt: daysAgo(1),
  ...over,
});

/**
 * The rule this file exists to enforce, from the issue: two applications at
 * the same company must not be guessed between.
 */
describe("matchEmailToJob", () => {
  it("matches when there is exactly one application at that company", () => {
    const r = matchEmailToJob(mail(), [job({ id: "j1" })]);
    expect(r.kind).toBe("matched");
    if (r.kind === "matched") expect(r.job.id).toBe("j1");
  });

  it("REFUSES to choose between two applications at the same company", () => {
    // A rejection from Samsara when three Samsara roles are in flight
    // identifies a company, not a job. Picking the most recent would silently
    // close two live applications.
    const r = matchEmailToJob(mail({ subject: "Update on your Samsara application", body: "Regarding Samsara." }), [
      job({ id: "a", company: "Samsara", title: "Staff Software Engineer" }),
      job({ id: "b", company: "Samsara", title: "Senior AI Engineer" }),
      job({ id: "c", company: "Samsara", title: "Solutions Integration Engineer" }),
    ]);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.jobs).toHaveLength(3);
  });

  it("resolves that ambiguity only when the email names one title outright", () => {
    const r = matchEmailToJob(
      mail({ subject: "Samsara - Staff Software Engineer", body: "Regarding your Samsara application." }),
      [
        job({ id: "a", company: "Samsara", title: "Staff Software Engineer" }),
        job({ id: "b", company: "Samsara", title: "Senior AI Engineer" }),
      ],
    );
    expect(r.kind).toBe("matched");
    if (r.kind === "matched") expect(r.job.id).toBe("a");
  });

  it("stays ambiguous when a title matches two jobs", () => {
    const r = matchEmailToJob(mail({ subject: "Samsara - Software Engineer", body: "Samsara." }), [
      job({ id: "a", company: "Samsara", title: "Software Engineer" }),
      job({ id: "b", company: "Samsara", title: "Software Engineer" }),
    ]);
    expect(r.kind).toBe("ambiguous");
  });

  it("reports unmatched rather than attaching mail to the nearest job", () => {
    const r = matchEmailToJob(mail({ subject: "Your Stripe application", body: "Stripe." }), [
      job({ company: "Vanta" }),
    ]);
    expect(r.kind).toBe("unmatched");
  });

  it("ignores an application made after the email arrived", () => {
    // An email cannot be about an application that did not exist yet.
    const r = matchEmailToJob(mail({ receivedAt: daysAgo(30) }), [
      job({ id: "old", submittedAt: daysAgo(40) }),
      job({ id: "new", submittedAt: daysAgo(2) }),
    ]);
    expect(r.kind).toBe("matched");
    if (r.kind === "matched") expect(r.job.id).toBe("old");
  });
});

describe("mentionsCompany", () => {
  it("matches a company named in the body", () => {
    expect(mentionsCompany("Vanta", { from: "x@greenhouse.io", subject: "hi", body: "about Vanta" })).toBe(true);
  });

  it("matches a company only present in the sender domain", () => {
    // Recruiters reply from their own addresses and never repeat the company.
    expect(mentionsCompany("Vanta", { from: "sarah@vanta.com", subject: "hi", body: "let's talk" })).toBe(true);
  });

  it("requires every distinctive token, so one common word is not enough", () => {
    expect(
      mentionsCompany("Clear Street", { from: "x@greenhouse.io", subject: "street parking", body: "the street" }),
    ).toBe(false);
  });

  it("is not fooled by the ATS domain itself", () => {
    expect(mentionsCompany("Greenhouse", { from: "no-reply@greenhouse.io", subject: "Vanta", body: "Vanta" })).toBe(
      true,
    );
    expect(mentionsCompany("Vanta", { from: "no-reply@greenhouse.io", subject: "hello", body: "hello" })).toBe(false);
  });
});

/**
 * GHOSTED cannot come from a parser: no email ever says "we are ghosting you".
 */
