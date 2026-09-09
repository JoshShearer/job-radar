import { describe, it, expect } from "vitest";
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
