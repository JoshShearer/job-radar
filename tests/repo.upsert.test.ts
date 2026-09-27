import { describe, it, expect } from "vitest";
import { memoryRepo } from "./helpers/db.js";
import type { NormalizedJob } from "../src/model/job.js";

/**
 * JOB-47 PR4: `upsert`'s related writes as coherent transaction(s).
 *
 * Before this, the new-job path was three separate autocommitted statements
 * (INSERT jobs -> job_sources upsert -> "discovered" event) and the
 * existing-job path was up to five (main UPDATE -> job_sources upsert ->
 * conditional "description_changed" event -> conditional stale-analysis
 * clear -> conditional "salary_changed" event). A failure partway through
 * either path could leave the jobs row committed with none, or only some,
 * of the writes that were supposed to accompany it.
 *
 * Fault injection uses a real isolated SQLite connection (`memoryRepo`) and
 * a trigger, per the established pattern (see repo.saveAnalysis.test.ts) -
 * never a mocked repo.
 */

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "j1",
    externalId: "acme:1",
    source: "greenhouse",
    board: "greenhouse:acme",
    ats: "greenhouse",
    sourceUrl: "https://example.test/j1",
    applicationUrl: null,
    company: "Acme",
    title: "Staff Engineer",
    location: "Remote",
    remoteStatus: "remote",
    employmentType: "full_time",
    seniority: "staff",
    datePosted: null,
    dateDiscovered: new Date().toISOString(),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "USD",
    salaryPeriod: null,
    descriptionClean: "Build things.",
    descriptionHash: "hash-1",
    materialHash: "material-1",
    department: null,
    team: null,
    companySizeEstimate: null,
    companyStage: null,
    industry: null,
    ...over,
  } as NormalizedJob;
}

function eventTypes(db: ReturnType<typeof memoryRepo>["db"], jobId: string): string[] {
  return (
    db.prepare("SELECT event_type FROM job_events WHERE job_id = ? ORDER BY id").all(jobId) as {
      event_type: string;
    }[]
  ).map((r) => r.event_type);
}

describe("upsert: new-job path is one transaction", () => {
  it("rolls back the INSERT if recordSource fails", () => {
    const { repo, db } = memoryRepo();
    db.exec(`
      CREATE TRIGGER fault_inject_job_sources
      BEFORE INSERT ON job_sources
      WHEN NEW.job_id = 'FAULT_INJECT'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() => repo.upsert(job({ id: "FAULT_INJECT" }), "dedupe-1")).toThrow();

    const row = db.prepare("SELECT id FROM jobs WHERE id = ?").get("FAULT_INJECT");
    expect(row).toBeUndefined();
    const sources = db.prepare("SELECT COUNT(*) c FROM job_sources").get() as { c: number };
    expect(sources.c).toBe(0);

    // A subsequent normal call (no sentinel id) must replay cleanly.
    repo.upsert(job({ id: "j-ok" }), "dedupe-ok");
    const ok = db.prepare("SELECT id FROM jobs WHERE id = ?").get("j-ok");
    expect(ok).toBeDefined();
  });

  it("rolls back the INSERT and the recordSource row if the discovered event fails", () => {
    const { repo, db } = memoryRepo();
    db.exec(`
      CREATE TRIGGER fault_inject_discovered_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'discovered' AND NEW.job_id = 'FAULT_INJECT'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() => repo.upsert(job({ id: "FAULT_INJECT" }), "dedupe-1")).toThrow();

    // No orphan job row.
    const row = db.prepare("SELECT id FROM jobs WHERE id = ?").get("FAULT_INJECT");
    expect(row).toBeUndefined();
    // No orphan job_sources row either.
    const sources = db.prepare("SELECT COUNT(*) c FROM job_sources").get() as { c: number };
    expect(sources.c).toBe(0);
    const events = db.prepare("SELECT COUNT(*) c FROM job_events").get() as { c: number };
    expect(events.c).toBe(0);

    // A subsequent normal call must replay cleanly - nothing left to trip over.
    repo.upsert(job({ id: "j-ok" }), "dedupe-ok");
    expect(eventTypes(db, "j-ok")).toEqual(["discovered"]);
  });
});

