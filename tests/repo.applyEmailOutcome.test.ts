import { describe, it, expect } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";

/**
 * JOB-47 PR2: "email causes a job transition" is a single transaction -
 * the compare-and-swap status write and the `email_events` audit row that
 * explains it commit or roll back together. Before this, `scanInbox` issued
 * `repo.setStatus(...)` and `repo.recordEmailEvent(...)` as two separate
 * autocommitted writes, so a failure on the second left a `status_changed`
 * event with nothing in `email_events` explaining why the job moved.
 */

function baseEmail(overrides: Partial<{
  messageId: string;
  source: string;
  from: string;
  subject: string;
  receivedAt: string;
  kinds: string[];
  evidence: string[];
  resolution: string;
  note: string | null;
}> = {}) {
  return {
    messageId: "msg-1",
    source: "gmail",
    from: "recruiter@acme.test",
    subject: "Your application to Acme",
    receivedAt: new Date().toISOString(),
    kinds: ["rejection"],
    evidence: ["we have decided to move forward with other candidates"],
    resolution: "matched",
    note: "only in-flight application at Acme",
    ...overrides,
  };
}

describe("applyEmailOutcome", () => {
  it("commits the status write and the email_events row together", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "APPLIED" });

    const applied = repo.applyEmailOutcome({
      jobId: id,
      expectedStatus: "APPLIED",
      newStatus: "REJECTED",
      statusNote: "REJECTED from email msg-1",
      email: baseEmail(),
    });

    expect(applied).toBe(true);

    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(job.status).toBe("REJECTED");

    const events = db
      .prepare("SELECT event_type, detail FROM job_events WHERE job_id = ?")
      .all(id) as { event_type: string; detail: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("status_changed");
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ from: "APPLIED", to: "REJECTED" });

    const emailEvents = db
      .prepare("SELECT message_id AS messageId, job_id AS jobId, applied_status AS appliedStatus, resolution, note FROM email_events")
      .all() as { messageId: string; jobId: string; appliedStatus: string; resolution: string; note: string }[];
    expect(emailEvents).toHaveLength(1);
    expect(emailEvents[0]).toMatchObject({
      messageId: "msg-1", jobId: id, appliedStatus: "REJECTED", resolution: "matched",
      note: "only in-flight application at Acme",
    });
  });

  /**
   * AC: refuses a write when the status moved on since the email was
   * matched - no status change, no email_events row, rather than partially
   * (or blindly) applying.
   */
  it("refuses the whole write when the job's status moved since the match, and writes nothing", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "APPLIED" });
    // Something else - a human, another process, an earlier email in this
    // same scan - already moved the job on since the caller's snapshot.
    repo.setStatus(id, "SCREEN", "moved by someone else");

    const applied = repo.applyEmailOutcome({
      jobId: id,
      expectedStatus: "APPLIED", // stale: the job is actually SCREEN now
      newStatus: "REJECTED",
      statusNote: "REJECTED from email msg-1",
      email: baseEmail(),
    });

    expect(applied).toBe(false);

    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(job.status).toBe("SCREEN"); // unchanged by the refused write

    const events = db
      .prepare("SELECT COUNT(*) c FROM job_events WHERE job_id = ?")
      .get(id) as { c: number };
    expect(events.c).toBe(1); // only the earlier setStatus(SCREEN) event

    const emailEvents = db.prepare("SELECT COUNT(*) c FROM email_events").get() as { c: number };
    expect(emailEvents.c).toBe(0); // no audit row for a write that never happened
  });

  it("refuses a write for a job that does not exist, and writes nothing", () => {
    const { repo, db } = memoryRepo();
    const applied = repo.applyEmailOutcome({
      jobId: "nope",
      expectedStatus: "APPLIED",
      newStatus: "REJECTED",
      email: baseEmail(),
    });
    expect(applied).toBe(false);
    expect((db.prepare("SELECT COUNT(*) c FROM job_events").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM email_events").get() as { c: number }).c).toBe(0);
  });

  /**
   * JOB-47 AC#4: fault injection at the write, against a real isolated
   * SQLite connection - not a mocked repo. `email_events.message_id` is
   * UNIQUE, but `recordEmailEvent`'s `INSERT OR IGNORE` (which
   * `applyEmailOutcome` also runs through) means a real UNIQUE collision
   * would be silently swallowed rather than raised - SQLite's conflict
   * clause suppresses the constraint error before it can propagate, so a
   * duplicate `message_id` cannot be used to force a genuine failure here.
   * A BEFORE INSERT trigger is the actual failure mode available: it fires
   * ahead of the `OR IGNORE` conflict resolution and can still abort the
   * statement (and, since both writes share one `db.transaction`, the
   * transaction) outright.
   */
  it("rolls back the status UPDATE if the email_events INSERT fails", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "APPLIED" });

    db.exec(`
      CREATE TRIGGER fault_inject_email_event
      BEFORE INSERT ON email_events
      WHEN NEW.note LIKE '%FAULT_INJECT%'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() =>
      repo.applyEmailOutcome({
        jobId: id,
        expectedStatus: "APPLIED",
        newStatus: "REJECTED",
        statusNote: "REJECTED from email msg-1",
        email: baseEmail({ note: "FAULT_INJECT" }),
      }),
    ).toThrow();

    // The status UPDATE (and its job_events row) must not have survived the
    // email_events INSERT's failure - this is the exact defect JOB-47
    // exists to close: a status_changed event with no email_events row
    // explaining it.
    const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(job.status).toBe("APPLIED");
    const jobEvents = db.prepare("SELECT COUNT(*) c FROM job_events WHERE job_id = ?").get(id) as {
      c: number;
    };
    expect(jobEvents.c).toBe(0);
    const emailEvents = db.prepare("SELECT COUNT(*) c FROM email_events").get() as { c: number };
    expect(emailEvents.c).toBe(0);

    // A subsequent successful call (no sentinel in the note) must replay
    // cleanly - the failed transaction left nothing behind to trip over.
    const applied = repo.applyEmailOutcome({
      jobId: id,
      expectedStatus: "APPLIED",
      newStatus: "REJECTED",
      statusNote: "REJECTED from email msg-1",
      email: baseEmail({ note: "actually rejected" }),
    });
    expect(applied).toBe(true);
    const after = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(after.status).toBe("REJECTED");
    const emailEventsAfter = db.prepare("SELECT COUNT(*) c FROM email_events").get() as { c: number };
    expect(emailEventsAfter.c).toBe(1);
  });
});
