import { describe, it, expect } from "vitest";
import { parseGmailMessage, parseEml, type GmailMessage } from "../src/inbox/source.js";
import { mayTransition } from "../src/inbox/scan.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/**
 * Pins the payload shape, the same rule `tests/sources.test.ts` applies to
 * every job-board adapter: a provider renaming a field should surface as a
 * failing test rather than as an inbox that silently reads nothing.
 */
describe("parseGmailMessage", () => {
  const message: GmailMessage = {
    id: "18f0c0ffee",
    internalDate: "1755640000000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Greenhouse <no-reply@greenhouse.io>" },
        { name: "Subject", value: "Your application to Vanta" },
        { name: "Date", value: "Wed, 19 Aug 2026 18:04:11 +0000" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("We are moving forward with other candidates.") } },
        { mimeType: "text/html", body: { data: b64("<p>We are moving forward with other candidates.</p>") } },
      ],
    },
  };

  it("reads headers case-insensitively and decodes base64url", () => {
    const e = parseGmailMessage(message);
    expect(e.id).toBe("18f0c0ffee");
    expect(e.from).toBe("Greenhouse <no-reply@greenhouse.io>");
    expect(e.subject).toBe("Your application to Vanta");
    expect(e.body).toContain("moving forward with other candidates");
  });

  it("prefers internalDate over the Date header", () => {
    // internalDate is when Gmail received it; the Date header is whatever the
    // sender claimed, and senders get it wrong.
    expect(parseGmailMessage(message).receivedAt).toBe(new Date(1755640000000).toISOString());
  });

  it("falls back to the HTML part when there is no plain text", () => {
    const htmlOnly: GmailMessage = {
      id: "x",
      payload: {
        mimeType: "text/html",
        headers: [{ name: "From", value: "a@b.com" }, { name: "Subject", value: "hi" }],
        body: { data: b64("<p>We will not be moving forward.</p>") },
      },
    };
    expect(parseGmailMessage(htmlOnly).body).toContain("not be moving forward");
  });

  it("finds a part nested several levels down", () => {
    const nested: GmailMessage = {
      id: "x",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "a@b.com" }],
        parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("deep") } }] }],
      },
    };
    expect(parseGmailMessage(nested).body).toBe("deep");
  });

  it("does not throw on a message with no payload at all", () => {
    expect(() => parseGmailMessage({ id: "x" })).not.toThrow();
  });
});

describe("parseEml", () => {
  it("splits headers from body and reads the date", () => {
    const e = parseEml(
      "f.eml",
      "From: A <a@b.com>\nSubject: Hello\nDate: Wed, 19 Aug 2026 18:04:11 +0000\nMessage-ID: <m1@b.com>\n\nBody text here.",
    );
    expect(e.from).toBe("A <a@b.com>");
    expect(e.subject).toBe("Hello");
    expect(e.id).toBe("<m1@b.com>");
    expect(e.body).toBe("Body text here.");
  });

  it("unfolds a wrapped header", () => {
    // A long Subject is folded onto a continuation line; without unfolding,
    // everything after the first line is lost.
    const e = parseEml("f.eml", "From: a@b.com\nSubject: A very long subject that\n  continues here\n\nbody");
    expect(e.subject).toBe("A very long subject that continues here");
  });

  it("falls back to the filename when there is no Message-ID", () => {
    expect(parseEml("fallback.eml", "From: a@b.com\n\nbody").id).toBe("fallback.eml");
  });
});

/**
 * A later email in a thread often repeats the scheduling language, so an
 * interview invite must not drag a job that already reached INTERVIEW back
 * to SCREEN.
 */
describe("mayTransition", () => {
  it("accepts a rejection from anywhere in flight", () => {
    for (const from of ["APPLIED", "SCREEN", "INTERVIEW", "FINAL", "OFFER"]) {
      expect(mayTransition(from, "REJECTED")).toBe(true);
    }
  });

  it("does not move a job backwards to SCREEN", () => {
    expect(mayTransition("INTERVIEW", "SCREEN")).toBe(false);
    expect(mayTransition("OFFER", "SCREEN")).toBe(false);
    expect(mayTransition("APPLIED", "SCREEN")).toBe(true);
  });

  it("does not resurrect a closed application", () => {
    for (const from of ["REJECTED", "WITHDRAWN", "GHOSTED"]) {
      expect(mayTransition(from, "SCREEN")).toBe(false);
      expect(mayTransition(from, "REJECTED")).toBe(false);
    }
  });
});
