import { describe, expect, it } from "vitest";
import { foldApplication, foldPursuit, furthestStage, type StateEvent, type ApplicationState, type PursuitState } from "../src/domain/pursuit/machines.js";
import { buildFunnel, formatRate } from "../src/domain/pursuit/funnel.js";
import { silenceVerdict } from "../src/domain/outcomes/ghost.js";

let n = 0;
const app = (to: ApplicationState, at: string, actor: "human" | "mail" = "mail"): StateEvent<ApplicationState> => ({ id: ++n, to, occurredAt: at, actor, note: null });
const pur = (to: PursuitState, at: string): StateEvent<PursuitState> => ({ id: ++n, to, occurredAt: at, actor: "human", note: null });

describe("application fold", () => {
  it("an older invitation processed AFTER a newer rejection cannot undo it (the audit's R3 case)", () => {
    const rejection = app("rejected", "2026-09-20T00:00:00Z");
    const invite = app("screen", "2026-09-10T00:00:00Z");
    // Recorded rejection first, invitation second (ids ascending): order of RECORDING.
    expect(foldApplication([rejection, invite]).state).toBe("rejected");
    expect(foldApplication([invite, rejection]).state).toBe("rejected");
  });

  it("orders by instant, not by string: offsets and legacy SQLite times sort correctly", () => {
    // 09:30 at +02:00 is 07:30Z, BEFORE 08:00Z; as text it sorts after.
    const a = foldApplication([app("rejected", "2026-09-10T08:00:00Z"), app("screen", "2026-09-10T09:30:00+02:00")]);
    expect(a.steps.map((s) => s.event.to)).toEqual(["screen", "rejected"]);
    // A legacy "YYYY-MM-DD HH:MM:SS" (UTC) at 09:00 is AFTER 08:00Z; as text (" " < "T") it sorts before.
    const b = foldApplication([app("screen", "2026-09-10T08:00:00Z"), app("interview", "2026-09-10 09:00:00")]);
    expect(b.steps.map((s) => s.event.to)).toEqual(["screen", "interview"]);
    expect(b.state).toBe("interview");
  });

  it("ignores a backwards repeat of scheduling language", () => {
    const f = foldApplication([app("interview", "2026-09-10T00:00:00Z"), app("screen", "2026-09-12T00:00:00Z")]);
    expect(f.state).toBe("interview");
    expect(f.steps[1]!.applied).toBe(false);
  });

  it("terminal states stay terminal", () => {
    expect(foldApplication([app("withdrawn", "2026-09-10T00:00:00Z"), app("offer", "2026-09-12T00:00:00Z")]).state).toBe("withdrawn");
  });

  it("a late reply revives a ghosted application", () => {
    expect(foldApplication([app("ghosted", "2026-09-10T00:00:00Z", "human"), app("screen", "2026-09-20T00:00:00Z")]).state).toBe("screen");
  });

  it("cannot be ghosted after real contact", () => {
    expect(foldApplication([app("screen", "2026-09-10T00:00:00Z"), app("ghosted", "2026-10-20T00:00:00Z", "human")]).state).toBe("screen");
  });

  it("a voided event is skipped, not deleted", () => {
    const wrong = app("rejected", "2026-09-10T00:00:00Z");
    const f = foldApplication([wrong], [{ id: 999, voids: wrong.id }]);
    expect(f.state).toBe("submitted");
    expect(f.steps[0]!.reason).toBe("voided");
  });

  it("furthest stage survives a later rejection (for the funnel)", () => {
    const f = foldApplication([app("screen", "2026-09-01T00:00:00Z"), app("interview", "2026-09-05T00:00:00Z"), app("rejected", "2026-09-09T00:00:00Z")]);
    expect(f.state).toBe("rejected");
    expect(furthestStage(f)).toBe("interview");
  });
});

describe("pursuit fold", () => {
  it("allows the human path and refuses nonsense", () => {
    const f = foldPursuit([pur("reviewed", "2026-09-01T00:00:00Z"), pur("shortlisted", "2026-09-02T00:00:00Z"), pur("new", "2026-09-03T00:00:00Z")]);
    expect(f.state).toBe("shortlisted");
    expect(f.steps[2]!.applied).toBe(false);
  });
  it("applied is final for the pursuit", () => {
    expect(foldPursuit([pur("applied", "2026-09-01T00:00:00Z"), pur("skipped", "2026-09-02T00:00:00Z")]).state).toBe("applied");
  });
});

describe("funnel", () => {
  it("refuses to diagnose below the sample floor and never shows a bare rate", () => {
    const r = buildFunnel({ discovered: 100, eligible: 10, furthest: ["submitted", "screen"] });
    expect(r.sampleWarning).toMatch(/Only 2/);
    expect(r.hypotheses).toEqual([]);
    expect(formatRate(1, 1)).toBe("100% (n=1)");
    expect(formatRate(null, 0)).toBe("n/a");
    expect(formatRate(0.001, 2000)).toBe("<1% (n=2000)");
  });
});

describe("silence is not evidence without observation", () => {
  const cand = { applicationId: "a", company: "Acme", title: "Eng", state: "submitted", lastContactAt: "2026-08-01T00:00:00Z" };
  const now = new Date("2026-10-01T00:00:00Z");
  const opts = { afterDays: 30, maxCoverageAgeDays: 3, now };
  it("never-scanned mailbox: unobserved, not ghosted", () => {
    expect(silenceVerdict(cand, null, opts).kind).toBe("unobserved");
  });
  it("coverage that starts after the silence began: unobserved", () => {
    expect(silenceVerdict(cand, { from: "2026-09-15T00:00:00Z", to: "2026-09-30T23:00:00Z" }, opts).kind).toBe("unobserved");
  });
  it("stale coverage: unobserved", () => {
    expect(silenceVerdict(cand, { from: "2026-07-01T00:00:00Z", to: "2026-09-10T00:00:00Z" }, opts).kind).toBe("unobserved");
  });
  it("read the whole time and still silent: a SUGGESTION, which a human confirms", () => {
    expect(silenceVerdict(cand, { from: "2026-07-01T00:00:00Z", to: "2026-09-30T23:00:00Z" }, opts).kind).toBe("suggest_ghosted");
  });
  it("not silent long enough", () => {
    expect(silenceVerdict({ ...cand, lastContactAt: "2026-09-20T00:00:00Z" }, null, opts).kind).toBe("not_silent");
  });
});
