import { describe, it, expect } from "vitest";
import { buildDailyReport } from "../src/report/daily.js";
import type { CareerProfile, SourcesConfig } from "../src/config/schema.js";
import { GHOSTED_AFTER_DAYS, STALE_AFTER_DAYS } from "../src/model/status.js";
import { memoryRepo, seedJob, daysAgo } from "./helpers/db.js";

// Only the handful of keys buildDailyReport actually reads. Built by hand
// rather than loaded from config/career-profile.yaml so a tuning change to the
// real profile cannot turn these assertions red.
const profile = {
  scoring: { report_threshold: 60 },
  report: { max_total: 10, max_priority_a: 5, max_priority_b: 5, max_priority_c: 5 },
} as unknown as CareerProfile;

function sources(over: { remoteok?: boolean } = {}): SourcesConfig {
  return {
    watchlist: [],
    sources: { remoteok: { enabled: over.remoteok ?? false } },
  } as unknown as SourcesConfig;
}

function report(repo: ReturnType<typeof memoryRepo>["repo"], srcs = sources()): string {
  return buildDailyReport({ repo, profile, sources: srcs }).markdown;
}

describe("outcome capture in the daily briefing", () => {
  it("asks for an outcome on a role that has gone quiet", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, {
      company: "Acme",
      title: "Staff Engineer",
      status: "APPLIED",
      statusChangedAt: daysAgo(STALE_AFTER_DAYS.APPLIED! + 4),
    });

    const md = report(repo);
    expect(md).toContain("### Needs an outcome");
    // The command has to carry the real id, or it is not lower friction than
    // going and looking the id up.
    expect(md).toContain(`npm run cli -- status ${id}`);
    expect(md).toContain("Acme - Staff Engineer");
  });

  it("leaves a role that is still inside its response window alone", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED", statusChangedAt: daysAgo(1) });

    const md = report(repo);
    expect(md).toContain("## In flight");
    expect(md).not.toContain("### Needs an outcome");
  });

  it("calls out a long silence as probably ghosted, and still only suggests it", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED", statusChangedAt: daysAgo(GHOSTED_AFTER_DAYS + 5) });

    const md = report(repo);
    // The number in the sentence has to come from the constant, or moving the
    // threshold leaves the briefing quoting a rule it is no longer applying.
    expect(md).toContain(`no reply in ${GHOSTED_AFTER_DAYS}+ days, probably ghosted`);
    // Suggested, never applied: the row is still APPLIED in the database.
    expect(repo.inFlight()[0]!.status).toBe("APPLIED");
  });

  it("omits the section entirely when nothing is in flight", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "NEW" });

    const md = report(repo);
    expect(md).not.toContain("### Needs an outcome");
    expect(md).toContain("Nothing submitted or in progress");
  });

  it("only suggests statuses that exist", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED", statusChangedAt: daysAgo(GHOSTED_AFTER_DAYS + 1) });

    // The briefing used to tell the user to run `status <id> SKIP`, which is
    // not one of STATUSES and fails on entry.
    expect(report(repo)).not.toMatch(/status <job-id> SKIP\b/);
  });
});

describe("Remote OK attribution", () => {
  it("is emitted when the source is enabled", () => {
    const { repo } = memoryRepo();
    const md = report(repo, sources({ remoteok: true }));
    expect(md).toContain("https://remoteok.com");
    expect(md).toContain("Remote OK is the source");
  });

  it("is absent when the source is disabled", () => {
    const { repo } = memoryRepo();
    expect(report(repo, sources({ remoteok: false }))).not.toContain("remoteok.com");
  });
});

describe("Remote OK attribution survives the source being disabled", () => {
  /**
   * JOB-37 disabled the remoteok source on the scorecard. 273 of its postings
   * remain in the index and can still be recommended, and their terms are
   * about DISPLAYING listings, not about fetching them - so attribution keyed
   * on `enabled` would have published them with the credit silently removed.
   */
  it("credits Remote OK when one of its postings is in the report, source disabled", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { company: "Somewhere", applicationRoi: 90, fitScore: 90, priority: "A" });
    db.prepare("UPDATE jobs SET source = 'remoteok' WHERE id = ?").run(id);

    const md = report(repo, sources({ remoteok: false }));
    expect(md).toContain("remoteok.com");
  });

  it("still credits Remote OK while the source is enabled", () => {
    const { repo } = memoryRepo();
    expect(report(repo, sources({ remoteok: true }))).toContain("remoteok.com");
  });

  it("does not credit Remote OK when it is disabled and none of its postings appear", () => {
    // The attribution is a condition of displaying their listings, not a
    // permanent footer.
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Somewhere", applicationRoi: 90, fitScore: 90, priority: "A" });
    expect(report(repo, sources({ remoteok: false }))).not.toContain("remoteok.com");
  });
});
