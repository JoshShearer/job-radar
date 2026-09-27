import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { applyColumnMigrations, applyDestructiveMigrations } from "../src/db/index.js";
import { JobRepo } from "../src/db/repo.js";
import type { NormalizedJob } from "../src/model/job.js";

/**
 * `description_raw` was written on every ingest and read by nothing. Removing a
 * column from a database holding 13,674 real postings is the kind of change
 * that is safe right up until it is not, so these pin the two things that
 * matter: the destructive path stays out of `openDb`, and a migrated database
 * behaves exactly like a fresh one.
 */

/** A database as it existed before the column was removed from schema.ts. */
function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);
  db.exec("ALTER TABLE jobs ADD COLUMN description_raw TEXT NOT NULL DEFAULT ''");
  return db;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);
  return db;
}

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "j1",
    source: "greenhouse",
    board: "greenhouse:acme",
    externalId: "x1",
    company: "Acme",
    companyNormalized: "acme",
    title: "Staff Engineer",
    location: "Remote",
    remoteStatus: "remote",
    employmentType: "full_time",
    seniority: "staff",
    datePosted: "2026-08-01T00:00:00Z",
    dateDiscovered: "2026-08-02T00:00:00Z",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "USD",
    salaryPeriod: null,
    descriptionClean: "We need a frontend leader who ships React at scale.",
    descriptionHash: "hash-1",
    materialHash: "material-1",
    department: null,
    team: null,
    companySizeEstimate: null,
    companyStage: null,
    industry: null,
    sourceUrl: "https://example.com/j1",
    applicationUrl: null,
    ...over,
  } as NormalizedJob;
}

describe("the destructive path is separate and explicit", () => {
  it("is a no-op on a database that never had the column", () => {
    expect(applyDestructiveMigrations(freshDb())).toEqual([]);
  });

  it("drops the column when it is there, and names why", () => {
    const db = legacyDb();
    const dropped = applyDestructiveMigrations(db);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("description_raw");
    expect(dropped[0]).toContain("never read");

    const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "description_raw")).toBe(false);
  });

  it("is idempotent, so running migrate twice is harmless", () => {
    const db = legacyDb();
    expect(applyDestructiveMigrations(db)).toHaveLength(1);
    expect(applyDestructiveMigrations(db)).toEqual([]);
  });

  it("is not run by applyColumnMigrations, which stays additive-only", () => {
    // The additive-only rule at src/db/index.ts is load-bearing:
    // applyColumnMigrations runs from openDb(), on the hot path of every
    // command and every test. A destructive change must never ride along.
    const db = legacyDb();
    applyColumnMigrations(db);
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "description_raw")).toBe(true);
  });
});

describe("a legacy database still accepts writes before migrate runs", () => {
  it("inserts with the column still present and no longer supplied", () => {
    // The intermediate state, and the reason it is safe: the column is
    // NOT NULL DEFAULT '', so an insert that omits it works. Deploying the
    // code before running migrate cannot break ingest.
    const db = legacyDb();
    const repo = new JobRepo(db);
    expect(() => repo.upsert(job(), "acme|staff-engineer")).not.toThrow();

    const row = db.prepare("SELECT description_raw, description_clean FROM jobs WHERE id = 'j1'").get() as {
      description_raw: string;
      description_clean: string;
    };
    expect(row.description_raw).toBe("");
    expect(row.description_clean).toContain("React at scale");
  });
});

describe("a migrated database and a fresh one behave identically", () => {
  it("stores and reads back the same job", () => {
    const migrated = legacyDb();
    applyDestructiveMigrations(migrated);
    const fresh = freshDb();

    const read = (db: Database.Database) => {
      const repo = new JobRepo(db);
      repo.upsert(job(), "acme|staff-engineer");
      const j = repo.get("j1")!;
      // Everything the scorer and filters actually read.
      return {
        descriptionClean: j.descriptionClean,
        descriptionHash: j.descriptionHash,
        title: j.title,
        company: j.company,
        remoteStatus: j.remoteStatus,
        seniority: j.seniority,
      };
    };

    expect(read(migrated)).toEqual(read(fresh));
  });

  it("keeps the description hash derived from the clean text, not the raw HTML", () => {
    // This is why dropping the column cannot change scoring: nothing was ever
    // computed from it. `descriptionHash = sha256(descriptionClean)`.
    const db = freshDb();
    const repo = new JobRepo(db);
    repo.upsert(job({ descriptionHash: "hash-abc" }), "acme|staff-engineer");
    expect(repo.get("j1")!.descriptionHash).toBe("hash-abc");
  });
});

/**
 * JOB-50. `jobs.board_id` is additive, and its one-time backfill has to
 * reconstruct employer-board identity from what the three ATS adapters
 * already encode in `external_id` ("${token}:${id}") - not guess at it. This
 * pins the backfill against a database that predates the column, the way
 * `material_hash`'s backfill above is exercised via `legacyDb`/`freshDb`.
 */
