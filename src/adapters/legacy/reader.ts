import Database from "better-sqlite3";

/**
 * Read-only access to a database written by the previous Job Radar. Opened
 * readonly: importing never modifies the source.
 */
import type { LegacyData, LegacyJob } from "../../ports/legacy.js";

function has(db: Database.Database, table: string, column?: string): boolean {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!t) return false;
  if (!column) return true;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function readLegacy(file: string): LegacyData {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!has(db, "jobs")) throw new Error(`${file} does not look like a Job Radar database (no jobs table).`);
    const boardCol = has(db, "jobs", "board_id");
    const jobs = (db.prepare("SELECT * FROM jobs").all() as Array<Record<string, unknown>>).map((r): LegacyJob => {
      const external = String(r.external_id);
      const token = external.includes(":") ? external.split(":")[0] : null;
      return {
        id: String(r.id),
        source: String(r.source),
        boardId: (boardCol && r.board_id ? String(r.board_id) : null) ?? (token ? `${r.source}:${token}` : String(r.source)),
        externalId: external,
        ats: (r.ats as string | null) ?? null,
        sourceUrl: String(r.source_url),
        applicationUrl: (r.application_url as string | null) ?? null,
        company: String(r.company),
        title: String(r.title),
        location: String(r.location ?? ""),
        remoteStatus: String(r.remote_status ?? "unknown"),
        employmentType: String(r.employment_type ?? "unknown"),
        datePosted: (r.date_posted as string | null) ?? null,
        firstSeen: String(r.first_seen),
        lastSeen: String(r.last_seen),
        salaryMin: (r.salary_min as number | null) ?? null,
        salaryMax: (r.salary_max as number | null) ?? null,
        salaryCurrency: String(r.salary_currency ?? "USD"),
        salaryPeriod: (r.salary_period as string | null) ?? null,
        description: String(r.description_clean ?? ""),
        department: (r.department as string | null) ?? null,
        team: (r.team as string | null) ?? null,
        status: String(r.status ?? "NEW"),
        statusChangedAt: (r.status_changed_at as string | null) ?? null,
        notes: (r.notes as string | null) ?? null,
        analysisJson: (r.analysis_json as string | null) ?? null,
        analysisModel: (r.analysis_model as string | null) ?? null,
        analyzedAt: (r.analyzed_at as string | null) ?? null,
      };
    });
    const sources = has(db, "job_sources")
      ? (db.prepare("SELECT * FROM job_sources").all() as Array<Record<string, unknown>>).map((r) => ({
          jobId: String(r.job_id),
          source: String(r.source),
          externalId: String(r.external_id),
          url: String(r.url),
          firstSeen: String(r.first_seen),
          lastSeen: String(r.last_seen),
        }))
      : [];
    const statusEvents = has(db, "job_events")
      ? (db.prepare("SELECT job_id, detail, created_at FROM job_events WHERE event_type = 'status_changed' ORDER BY created_at, id").all() as Array<Record<string, unknown>>)
          .map((r) => {
            let d: { from?: unknown; to?: unknown; note?: unknown } = {};
            try {
              d = JSON.parse(String(r.detail ?? "{}"));
            } catch {
              return null;
            }
            if (typeof d.to !== "string") return null;
            return {
              jobId: String(r.job_id),
              from: typeof d.from === "string" ? d.from : null,
              to: d.to,
              at: String(r.created_at),
              note: typeof d.note === "string" ? d.note : null,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : [];
    const emails = has(db, "email_events")
      ? (db.prepare("SELECT * FROM email_events").all() as Array<Record<string, unknown>>).map((r) => ({
          messageId: String(r.message_id),
          source: String(r.source),
          from: String(r.from_address),
          subject: String(r.subject),
          receivedAt: String(r.received_at),
          kinds: String(r.kinds ?? ""),
          evidence: (r.evidence as string | null) ?? null,
          resolution: String(r.resolution),
          jobId: (r.job_id as string | null) ?? null,
          appliedStatus: (r.applied_status as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          seenAt: String(r.seen_at),
        }))
      : [];
    const receipts = has(db, "model_receipts")
      ? (db.prepare("SELECT * FROM model_receipts ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({
          purpose: String(r.purpose),
          jobId: (r.job_id as string | null) ?? null,
          model: String(r.model),
          tier: (r.tier as string | null) ?? null,
          usageKnown: r.usage_known === 1,
          input: Number(r.input_tokens ?? 0),
          cacheWrite: Number(r.cache_write_tokens ?? 0),
          cacheRead: Number(r.cache_read_tokens ?? 0),
          output: Number(r.output_tokens ?? 0),
          outcome: String(r.validation_outcome),
          price: Number(r.estimated_price_usd ?? 0),
          at: String(r.created_at),
        }))
      : [];
    const runs = has(db, "runs")
      ? (db.prepare("SELECT * FROM runs ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => {
          let stats: Record<string, unknown> | null = null;
          try {
            stats = r.stats_json ? (JSON.parse(String(r.stats_json)) as Record<string, unknown>) : null;
          } catch {
            stats = null;
          }
          return { command: String(r.command), startedAt: String(r.started_at), finishedAt: (r.finished_at as string | null) ?? null, ok: r.ok === 1, stats };
        })
      : [];
    const interviews = has(db, "interviews") ? (db.prepare("SELECT * FROM interviews").all() as Array<Record<string, unknown>>) : [];
    return { jobs, sources, statusEvents, emails, receipts, runs, interviews };
  } finally {
    db.close();
  }
}
