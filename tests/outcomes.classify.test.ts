import { describe, it, expect } from "vitest";
import { classifyEmail, isAtsSender, extractAddress, senderDomain, stateForKinds } from "../src/domain/outcomes/classify.js";

const email = (subject: string, body: string, from = "no-reply@greenhouse.io") => ({ from, subject, body });

/**
 * JOB-26. The tracker showed 43 applications and zero results - not because
 * nothing happened, but because nothing wrote it down.
 *
 * These are deliberately written as whole realistic messages rather than the
 * phrases in isolation, because the failure mode that matters is a real
 * rejection that opens by thanking you for applying.
 */
describe("classifyEmail", () => {
  it("reads a real ATS rejection, which opens like a confirmation", () => {
    const c = classifyEmail(
      email(
        "Your application to Vanta",
        `Hi Josh,\n\nThank you for applying to Vanta and for your interest in the ` +
          `Senior Fullstack Engineer role.\n\nAfter careful review, we have decided to ` +
          `move forward with other candidates whose experience more closely matches ` +
          `what we need right now.\n\nBest,\nThe Vanta Team`,
      ),
    );
    // The confirmation phrasing must not survive alongside the rejection, or
    // every real rejection would land in review as "ambiguous".
    expect(c.kinds).toEqual(["rejection"]);
    expect(stateForKinds(c.kinds)).toBe("rejected");
  });

  it("reads an interview invite that also thanks you for applying", () => {
    const c = classifyEmail(
      email(
        "Next steps - Deepgram",
        `Thanks for applying to Deepgram! We'd love to schedule a call with you ` +
          `this week. Here's my calendly.com/deepgram-recruiting link.`,
      ),
    );
    expect(c.kinds).toEqual(["interview"]);
    expect(stateForKinds(c.kinds)).toBe("screen");
  });

  it("reads a bare confirmation as a confirmation", () => {
    const c = classifyEmail(
      email("We received your application", "Thanks for applying to Render. We have received your application."),
    );
    expect(c.kinds).toEqual(["confirmation"]);
    // Not a step forward: `apply` already recorded APPLIED.
    expect(stateForKinds(c.kinds)).toBeNull();
  });

  it("reads an offer", () => {
    const c = classifyEmail(email("Offer - Infisical", "We are pleased to extend an offer for the role."));
    expect(c.kinds).toEqual(["offer"]);
    expect(stateForKinds(c.kinds)).toBe("offer");
  });

  it("does not treat a bare 'unfortunately' as a rejection", () => {
    // It appears in scheduling mail too. A false REJECTED closes a live
    // application in the tracker and a person may never look at it again.
    const c = classifyEmail(
      email("Rescheduling", "Unfortunately I need to move our call to Thursday. Does that work?"),
    );
    expect(c.kinds).not.toContain("rejection");
  });

  it("does not invent a verdict from a newsletter", () => {
    expect(classifyEmail(email("This week in engineering", "Here are five articles.")).kinds).toEqual([]);
  });

  it("hands a genuinely two-sided email back as ambiguous", () => {
    // Rejected for one role, invited for another, in one message. There is no
    // correct single answer, so there must not be an automatic one.
    const c = classifyEmail(
      email(
        "Update on your applications",
        `We will not be moving forward for the Staff role. However, we would like ` +
          `to invite you to an interview for the Senior role.`,
      ),
    );
    expect(c.kinds.sort()).toEqual(["interview", "rejection"]);
    expect(stateForKinds(c.kinds)).toBeNull();
  });

  it("reads a phrase that a mail client wrapped across a line break", () => {
    // ATS mail is hard-wrapped at about 72 characters, so the phrases land
    // across line breaks constantly. A real Samsara rejection read
    // "decided not to\nproceed" and, before whitespace was collapsed, matched
    // nothing but the confirmation pattern - it looked like it worked.
    const c = classifyEmail(
      email(
        "Update on your Samsara application",
        "Thanks for your interest in Samsara. Unfortunately we have decided not to\nproceed with your application.",
      ),
    );
    expect(c.kinds).toEqual(["rejection"]);
  });

  it("survives wrapping in every rejection and interview phrase", () => {
    const wrapped = [
      "we have decided to move forward with\nother candidates",
      "we will not be\nmoving forward",
      "we would like to schedule a\ncall",
      "we are pleased to\nextend an offer",
    ];
    for (const w of wrapped) {
      expect(classifyEmail(email("Update", w)).kinds.length).toBe(1);
    }
  });

  it("records the phrase that matched, so a status change can explain itself", () => {
    const c = classifyEmail(email("Update", "we have decided to move forward with other candidates"));
    expect(c.evidence.join(" ")).toMatch(/move forward with other candidates/i);
  });
});

describe("sender handling", () => {
  it("pulls the address out of a display-name header", () => {
    expect(extractAddress("Greenhouse <no-reply@greenhouse.io>")).toBe("no-reply@greenhouse.io");
    expect(extractAddress("no-reply@greenhouse.io")).toBe("no-reply@greenhouse.io");
  });

  it("recognises the ATS platforms the tool already ingests from", () => {
    for (const f of [
      "no-reply@greenhouse.io",
      "Lever <no-reply@hire.lever.co>",
      "notifications@ashbyhq.com",
      "x@myworkdayjobs.com",
      "x@smartrecruiters.com",
    ]) {
      expect(isAtsSender(f)).toBe(true);
    }
  });

  it("does not claim a recruiter's own address is an ATS", () => {
    // Not a rejection of the email - the matcher still handles company mail.
    // This flag only decides what the cheap prefilter sweeps in.
    expect(isAtsSender("sarah@vanta.com")).toBe(false);
  });

  it("extracts the domain for company matching", () => {
    expect(senderDomain("Sarah <sarah@vanta.com>")).toBe("vanta.com");
  });
});