describe("upsert: existing-job path is one transaction", () => {
  it("rolls back the whole update if the description_changed event fails", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");

    db.exec(`
      CREATE TRIGGER fault_inject_desc_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'description_changed'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() =>
      repo.upsert(job({ descriptionClean: "Build other things.", descriptionHash: "hash-2" }), "dedupe-1"),
    ).toThrow();

    // The main UPDATE must not have survived: description_hash unchanged.
    const row = db.prepare("SELECT description_hash, last_seen FROM jobs WHERE id = ?").get("j1") as {
      description_hash: string;
      last_seen: string;
    };
    expect(row.description_hash).toBe("hash-1");
    // Only the original "discovered" event should exist - nothing partial.
    expect(eventTypes(db, "j1")).toEqual(["discovered"]);

    // recordSource (job_sources.last_seen) must not have advanced either -
    // the whole existing-job write is one unit, not "the update landed but
    // the event didn't".
    const source = db
      .prepare("SELECT last_seen FROM job_sources WHERE job_id = ? AND source = ?")
      .get("j1", "greenhouse") as { last_seen: string };
    expect(source.last_seen).toBe(row.last_seen);
  });

  it("rolls back the whole update if the salary_changed event fails", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job({ salaryMin: 100000, salaryMax: 120000 }), "dedupe-1");

    db.exec(`
      CREATE TRIGGER fault_inject_salary_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'salary_changed'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() =>
      repo.upsert(job({ salaryMin: 150000, salaryMax: 180000 }), "dedupe-1"),
    ).toThrow();

    const row = db.prepare("SELECT salary_min, salary_max FROM jobs WHERE id = ?").get("j1") as {
      salary_min: number;
      salary_max: number;
    };
    // Salary must not have moved - the whole transaction rolled back.
    expect(row.salary_min).toBe(100000);
    expect(row.salary_max).toBe(120000);
    expect(eventTypes(db, "j1")).toEqual(["discovered"]);
  });

  it("rolls back the whole update if the stale-analysis clear fails", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    db.prepare(
      `UPDATE jobs SET analysis_json = ?, analyzed_at = ?, analysis_title_hash = ?
       WHERE id = ?`,
    ).run(JSON.stringify({ recommendation: "apply" }), new Date().toISOString(), "old-title-hash", "j1");

    // Force the analysis-clear UPDATE itself to fail via a trigger on jobs -
    // firing only when analysis_json is being set back to NULL from a
    // non-null previous value, to avoid catching the main UPDATE too.
    db.exec(`
      CREATE TRIGGER fault_inject_analysis_clear
      BEFORE UPDATE OF analysis_json ON jobs
      WHEN NEW.analysis_json IS NULL AND OLD.analysis_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() =>
      repo.upsert(job({ descriptionClean: "New text.", materialHash: "material-2" }), "dedupe-1"),
    ).toThrow();

    // Nothing must have moved: material_hash, description, and the stale
    // analysis are all exactly as they were before this call.
    const row = db
      .prepare("SELECT material_hash, description_clean, analysis_json, analysis_title_hash FROM jobs WHERE id = ?")
      .get("j1") as {
      material_hash: string;
      description_clean: string;
      analysis_json: string | null;
      analysis_title_hash: string | null;
    };
    expect(row.material_hash).toBe("material-1");
    expect(row.description_clean).toBe("Build things.");
    expect(row.analysis_json).not.toBeNull();
    expect(row.analysis_title_hash).toBe("old-title-hash");
    // No description_changed event should have landed either.
    expect(eventTypes(db, "j1")).toEqual(["discovered"]);
  });

  it("clears all five JOB-51 analysis-identity hashes together with the rest of the stale-analysis clear", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    db.prepare(
      `UPDATE jobs SET
         analysis_json = ?, analyzed_at = ?,
         analysis_title_hash = 'th', analysis_location_hash = 'lh',
         analysis_employment_hash = 'eh', analysis_compensation_hash = 'ch',
         analysis_evidence_hash = 'evh'
       WHERE id = ?`,
    ).run(JSON.stringify({ recommendation: "apply" }), new Date().toISOString(), "j1");

    repo.upsert(job({ descriptionClean: "New text.", materialHash: "material-2" }), "dedupe-1");

    const row = db
      .prepare(
        `SELECT analysis_json, analysis_title_hash, analysis_location_hash,
                analysis_employment_hash, analysis_compensation_hash, analysis_evidence_hash
           FROM jobs WHERE id = ?`,
      )
      .get("j1") as Record<string, string | null>;
    expect(row.analysis_json).toBeNull();
    expect(row.analysis_title_hash).toBeNull();
    expect(row.analysis_location_hash).toBeNull();
    expect(row.analysis_employment_hash).toBeNull();
    expect(row.analysis_compensation_hash).toBeNull();
    expect(row.analysis_evidence_hash).toBeNull();
  });
});

describe("upsert: CLOSED -> NEW reopen records a `reopened` event (AC#3)", () => {
  it("records reopened when a parked job is seen again", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    repo.parkJobs(["j1"]);
    expect((db.prepare("SELECT status FROM jobs WHERE id = ?").get("j1") as { status: string }).status).toBe(
      "CLOSED",
    );

    repo.upsert(job(), "dedupe-1");

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get("j1") as { status: string };
    expect(row.status).toBe("NEW");
    expect(eventTypes(db, "j1")).toEqual(["discovered", "parked", "reopened"]);
  });

  it("does not record reopened for a job that was never CLOSED", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    repo.upsert(job({ descriptionClean: "still fine" }), "dedupe-1");
    expect(eventTypes(db, "j1")).toEqual(["discovered"]);
  });

  it("rolls back the reopen (status stays CLOSED) if the reopened event fails", () => {
    const { repo, db } = memoryRepo();
    repo.upsert(job(), "dedupe-1");
    repo.parkJobs(["j1"]);

    db.exec(`
      CREATE TRIGGER fault_inject_reopened_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'reopened'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() => repo.upsert(job(), "dedupe-1")).toThrow();

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get("j1") as { status: string };
    // Must still be CLOSED - the whole transaction, including the status
    // flip, rolled back with the failed event.
    expect(row.status).toBe("CLOSED");
  });
});
