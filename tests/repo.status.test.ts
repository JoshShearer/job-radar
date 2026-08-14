import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";

describe("setStatus event log", () => {
  it("appends a timestamped status_changed event with both ends of the move", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "NEW" });

    repo.setStatus(id, "APPLY", "pack prepared");
    repo.setStatus(id, "APPLIED");

    const events = db
      .prepare("SELECT event_type, detail, created_at FROM job_events WHERE job_id = ? ORDER BY id")
      .all(id) as { event_type: string; detail: string; created_at: string }[];

    expect(events.map((e) => e.event_type)).toEqual(["status_changed", "status_changed"]);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ from: "NEW", to: "APPLY", note: "pack prepared" });
    expect(JSON.parse(events[1]!.detail)).toMatchObject({ from: "APPLY", to: "APPLIED" });
    // The timestamp is what the trend-over-time view is built from, so an
    // event without a parseable one is useless even though it exists.
    for (const e of events) expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
  });

  it("returns false and writes nothing for an unknown job", () => {
    const { repo, db } = memoryRepo();
    expect(repo.setStatus("nope", "APPLIED")).toBe(false);
    expect((db.prepare("SELECT COUNT(*) c FROM job_events").get() as { c: number }).c).toBe(0);
  });
});

describe("findByCompany", () => {
  it("matches a name the human would actually type, against the normalized column", () => {
    const { repo, db } = memoryRepo();
    // Seeded through the real normalizer, which strips the legal suffix: the
    // stored value is "acme", so matching raw input against that column would
    // find nothing at all.
    seedJob(db, { company: "Acme Corp, Inc." });
    expect((db.prepare("SELECT company_normalized c FROM jobs").get() as { c: string }).c).toBe("acme");

    expect(repo.findByCompany("Acme Corp, Inc.")).toHaveLength(1);
    expect(repo.findByCompany("acme")).toHaveLength(1);
    expect(repo.findByCompany("ACME")).toHaveLength(1);
    expect(repo.findByCompany("Acme Corp")).toHaveLength(1);
  });

  it("returns every match so an ambiguous name can be refused rather than guessed", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Meta", companyNormalized: "meta" });
    seedJob(db, { company: "Metabase", companyNormalized: "metabase" });

    expect(repo.findByCompany("meta")).toHaveLength(2);
    expect(repo.findByCompany("metab")).toHaveLength(1);
  });

  it("puts in-flight jobs first, so the one being chased resolves over dead ones", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "old", company: "Acme", companyNormalized: "acme", status: "REJECTED" });
    seedJob(db, { id: "live", company: "Acme", companyNormalized: "acme", status: "APPLIED" });

    expect(repo.findByCompany("acme").map((j) => j.id)).toEqual(["live", "old"]);
  });

  it("returns nothing for a query that normalizes away", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Acme", companyNormalized: "acme" });
    // "!!!" has no alphanumerics left after normalization. Matching everything
    // would be the worst possible answer here.
    expect(repo.findByCompany("!!!")).toHaveLength(0);
    expect(repo.findByCompany("  ")).toHaveLength(0);
  });
});