describe("board_id backfill", () => {
  /** A jobs row exactly as it existed before board_id existed. */
  function preMigrationDb(): Database.Database {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    // Simulate "before this migration ran" by dropping the column back off -
    // SQLite 3.35+ (the bundled better-sqlite3 is 3.53.4) supports DROP COLUMN
    // - and clearing its completion marker (JOB-54: the marker, not column
    // existence, is what applyColumnMigrations now checks).
    db.exec("ALTER TABLE jobs DROP COLUMN board_id");
    db.exec("DELETE FROM schema_meta WHERE key = 'migration:jobs.board_id'");
    return db;
  }

  const insertJob = (db: Database.Database, id: string, source: string, externalId: string) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (
         id, dedupe_key, external_id, source, source_url, company, company_normalized,
         title, title_normalized, date_discovered, first_seen, last_seen, description_hash
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, `dedupe-${id}`, externalId, source, `https://example.test/${id}`, "Acme", "acme", "Staff Engineer", "staff engineer", now, now, now, "hash");
  };

  it("reconstructs greenhouse/lever/ashby board identity from the token half of external_id", () => {
    const db = preMigrationDb();
    insertJob(db, "gh1", "greenhouse", "acme:12345");
    insertJob(db, "lv1", "lever", "ro:abc-123");
    insertJob(db, "as1", "ashby", "ramp:34413f8d");

    applyColumnMigrations(db);

    const boardOf = (id: string) => (db.prepare("SELECT board_id FROM jobs WHERE id = ?").get(id) as { board_id: string }).board_id;
    expect(boardOf("gh1")).toBe("greenhouse:acme");
    expect(boardOf("lv1")).toBe("lever:ro");
    expect(boardOf("as1")).toBe("ashby:ramp");
  });

  it("falls back to bare source for a single-feed adapter with no colon in external_id", () => {
    const db = preMigrationDb();
    insertJob(db, "rok1", "remoteok", "1136375");

    applyColumnMigrations(db);

    const row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("rok1") as { board_id: string };
    expect(row.board_id).toBe("remoteok");
  });

  it("is additive-only: the column is absent until this migration runs, present after, and the run is a no-op the second time", () => {
    const db = preMigrationDb();
    let cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "board_id")).toBe(false);

    insertJob(db, "j1", "greenhouse", "acme:1");
    applyColumnMigrations(db);

    cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "board_id")).toBe(true);

    // Running again must not re-run the backfill or throw - PRAGMA table_info
    // already reports the column present, so applyColumnMigrations skips it.
    expect(() => applyColumnMigrations(db)).not.toThrow();
    const row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string };
    expect(row.board_id).toBe("greenhouse:acme");
  });

  it("a fresh database gets board_id written directly by upsert, matching what the backfill would derive from the same shape", () => {
    const fresh = freshDb();
    const repo = new JobRepo(fresh);
    repo.upsert(
      job({ id: "j2", externalId: "acme:99", source: "greenhouse", board: "greenhouse:acme" }),
      "acme|staff-engineer-2",
    );
    const row = fresh.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j2") as { board_id: string };
    expect(row.board_id).toBe("greenhouse:acme");
  });
});

/**
 * JOB-54. Column existence used to be the only completion signal, so a
 * `backfill` that threw AFTER `ALTER TABLE` already ran left the column in
 * place forever with no way to retry it: the column existing was read as
 * "done", and the row kept a bare default (`material_hash = ''`,
 * `board_id = NULL`) silently. These pin the fix: a `schema_meta` marker,
 * written only once the column add + backfill both succeed inside the same
 * `db.transaction()`, is the actual completion signal now.
 */
