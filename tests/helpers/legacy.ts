import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A database in the PREVIOUS Job Radar's schema, with a small realistic history. */
export function legacyDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), "jr-legacy-")), "job-radar.sqlite");
  const db = new Database(file);
  db.exec(readFileSync(resolve(import.meta.dirname, "..", "fixtures", "legacy-schema.sql"), "utf8"));
  const job = db.prepare(
    `INSERT INTO jobs (id, dedupe_key, external_id, source, board_id, ats, source_url, company, company_normalized, title, title_normalized,
       location, remote_status, employment_type, date_discovered, first_seen, last_seen, description_clean, description_hash, status,
       status_changed_at, analysis_json, analysis_model, analyzed_at)
     VALUES (?, ?, ?, 'greenhouse', ?, 'greenhouse', ?, ?, ?, ?, ?, 'Remote - US', 'remote', 'full_time', '2026-08-01T00:00:00Z',
       '2026-08-01T00:00:00Z', '2026-09-20T00:00:00Z', ?, 'h', ?, ?, ?, ?, ?)`,
  );
  const desc = "Build with TypeScript and React. Requirements: 5+ years of TypeScript.";
  job.run("j-applied", "k1", "acme:1", "greenhouse:acme", "https://x/1", "Acme", "acme", "Senior Engineer", "senior engineer", desc, "REJECTED", "2026-09-10T00:00:00Z", JSON.stringify({ fitScore: 80, recommendation: "apply", interviewProbability: 30 }), "claude-opus-5", "2026-08-02T00:00:00Z");
  job.run("j-skipped", "k2", "acme:2", "greenhouse:acme", "https://x/2", "Acme", "acme", "Staff Engineer", "staff engineer", desc, "SKIPPED", "2026-08-05T00:00:00Z", null, null, null);
  job.run("j-ghost", "k3", "globex:3", "greenhouse:globex", "https://x/3", "Globex", "globex", "Senior Developer", "senior developer", desc, "GHOSTED", "2026-09-15T00:00:00Z", null, null, null);
  // The old content dedupe merging two different roles (observed in a real
  // database): the CLOSED job, imported first, also lists the LIVE job's own
  // posting; and two jobs share a posting that is neither one's own.
  job.run("j-closed", "k4", "acme:8", "greenhouse:acme", "https://x/8", "Acme", "acme", "Analyst II", "analyst ii", desc, "CLOSED", "2026-09-01T00:00:00Z", null, null, null);
  job.run("j-live", "k5", "acme:9", "greenhouse:acme", "https://x/9", "Acme", "acme", "Analytics Engineer II", "analytics engineer ii", desc, "NEW", "2026-08-01T00:00:00Z", null, null, null);
  job.run("j-corrected", "k6", "globex:4", "greenhouse:globex", "https://x/4", "Globex", "globex", "Platform Engineer", "platform engineer", desc, "APPLIED", "2026-08-20T00:00:00Z", null, null, null);
  const src = db.prepare("INSERT INTO job_sources (job_id, source, external_id, url, first_seen, last_seen) VALUES (?, 'greenhouse', ?, ?, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')");
  for (const [id, ext] of [["j-applied", "acme:1"], ["j-skipped", "acme:2"], ["j-ghost", "globex:3"], ["j-closed", "acme:8"], ["j-live", "acme:9"], ["j-corrected", "globex:4"]]) src.run(id, ext, `https://x/${ext}`);
  src.run("j-closed", "acme:9", "https://x/acme:9");
  src.run("j-closed", "acme:77", "https://x/acme:77");
  src.run("j-live", "acme:77", "https://x/acme:77");
  const ev = db.prepare("INSERT INTO job_events (job_id, event_type, detail, created_at) VALUES (?, 'status_changed', ?, ?)");
  ev.run("j-applied", JSON.stringify({ from: "NEW", to: "APPLY", note: "pack prepared" }), "2026-08-03T00:00:00Z");
  ev.run("j-applied", JSON.stringify({ from: "APPLY", to: "APPLIED", note: null }), "2026-08-04T00:00:00Z");
  ev.run("j-applied", JSON.stringify({ from: "APPLIED", to: "SCREEN", note: "SCREEN from email m1" }), "2026-08-20T00:00:00Z");
  ev.run("j-applied", JSON.stringify({ from: "SCREEN", to: "REJECTED", note: "REJECTED from email m2" }), "2026-09-10T00:00:00Z");
  ev.run("j-skipped", JSON.stringify({ from: "NEW", to: "SKIPPED", note: null }), "2026-08-05T00:00:00Z");
  ev.run("j-ghost", JSON.stringify({ from: "NEW", to: "APPLIED", note: null }), "2026-08-10T00:00:00Z");
  ev.run("j-corrected", JSON.stringify({ from: "NEW", to: "APPLIED", note: null }), "2026-08-11T00:00:00Z");
  ev.run("j-corrected", JSON.stringify({ from: "APPLIED", to: "SCREEN", note: null }), "2026-08-14T00:00:00Z");
  ev.run("j-corrected", JSON.stringify({ from: "SCREEN", to: "APPLIED", note: null }), "2026-08-20T00:00:00Z");
  ev.run("j-ghost", JSON.stringify({ from: "APPLIED", to: "GHOSTED", note: "no response in 30 days" }), "2026-09-15T00:00:00Z");
  db.prepare(
    `INSERT INTO email_events (message_id, source, from_address, subject, received_at, kinds, resolution, job_id, applied_status, seen_at)
     VALUES ('m2', 'gmail', 'no-reply@acme.greenhouse.io', 'Update', '2026-09-10T00:00:00Z', 'rejection', 'matched', 'j-applied', 'REJECTED', '2026-09-10T01:00:00Z')`,
  ).run();
  db.prepare("INSERT INTO runs (command, started_at, finished_at, stats_json, ok) VALUES ('apply', '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z', ?, 1)").run(
    JSON.stringify({ jobId: "j-applied", estimatedCostUsd: 0.31 }),
  );
  db.close();
  return file;
}

