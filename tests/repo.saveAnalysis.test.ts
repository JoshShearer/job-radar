import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob, matchingIdentityHashes } from "./helpers/db.js";
import { triageOnlyAnalysis, type TriageVerdict } from "../src/model/job.js";

/**
 * JOB-47 PR3: attaching an analysis to a job is a single transaction - the
 * `jobs.analysis_json`/metadata UPDATE and the `analyzed` event that records
 * it commit or roll back together. Before this, `saveAnalysis` issued the
 * UPDATE and `repo.addEvent(jobId, "analyzed", ...)` as two separate
 * autocommitted statements, so a failure on the second left a job with a
 * live analysis and no history entry explaining when it arrived.
 *
 * Unrelated to JOB-52's `model_receipts` (one receipt per model ATTEMPT,
 * already correctly atomic on its own) - this only covers the result being
 * attached to the job row, after the model call has already succeeded.
 */

function verdict(over: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    fitScore: 72,
    applicationRoi: 60,
    lane: "backend",
    recommendation: "apply",
    salaryClassification: "green",
    reasoningSummary: "A sentence.",
    ...over,
  };
}

describe("saveAnalysis", () => {
  it("writes the analysis metadata and an analyzed event together", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db);
    const analysis = triageOnlyAnalysis(verdict());

    repo.saveAnalysis(id, analysis, "claude-opus-5", matchingIdentityHashes(db, id));

    const row = db.prepare("SELECT analysis_json, analysis_model FROM jobs WHERE id = ?").get(id) as {
      analysis_json: string | null;
      analysis_model: string | null;
    };
    expect(row.analysis_json).not.toBeNull();
    expect(JSON.parse(row.analysis_json as string)).toMatchObject({ recommendation: "apply" });
    expect(row.analysis_model).toBe("claude-opus-5");

    const events = db
      .prepare("SELECT event_type, detail FROM job_events WHERE job_id = ?")
      .all(id) as { event_type: string; detail: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("analyzed");
    expect(JSON.parse(events[0]!.detail)).toMatchObject({
      model: "claude-opus-5",
      recommendation: "apply",
    });
  });

  /**
   * JOB-47 AC#4: fault injection at the write, against a real isolated
   * SQLite connection - not a mocked repo. The trigger is the only
   * fault-injection mechanism; `saveAnalysis` itself is untouched.
   */
  it("rolls back the analysis UPDATE if the analyzed event INSERT fails", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db);
    const analysis = triageOnlyAnalysis(verdict({ recommendation: "apply_and_outreach" }));

    // Force the addEvent INSERT inside saveAnalysis's transaction to fail,
    // without touching application code. The sentinel lives in the
    // recommendation, which saveAnalysis embeds into the event's JSON detail.
    db.exec(`
      CREATE TRIGGER fault_inject_analyzed_event
      BEFORE INSERT ON job_events
      WHEN NEW.event_type = 'analyzed' AND NEW.detail LIKE '%FAULT_INJECT%'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    const poisoned = triageOnlyAnalysis(verdict({ recommendation: "FAULT_INJECT" as never }));
    expect(() =>
      repo.saveAnalysis(id, poisoned, "claude-opus-5", matchingIdentityHashes(db, id)),
    ).toThrow();

    // The UPDATE must not have survived the INSERT's failure.
    const row = db.prepare("SELECT analysis_json, analysis_model, analyzed_at FROM jobs WHERE id = ?").get(
      id,
    ) as { analysis_json: string | null; analysis_model: string | null; analyzed_at: string | null };
    expect(row.analysis_json).toBeNull();
    expect(row.analysis_model).toBeNull();
    expect(row.analyzed_at).toBeNull();
    const count = (
      db.prepare("SELECT COUNT(*) c FROM job_events WHERE job_id = ?").get(id) as { c: number }
    ).c;
    expect(count).toBe(0);

    // A subsequent normal call (no sentinel in the recommendation) must
    // replay cleanly - the failed transaction left nothing behind to trip
    // over.
    repo.saveAnalysis(id, analysis, "claude-opus-5", matchingIdentityHashes(db, id));
    const after = db.prepare("SELECT analysis_json, analysis_model FROM jobs WHERE id = ?").get(id) as {
      analysis_json: string | null;
      analysis_model: string | null;
    };
    expect(after.analysis_model).toBe("claude-opus-5");
    expect(JSON.parse(after.analysis_json as string)).toMatchObject({
      recommendation: "apply_and_outreach",
    });
    const eventsAfter = db
      .prepare("SELECT event_type FROM job_events WHERE job_id = ?")
      .all(id) as { event_type: string }[];
    expect(eventsAfter).toHaveLength(1);
  });
});
