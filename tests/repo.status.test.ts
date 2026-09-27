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

  /**
   * JOB-47 AC#4: fault injection at the write, against a real isolated
   * SQLite connection - not a mocked repo. The trigger is the only
   * fault-injection mechanism; `setStatus` itself is untouched.
   */
  it("rolls back the status UPDATE if the event INSERT fails", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "NEW" });

    // Force the addEvent INSERT inside setStatus's transaction to fail,
    // without touching application code. The sentinel lives in the note
    // text, which setStatus embeds into the event's JSON `detail`.
    db.exec(`
      CREATE TRIGGER fault_inject_status_event
      BEFORE INSERT ON job_events
      WHEN NEW.detail LIKE '%FAULT_INJECT%'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `);

    expect(() => repo.setStatus(id, "APPLIED", "FAULT_INJECT")).toThrow();

    // The UPDATE must not have survived the INSERT's failure.
    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("NEW");
    const count = (db.prepare("SELECT COUNT(*) c FROM job_events WHERE job_id = ?").get(id) as { c: number })
      .c;
    expect(count).toBe(0);

    // A subsequent successful call (no sentinel in the note) must replay
    // cleanly - the failed transaction left nothing behind to trip over.
    expect(repo.setStatus(id, "APPLIED", "actually submitted")).toBe(true);
    const after = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(after.status).toBe("APPLIED");
    const eventsAfter = db
      .prepare("SELECT event_type FROM job_events WHERE job_id = ?")
      .all(id) as { event_type: string }[];
    expect(eventsAfter).toHaveLength(1);
  });
});

describe("setStatusIfCurrent", () => {
  it("applies and logs the event when the snapshot still matches", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "NEW" });

    const applied = repo.setStatusIfCurrent(id, "NEW", "APPLY", "pack prepared");
    expect(applied).toBe(true);

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("APPLY");
    const events = db
      .prepare("SELECT event_type, detail FROM job_events WHERE job_id = ?")
      .all(id) as { event_type: string; detail: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("status_changed");
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ from: "NEW", to: "APPLY", note: "pack prepared" });
  });

  it("refuses a write when the status moved on, and writes nothing", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "NEW" });
    repo.setStatus(id, "APPLY"); // status is now APPLY, not the caller's stale snapshot

    const applied = repo.setStatusIfCurrent(id, "NEW", "APPLIED", "stale write");
    expect(applied).toBe(false);

    const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("APPLY"); // unchanged by the refused write
    const count = (db.prepare("SELECT COUNT(*) c FROM job_events WHERE job_id = ?").get(id) as { c: number })
      .c;
    expect(count).toBe(1); // only the earlier setStatus(APPLY) event; nothing from the refused CAS
  });

  it("refuses a write for a job that does not exist", () => {
    const { repo, db } = memoryRepo();
    const applied = repo.setStatusIfCurrent("nope", "NEW", "APPLIED");
    expect(applied).toBe(false);
    expect((db.prepare("SELECT COUNT(*) c FROM job_events").get() as { c: number }).c).toBe(0);
  });
});

describe("statusTransitions", () => {
  it("returns every status change, oldest first, with both ends parsed", () => {
    const { repo, db } = memoryRepo();
    const a = seedJob(db, { id: "a" });
    const b = seedJob(db, { id: "b" });
    repo.setStatus(a, "APPLIED");
    repo.setStatus(b, "APPLIED");
    repo.setStatus(a, "SCREEN");

    const t = repo.statusTransitions();
    expect(t).toHaveLength(3);
    expect(t.map((x) => x.to)).toEqual(["APPLIED", "APPLIED", "SCREEN"]);
    expect(t[2]).toMatchObject({ jobId: "a", from: "APPLIED", to: "SCREEN" });
    expect(Number.isNaN(Date.parse(t[0]!.at))).toBe(false);
  });

  it("ignores events that are not status changes", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db);
    repo.addEvent(id, "analyzed", { model: "x" });
    repo.addEvent(id, "salary_changed", { from: 1, to: 2 });
    repo.setStatus(id, "APPLIED");

    expect(repo.statusTransitions().map((t) => t.to)).toEqual(["APPLIED"]);
  });

  it("drops an event whose detail cannot be read rather than guessing at it", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db);
    db.prepare("INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?,?,?,?)").run(
      id,
      "status_changed",
      "{not json",
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?,?,?,?)").run(
      id,
      "status_changed",
      JSON.stringify({ from: "NEW" }),
      new Date().toISOString(),
    );

    // An event we cannot read is not evidence that a transition happened.
    expect(repo.statusTransitions()).toEqual([]);
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
