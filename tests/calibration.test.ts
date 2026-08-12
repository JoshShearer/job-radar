import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../src/db/schema.js";
import {
  computeCalibration,
  project,
  saveCalibration,
  loadCalibration,
  describeCalibration,
  MIN_CALIBRATION_SAMPLE,
} from "../src/pipeline/calibration.js";

let db: Database.Database;

let seq = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("ALTER TABLE jobs ADD COLUMN score_confidence TEXT");
  db.exec("ALTER TABLE jobs ADD COLUMN raw_fit_score REAL");
  // Reset per test: each gets a fresh database, so ids must restart too.
  seq = 0;
});

afterEach(() => db.close());

function addJob(rawFit: number, llmFit: number | null, detRoi = 60, llmRoi = 30): void {
  seq++;
  db.prepare(
    `INSERT INTO jobs (id, dedupe_key, external_id, source, source_url, company, company_normalized,
      title, title_normalized, date_discovered, first_seen, last_seen, description_hash,
      fit_score, raw_fit_score, application_roi, analysis_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `id${seq}`,
    `k${seq}`,
    `e${seq}`,
    "greenhouse",
    "https://example.com",
    "Acme",
    "acme",
    "Senior Engineer",
    "senior engineer",
    "2026-01-01",
    "2026-01-01",
    "2026-01-01",
    `h${seq}`,
    llmFit ?? rawFit,
    rawFit,
    detRoi,
    llmFit == null ? null : JSON.stringify({ fitScore: llmFit, applicationRoi: llmRoi }),
  );
}

describe("computeCalibration", () => {
  it("reports nothing usable with no analyzed jobs", () => {
    addJob(90, null);
    const cal = computeCalibration(db);
    expect(cal.sampleSize).toBe(0);
    expect(cal.usable).toBe(false);
    expect(cal.fitRatio).toBe(1);
  });

  it("measures but does not apply a correction below the sample floor", () => {
    for (let i = 0; i < MIN_CALIBRATION_SAMPLE - 1; i++) addJob(90, 45);
    const cal = computeCalibration(db);
    expect(cal.sampleSize).toBe(MIN_CALIBRATION_SAMPLE - 1);
    expect(cal.usable).toBe(false);
    expect(describeCalibration(cal)).toMatch(/NOT applied/);
  });

  it("measures the over-scoring ratio once there are enough samples", () => {
    // Keyword says 90, analysis says 45 => ratio 0.5
    for (let i = 0; i < 10; i++) addJob(90, 45);
    const cal = computeCalibration(db);
    expect(cal.usable).toBe(true);
    expect(cal.fitRatio).toBeCloseTo(0.5, 2);
    expect(cal.fitBias).toBeCloseTo(45, 1);
  });

  it("uses the median so one extreme outlier cannot dominate", () => {
    for (let i = 0; i < 9; i++) addJob(80, 60); // ratio 0.75
    addJob(80, 2); // ratio 0.025 - a single catastrophic mismatch
    const cal = computeCalibration(db);
    expect(cal.fitRatio).toBeCloseTo(0.75, 2);
  });

  it("clamps an implausible correction into a sane band", () => {
    for (let i = 0; i < 10; i++) addJob(10, 100); // ratio 10
    expect(computeCalibration(db).fitRatio).toBeLessThanOrEqual(1.5);
  });

  it("ignores rows with no stored raw score", () => {
    // Rows written before raw_fit_score existed would otherwise yield a
    // ratio of 1.0 and silently flatten the correction to a no-op.
    for (let i = 0; i < 10; i++) addJob(90, 45);
    db.prepare("UPDATE jobs SET raw_fit_score = NULL WHERE id = 'id1'").run();
    expect(computeCalibration(db).sampleSize).toBe(9);
  });
});

describe("project", () => {
  it("leaves scores untouched when calibration is not usable", () => {
    const cal = computeCalibration(db);
    expect(project({ fitScore: 90, applicationRoi: 80 }, cal)).toEqual({ fitScore: 90, applicationRoi: 80 });
  });

  it("scales scores down by the measured ratio", () => {
    for (let i = 0; i < 10; i++) addJob(90, 45, 60, 30);
    const cal = computeCalibration(db);
    const out = project({ fitScore: 90, applicationRoi: 60 }, cal);
    expect(out.fitScore).toBe(45);
    expect(out.applicationRoi).toBe(30);
  });

  it("keeps projected values inside 0-100", () => {
    for (let i = 0; i < 10; i++) addJob(50, 70, 40, 60);
    const cal = computeCalibration(db);
    const out = project({ fitScore: 100, applicationRoi: 100 }, cal);
    expect(out.fitScore).toBeLessThanOrEqual(100);
    expect(out.applicationRoi).toBeLessThanOrEqual(100);
  });
});

describe("save/loadCalibration", () => {
  it("round-trips through schema_meta", () => {
    for (let i = 0; i < 10; i++) addJob(90, 45);
    const cal = computeCalibration(db);
    saveCalibration(db, cal);
    expect(loadCalibration(db)?.fitRatio).toBeCloseTo(cal.fitRatio, 5);
  });

  it("overwrites a previous calibration rather than erroring", () => {
    for (let i = 0; i < 10; i++) addJob(90, 45);
    saveCalibration(db, computeCalibration(db));
    saveCalibration(db, computeCalibration(db));
    expect(loadCalibration(db)).not.toBeNull();
  });

  it("returns null when nothing has been stored", () => {
    expect(loadCalibration(db)).toBeNull();
  });
});