describe("migration completion is marker-gated, not column-existence-gated (JOB-54)", () => {
  const markerFor = (table: string, column: string) => `migration:${table}.${column}`;

  const hasMarker = (db: Database.Database, table: string, column: string) =>
    Boolean(db.prepare("SELECT 1 FROM schema_meta WHERE key = ?").get(markerFor(table, column)));

  const insertJobNoExternalId = (db: Database.Database, id: string, source: string) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (
         id, dedupe_key, source, source_url, company, company_normalized,
         title, title_normalized, date_discovered, first_seen, last_seen, description_hash
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, `dedupe-${id}`, source, `https://example.test/${id}`, "Acme", "acme", "Staff Engineer", "staff engineer", now, now, now, "hash");
  };

  const insertJob = (db: Database.Database, id: string, source: string, externalId: string) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (
         id, dedupe_key, external_id, source, source_url, company, company_normalized,
         title, title_normalized, date_discovered, first_seen, last_seen, description_hash
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, `dedupe-${id}`, externalId, source, `https://example.test/${id}`, "Acme", "acme", "Staff Engineer", "staff engineer", now, now, now, "hash");
  };

  it("a backfill that throws leaves no new column and no marker, and a retry on the same connection succeeds", () => {
    // board_id's backfill selects external_id, so dropping that column
    // upfront forces a REAL SQL error mid-backfill - not a stubbed one -
    // exactly the "ALTER succeeded, backfill threw" sequence the bug allowed.
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    db.exec("ALTER TABLE jobs DROP COLUMN external_id");
    insertJobNoExternalId(db, "j1", "greenhouse");

    expect(() => applyColumnMigrations(db)).toThrow();

    // board_id's ALTER ran inside the same transaction as the failing
    // backfill, so it must have rolled back with everything else.
    let cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "board_id")).toBe(false);
    expect(hasMarker(db, "jobs", "board_id")).toBe(false);

    // Fix the underlying cause and retry on the SAME connection: every
    // migration before board_id already committed its marker on the first
    // (failing) call, so this retry only redoes board_id.
    db.exec("ALTER TABLE jobs ADD COLUMN external_id TEXT NOT NULL DEFAULT 'acme:1'");
    expect(() => applyColumnMigrations(db)).not.toThrow();

    cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "board_id")).toBe(true);
    const row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string };
    expect(row.board_id).toBe("greenhouse:acme");
    expect(hasMarker(db, "jobs", "board_id")).toBe(true);
  });

  it("recovers a column that exists with no marker (old buggy code half-ran)", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    insertJob(db, "j1", "greenhouse", "acme:1");

    // Simulate exactly what the pre-fix code could leave behind: the ALTER
    // ran (column exists) but the process died before the backfill or the
    // (nonexistent, pre-fix) marker, so every existing row has the bare
    // column default.
    db.exec("ALTER TABLE jobs DROP COLUMN board_id");
    db.exec(`DELETE FROM schema_meta WHERE key = '${markerFor("jobs", "board_id")}'`);
    db.exec("ALTER TABLE jobs ADD COLUMN board_id TEXT");

    let row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string | null };
    expect(row.board_id).toBeNull();
    expect(hasMarker(db, "jobs", "board_id")).toBe(false);

    applyColumnMigrations(db);

    row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string | null };
    expect(row.board_id).toBe("greenhouse:acme");
    expect(hasMarker(db, "jobs", "board_id")).toBe(true);
  });

  it("skips a completed migration on the marker alone, never re-checking or re-deriving the data", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    insertJob(db, "j1", "greenhouse", "acme:1");
    expect(hasMarker(db, "jobs", "board_id")).toBe(true);

    // Corrupt the column AFTER the marker already exists. If the decision to
    // skip were based on column existence or on the data looking right, this
    // would get "fixed" back to the correct derived value. It must not.
    db.prepare("UPDATE jobs SET board_id = ? WHERE id = ?").run("CORRUPTED", "j1");

    applyColumnMigrations(db);

    const row = db.prepare("SELECT board_id FROM jobs WHERE id = ?").get("j1") as { board_id: string };
    expect(row.board_id).toBe("CORRUPTED");
  });

  it("marks a no-backfill JOB-51 migration complete without inventing a value for existing rows", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db);
    // Simulate "before this migration ran": drop the column and its marker,
    // the same way preMigrationDb() does for board_id above.
    db.exec("ALTER TABLE jobs DROP COLUMN analysis_title_hash");
    db.exec(`DELETE FROM schema_meta WHERE key = '${markerFor("jobs", "analysis_title_hash")}'`);
    insertJob(db, "j1", "greenhouse", "acme:1");
    expect(hasMarker(db, "jobs", "analysis_title_hash")).toBe(false);

    applyColumnMigrations(db);

    const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "analysis_title_hash")).toBe(true);
    const row = db.prepare("SELECT analysis_title_hash FROM jobs WHERE id = ?").get("j1") as {
      analysis_title_hash: string | null;
    };
    expect(row.analysis_title_hash).toBeNull();
    expect(hasMarker(db, "jobs", "analysis_title_hash")).toBe(true);
  });

  it("does zero ALTER TABLE / backfill work once every migration is already marked complete", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA_SQL);
    applyColumnMigrations(db); // establishes every marker

    const execSpy = vi.spyOn(db, "exec");
    const prepareSpy = vi.spyOn(db, "prepare");

    applyColumnMigrations(db);

    // No ALTER TABLE, and the only statements prepared are the two marker
    // lookups/inserts against schema_meta itself - never a backfill SELECT or
    // UPDATE against jobs/analysis_cache. Cheap, indexed SELECTs only, per AC#3.
    expect(execSpy).not.toHaveBeenCalled();
    const preparedSql = prepareSpy.mock.calls.map(([sql]) => String(sql));
    expect(preparedSql.length).toBeGreaterThan(0);
    expect(preparedSql.every((sql) => sql.includes("schema_meta"))).toBe(true);
  });
});
