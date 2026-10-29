import type { DB } from "./db.js";
import type { ResolutionIndex } from "../../domain/catalog/resolve.js";
import type { BoardCoverage } from "../../domain/catalog/lifecycle.js";
import type { Committed } from "../../domain/budget/budget.js";
import type { Outcome } from "../../kernel/result.js";
import type {
  AliasRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  ArtifactManifest,
  ArtifactRecord,
  InterviewRecord,
  MailMessageRecord,
  MailScanRecord,
  ModelCallRecord,
  ModelCallReservation,
  ModelCallSettlement,
  PostingWrite,
  PostingWriteResult,
  PursuitEventRecord,
  RankingFilter,
  RankingRecord,
  RunRecord,
  SweepRecord,
  VoidRecord,
} from "../../ports/records.js";
import type { Store } from "../../ports/store.js";

/**
 * The SQLite implementation of the store port.
 *
 * It never reads the clock: every timestamp is passed in by the caller, which
 * got it from the injected Clock. And every logical write that must stay
 * consistent (a posting and its alias and opportunity, an application and the
 * pursuit event that records it, a mail message and the state change it
 * caused) is one transaction here, so no caller has to remember to wrap it.
 */
export class SqliteStore implements Store {
  constructor(readonly db: DB) {}

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------------- runs */

  startRun(command: string, at: string): number {
    return Number(this.db.prepare("INSERT INTO run (command, started_at) VALUES (?, ?)").run(command, at).lastInsertRowid);
  }

  finishRun(id: number, outcome: Outcome, result: unknown, error: string | null, at: string): void {
    this.db
      .prepare("UPDATE run SET finished_at = ?, outcome = ?, result_json = ?, error = ? WHERE id = ? AND finished_at IS NULL")
      .run(at, outcome, JSON.stringify(result ?? null), error, id);
  }

  recentRuns(sinceIso: string, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run WHERE started_at >= ? ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(sinceIso, limit) as Array<Record<string, unknown>>;
    return rows.map(toRun);
  }

  lastRun(command: string, outcomes: readonly string[]): RunRecord | null {
    const marks = outcomes.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT * FROM run WHERE command = ? AND outcome IN (${marks}) ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get(command, ...outcomes) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  /* --------------------------------------------------------------- configs */

  recordConfigVersion(kind: string, hash: string, body: unknown, at: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO config_version (hash, kind, body_json, first_seen) VALUES (?, ?, ?, ?)")
      .run(hash, kind, JSON.stringify(body), at);
  }

  /* ----------------------------------------------------------------- sweeps */

  beginSweep(runId: number | null, boardId: string, provider: string, at: string): number {
    return Number(
      this.db.prepare("INSERT INTO sweep (run_id, board_id, provider, started_at) VALUES (?, ?, ?, ?)").run(runId, boardId, provider, at)
        .lastInsertRowid,
    );
  }

  finishSweep(id: number, status: "complete" | "failed", jobCount: number, error: string | null, at: string): void {
    this.db
      .prepare("UPDATE sweep SET finished_at = ?, status = ?, job_count = ?, error = ? WHERE id = ? AND status = 'running'")
      .run(at, status, jobCount, error, id);
  }

  /** Latest complete sweep per board, with the start of the one before it. */
  boardCoverage(): BoardCoverage[] {
    const rows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT board_id, started_at, finished_at,
                  ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY started_at DESC, id DESC) AS rn
             FROM sweep WHERE status = 'complete'
         )
         SELECT a.board_id AS boardId, a.started_at AS startedAt, a.finished_at AS finishedAt, b.started_at AS previousStartedAt
           FROM ranked a LEFT JOIN ranked b ON b.board_id = a.board_id AND b.rn = 2
          WHERE a.rn = 1`,
      )
      .all() as BoardCoverage[];
    return rows;
  }

  latestSweeps(limit = 500): SweepRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sweep s WHERE s.id = (SELECT MAX(id) FROM sweep t WHERE t.board_id = s.board_id)
          ORDER BY board_id LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toSweep);
  }

  lastCompleteSweepAt(): string | null {
    const row = this.db.prepare("SELECT MAX(finished_at) AS m FROM sweep WHERE status = 'complete'").get() as { m: string | null };
    return row.m;
  }

  /* --------------------------------------------------------------- postings */

  resolutionIndex(): ResolutionIndex {
    const byAlias = this.db.prepare("SELECT opportunity_id AS id FROM alias WHERE board_id = ? AND external_id = ?");
    const byDedupe = this.db.prepare("SELECT id FROM opportunity WHERE dedupe_key = ? ORDER BY created_at, id LIMIT 1");
    const byContent = this.db.prepare("SELECT id, title FROM opportunity WHERE content_key = ? ORDER BY created_at, id LIMIT 1");
    const inGroup = this.db.prepare("SELECT id, title FROM opportunity WHERE group_key = ? LIMIT 200");
    return {
      byAlias: (b, e) => (byAlias.get(b, e) as { id: string } | undefined)?.id ?? null,
      byDedupeKey: (k) => (byDedupe.get(k) as { id: string } | undefined)?.id ?? null,
      byContentKey: (k) => (byContent.get(k) as { id: string; title: string } | undefined) ?? null,
      inGroup: (k) => inGroup.all(k) as Array<{ id: string; title: string }>,
    };
  }

  /**
   * Record one sweep's postings. One transaction: payload blob, a new posting
   * version when the payload changed, the alias, and the opportunity.
   */
  recordPostings(sweepId: number | null, at: string, items: readonly PostingWrite[]): PostingWriteResult {
    const putBlob = this.db.prepare("INSERT OR IGNORE INTO blob (hash, body) VALUES (?, ?)");
    const getAlias = this.db.prepare("SELECT payload_hash FROM alias WHERE board_id = ? AND external_id = ?");
    const addVersion = this.db.prepare(
      "INSERT INTO posting_version (board_id, external_id, payload_hash, observed_at, sweep_id) VALUES (?, ?, ?, ?, ?)",
    );
    const hasOpp = this.db.prepare("SELECT 1 FROM opportunity WHERE id = ?");
    const addOpp = this.db.prepare(
      "INSERT INTO opportunity (id, created_at, company, title, dedupe_key, content_key, group_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const addAlias = this.db.prepare(
      `INSERT INTO alias (board_id, external_id, opportunity_id, provider, url, first_seen, last_seen, payload_hash, resolved_how, snapshot_key, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchAlias = this.db.prepare(
      `UPDATE alias SET last_seen = ?, url = ?, payload_hash = ?, snapshot_key = ?, snapshot_json = ?
        WHERE board_id = ? AND external_id = ?`,
    );
    const result: PostingWriteResult = { newOpportunities: 0, newAliases: 0, changedPayloads: 0 };
    this.db.transaction(() => {
      for (const it of items) {
        putBlob.run(it.payloadHash, it.payloadJson);
        if (!hasOpp.get(it.opportunityId)) {
          addOpp.run(it.opportunityId, at, it.snapshot.company, it.snapshot.title, it.keys.dedupe, it.keys.content, it.keys.group);
          result.newOpportunities++;
        }
        const existing = getAlias.get(it.boardId, it.externalId) as { payload_hash: string } | undefined;
        const snapshotJson = JSON.stringify(it.snapshot);
        if (!existing) {
          addAlias.run(
            it.boardId, it.externalId, it.opportunityId, it.provider, it.url, it.firstSeen ?? at, it.lastSeen ?? at,
            it.payloadHash, it.resolvedHow, it.snapshotKey, snapshotJson,
          );
          addVersion.run(it.boardId, it.externalId, it.payloadHash, it.firstSeen ?? at, sweepId);
          result.newAliases++;
        } else {
          if (existing.payload_hash !== it.payloadHash) {
            addVersion.run(it.boardId, it.externalId, it.payloadHash, at, sweepId);
            result.changedPayloads++;
          }
          touchAlias.run(it.lastSeen ?? at, it.url, it.payloadHash, it.snapshotKey, snapshotJson, it.boardId, it.externalId);
        }
      }
    })();
    return result;
  }

  allAliases(): AliasRecord[] {
    const rows = this.db.prepare("SELECT * FROM alias").all() as Array<Record<string, unknown>>;
    return rows.map(toAlias);
  }

  aliasesFor(opportunityId: string): AliasRecord[] {
    const rows = this.db.prepare("SELECT * FROM alias WHERE opportunity_id = ? ORDER BY last_seen DESC").all(opportunityId) as Array<
      Record<string, unknown>
    >;
    return rows.map(toAlias);
  }

  blob(hash: string): string | null {
    const row = this.db.prepare("SELECT body FROM blob WHERE hash = ?").get(hash) as { body: string } | undefined;
    return row?.body ?? null;
  }

  saveSnapshotMemos(memos: ReadonlyArray<{ boardId: string; externalId: string; key: string; json: string }>): void {
    const stmt = this.db.prepare("UPDATE alias SET snapshot_key = ?, snapshot_json = ? WHERE board_id = ? AND external_id = ?");
    this.db.transaction(() => {
      for (const m of memos) stmt.run(m.key, m.json, m.boardId, m.externalId);
    })();
  }

  postingVersions(boardId: string, externalId: string): Array<{ payloadHash: string; observedAt: string }> {
    return this.db
      .prepare("SELECT payload_hash AS payloadHash, observed_at AS observedAt FROM posting_version WHERE board_id = ? AND external_id = ? ORDER BY id")
      .all(boardId, externalId) as Array<{ payloadHash: string; observedAt: string }>;
  }

  opportunityExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM opportunity WHERE id = ?").get(id) !== undefined;
  }

  /** Exact id, or a unique id prefix. */
  resolveOpportunityId(idOrPrefix: string): { id: string } | { ambiguous: string[] } | null {
    if (this.opportunityExists(idOrPrefix)) return { id: idOrPrefix };
    const rows = this.db.prepare("SELECT id FROM opportunity WHERE id LIKE ? LIMIT 5").all(`${idOrPrefix.replace(/[%_]/g, "")}%`) as Array<{
      id: string;
    }>;
    if (rows.length === 1) return { id: rows[0]!.id };
    if (rows.length > 1) return { ambiguous: rows.map((r) => r.id) };
    return null;
  }

  /* ------------------------------------------------------------- decisions */

  appendPursuitEvent(e: Omit<PursuitEventRecord, "id">, runId: number | null): number {
    return Number(
      this.db
        .prepare("INSERT INTO pursuit_event (opportunity_id, to_state, occurred_at, recorded_at, actor, note, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(e.opportunityId, e.to, e.occurredAt, e.recordedAt, e.actor, e.note, runId).lastInsertRowid,
    );
  }

  pursuitEvents(opportunityId?: string): PursuitEventRecord[] {
    const rows = (
      opportunityId
        ? this.db.prepare("SELECT * FROM pursuit_event WHERE opportunity_id = ? ORDER BY id").all(opportunityId)
        : this.db.prepare("SELECT * FROM pursuit_event ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      opportunityId: r.opportunity_id as string,
      to: r.to_state as PursuitEventRecord["to"],
      occurredAt: r.occurred_at as string,
      recordedAt: r.recorded_at as string,
      actor: r.actor as PursuitEventRecord["actor"],
      note: (r.note as string | null) ?? null,
    }));
  }

  /** An application and the pursuit event that records it, together. */
  createApplication(app: ApplicationRecord, pursuit: Omit<PursuitEventRecord, "id">, runId: number | null): void {
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO application (id, opportunity_id, submitted_at, recorded_at, note) VALUES (?, ?, ?, ?, ?)")
        .run(app.id, app.opportunityId, app.submittedAt, app.recordedAt, app.note);
      this.appendPursuitEvent(pursuit, runId);
    })();
  }

  applications(opportunityId?: string): ApplicationRecord[] {
    const rows = (
      opportunityId
        ? this.db.prepare("SELECT * FROM application WHERE opportunity_id = ? ORDER BY submitted_at").all(opportunityId)
        : this.db.prepare("SELECT * FROM application ORDER BY submitted_at").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      opportunityId: r.opportunity_id as string,
      submittedAt: r.submitted_at as string,
      recordedAt: r.recorded_at as string,
      note: (r.note as string | null) ?? null,
    }));
  }

  application(id: string): ApplicationRecord | null {
    return this.applications().find((a) => a.id === id) ?? null;
  }

  appendApplicationEvent(e: Omit<ApplicationEventRecord, "id">, runId: number | null): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO application_event (application_id, to_state, occurred_at, recorded_at, actor, note, mail_message_id, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(e.applicationId, e.to, e.occurredAt, e.recordedAt, e.actor, e.note, e.mailMessageId, runId).lastInsertRowid,
    );
  }

  applicationEvents(applicationId?: string): ApplicationEventRecord[] {
    const rows = (
      applicationId
        ? this.db.prepare("SELECT * FROM application_event WHERE application_id = ? ORDER BY id").all(applicationId)
        : this.db.prepare("SELECT * FROM application_event ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      applicationId: r.application_id as string,
      to: r.to_state as ApplicationEventRecord["to"],
      occurredAt: r.occurred_at as string,
      recordedAt: r.recorded_at as string,
      actor: r.actor as ApplicationEventRecord["actor"],
      note: (r.note as string | null) ?? null,
      mailMessageId: (r.mail_message_id as string | null) ?? null,
    }));
  }

  appendVoid(v: Omit<VoidRecord, "id">): number {
    return Number(
      this.db
        .prepare("INSERT INTO void_event (target_table, target_id, reason, recorded_at) VALUES (?, ?, ?, ?)")
        .run(v.targetTable, v.targetId, v.reason, v.recordedAt).lastInsertRowid,
    );
  }

  voids(targetTable: VoidRecord["targetTable"]): VoidRecord[] {
    const rows = this.db.prepare("SELECT * FROM void_event WHERE target_table = ? ORDER BY id").all(targetTable) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      targetTable: r.target_table as VoidRecord["targetTable"],
      targetId: r.target_id as number,
      reason: r.reason as string,
      recordedAt: r.recorded_at as string,
    }));
  }

  recordOverride(opportunityId: string, gate: string, detail: string, at: string, runId: number | null): void {
    this.db
      .prepare("INSERT INTO override_event (opportunity_id, gate, detail, recorded_at, run_id) VALUES (?, ?, ?, ?, ?)")
      .run(opportunityId, gate, detail, at, runId);
  }

  overrides(opportunityId: string): Array<{ gate: string; detail: string | null; recordedAt: string }> {
    return this.db
      .prepare("SELECT gate, detail, recorded_at AS recordedAt FROM override_event WHERE opportunity_id = ? ORDER BY id")
      .all(opportunityId) as Array<{ gate: string; detail: string | null; recordedAt: string }>;
  }

  /* ------------------------------------------------------------ model calls */

  /**
   * Reserve, atomically with the budget check: the committed totals are read
   * and the reservation is written in one IMMEDIATE transaction, so two
   * processes cannot both fit under the same ceiling.
   */
  reserveModelCall(
    r: ModelCallReservation,
    windows: { dayStart: string; monthStart: string },
    check: (committed: Committed) => string | null,
  ): { id: number } | { refused: string } {
    const run = this.db.transaction(() => {
      const committed = this.committedSpend(r.runId, windows);
      const refusal = check(committed);
      if (refusal) return { refused: refusal };
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO model_call (run_id, purpose, subject_id, request_key, model, effort, reserved_usd, status, created_at, provider)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
          )
          .run(r.runId, r.purpose, r.subjectId, r.requestKey, r.model, r.effort, r.reservedUsd, r.at, r.provider).lastInsertRowid,
      );
      return { id };
    });
    return run.immediate();
  }

  settleModelCall(s: ModelCallSettlement): void {
    this.db
      .prepare(
        `UPDATE model_call SET status = 'settled', outcome = ?, usage_known = ?, input_tokens = ?, cache_write_tokens = ?,
                cache_read_tokens = ?, output_tokens = ?, actual_usd = ?, error = ?, settled_at = ?
          WHERE id = ? AND status = 'reserved'`,
      )
      .run(
        s.outcome,
        s.usageKnown ? 1 : 0,
        s.usage.input,
        s.usage.cacheWrite,
        s.usage.cacheRead,
        s.usage.output,
        s.actualUsd,
        s.error,
        s.at,
        s.id,
      );
  }

  /**
   * Settled cost where known; the reserved worst case where the call never
   * settled or settled without a usage receipt. Unknown is never zero.
   */
  committedSpend(runId: number | null, windows: { dayStart: string; monthStart: string }): Committed {
    const amount = `CASE WHEN status = 'settled' AND usage_known = 1 THEN actual_usd ELSE reserved_usd END`;
    const sum = (where: string, ...args: unknown[]) =>
      (this.db.prepare(`SELECT COALESCE(SUM(${amount}), 0) AS s FROM model_call WHERE ${where}`).get(...args) as { s: number }).s;
    return {
      run: runId === null ? 0 : sum("run_id = ?", runId),
      day: sum("created_at >= ?", windows.dayStart),
      month: sum("created_at >= ?", windows.monthStart),
    };
  }

  modelCalls(opts: { sinceIso?: string; runId?: number; subjectId?: string } = {}): ModelCallRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    if (opts.runId !== undefined) {
      where.push("run_id = ?");
      args.push(opts.runId);
    }
    if (opts.subjectId) {
      where.push("subject_id = ?");
      args.push(opts.subjectId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM model_call ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      runId: (r.run_id as number | null) ?? null,
      purpose: r.purpose as string,
      subjectId: (r.subject_id as string | null) ?? null,
      requestKey: r.request_key as string,
      model: r.model as string,
      effort: r.effort as string,
      reservedUsd: r.reserved_usd as number,
      at: r.created_at as string,
      provider: ((r.provider as ModelCallRecord["provider"] | null) ?? "api"),
      status: r.status as "reserved" | "settled",
      outcome: (r.outcome as ModelCallRecord["outcome"]) ?? null,
      usageKnown: r.usage_known === null ? null : r.usage_known === 1,
      usage: {
        input: r.input_tokens as number,
        cacheWrite: r.cache_write_tokens as number,
        cacheRead: r.cache_read_tokens as number,
        output: r.output_tokens as number,
      },
      actualUsd: (r.actual_usd as number | null) ?? null,
      error: (r.error as string | null) ?? null,
      settledAt: (r.settled_at as string | null) ?? null,
    }));
  }

  /* ------------------------------------------------------------ derivations */

  getDerivation(kind: string, inputKey: string): { output: unknown; createdAt: string } | null {
    const row = this.db.prepare("SELECT output_json, created_at FROM derivation WHERE kind = ? AND input_key = ?").get(kind, inputKey) as
      | { output_json: string; created_at: string }
      | undefined;
    return row ? { output: JSON.parse(row.output_json), createdAt: row.created_at } : null;
  }

  putDerivation(kind: string, inputKey: string, output: unknown, modelCallId: number | null, at: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO derivation (kind, input_key, output_json, model_call_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(kind, inputKey, JSON.stringify(output), modelCallId, at);
  }

  useDerivation(kind: string, subjectId: string, inputKey: string, at: string): void {
    this.db.prepare("INSERT OR IGNORE INTO derivation_use (kind, subject_id, input_key, at) VALUES (?, ?, ?, ?)").run(kind, subjectId, inputKey, at);
  }

  /** Every input key this subject has ever had a derivation of this kind for. */
  derivationUses(kind: string, subjectId: string): Array<{ inputKey: string; at: string }> {
    return this.db
      .prepare("SELECT input_key AS inputKey, at FROM derivation_use WHERE kind = ? AND subject_id = ? ORDER BY at DESC")
      .all(kind, subjectId) as Array<{ inputKey: string; at: string }>;
  }

  subjectsWithDerivation(kind: string): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT subject_id AS s FROM derivation_use WHERE kind = ?").all(kind) as Array<{ s: string }>;
    return new Set(rows.map((r) => r.s));
  }

  recordAssessmentFailure(opportunityId: string, inputKey: string, kind: string, counts: boolean, reason: string, at: string): void {
    this.db
      .prepare("INSERT INTO assessment_failure (opportunity_id, input_key, kind, counts, reason, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(opportunityId, inputKey, kind, counts ? 1 : 0, reason.slice(0, 500), at);
  }

  countedFailures(inputKey: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM assessment_failure WHERE input_key = ? AND counts = 1").get(inputKey) as { n: number }).n;
  }

  recentFailures(limit = 50): Array<{ opportunityId: string; kind: string; reason: string; counts: boolean; at: string }> {
    const rows = this.db
      .prepare("SELECT opportunity_id, kind, reason, counts, at FROM assessment_failure ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      opportunityId: r.opportunity_id as string,
      kind: r.kind as string,
      reason: r.reason as string,
      counts: r.counts === 1,
      at: r.at as string,
    }));
  }

  /* -------------------------------------------------------------- artifacts */

  recordArtifact(a: Omit<ArtifactRecord, "approvedAt">, runId: number | null): void {
    this.db
      .prepare(
        `INSERT INTO artifact (id, opportunity_id, kind, plan_key, posting_material, evidence_version, dir, manifest_json, created_at, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.opportunityId, a.kind, a.planKey, a.postingMaterial, a.evidenceVersion, a.dir, JSON.stringify(a.manifest), a.createdAt, runId);
  }

  artifacts(opportunityId: string, kind?: ArtifactRecord["kind"]): ArtifactRecord[] {
    const rows = (
      kind
        ? this.db.prepare("SELECT * FROM artifact WHERE opportunity_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC").all(opportunityId, kind)
        : this.db.prepare("SELECT * FROM artifact WHERE opportunity_id = ? ORDER BY created_at DESC, rowid DESC").all(opportunityId)
    ) as Array<Record<string, unknown>>;
    const approval = this.db.prepare("SELECT MAX(approved_at) AS a FROM artifact_approval WHERE artifact_id = ?");
    return rows.map((r) => ({
      id: r.id as string,
      opportunityId: r.opportunity_id as string,
      kind: r.kind as ArtifactRecord["kind"],
      planKey: r.plan_key as string,
      postingMaterial: r.posting_material as string,
      evidenceVersion: r.evidence_version as string,
      dir: r.dir as string,
      manifest: JSON.parse(r.manifest_json as string) as ArtifactManifest,
      createdAt: r.created_at as string,
      approvedAt: (approval.get(r.id) as { a: string | null }).a,
    }));
  }

  approveArtifact(artifactId: string, at: string, note: string | null): void {
    this.db.prepare("INSERT INTO artifact_approval (artifact_id, approved_at, note) VALUES (?, ?, ?)").run(artifactId, at, note);
  }

  /* ------------------------------------------------------------------- mail */

  beginMailScan(runId: number | null, mailbox: string, query: string, from: string, to: string, at: string): number {
    return Number(
      this.db
        .prepare("INSERT INTO mail_scan (run_id, mailbox, query, range_from, range_to, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
        .run(runId, mailbox, query, from, to, at).lastInsertRowid,
    );
  }

  finishMailScan(id: number, status: "complete" | "partial" | "failed", pages: number, messages: number, error: string | null, at: string): void {
    this.db
      .prepare("UPDATE mail_scan SET status = ?, pages = ?, messages = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(status, pages, messages, error, at, id);
  }

  mailScans(mailbox?: string): MailScanRecord[] {
    const rows = (
      mailbox
        ? this.db.prepare("SELECT * FROM mail_scan WHERE mailbox = ? ORDER BY id").all(mailbox)
        : this.db.prepare("SELECT * FROM mail_scan ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      mailbox: r.mailbox as string,
      query: r.query as string,
      rangeFrom: r.range_from as string,
      rangeTo: r.range_to as string,
      status: r.status as MailScanRecord["status"],
      pages: r.pages as number,
      messages: r.messages as number,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
      error: (r.error as string | null) ?? null,
    }));
  }

  mailSeen(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM mail_message WHERE message_id = ?").get(messageId) !== undefined;
  }

  /**
   * A message, and the application event it caused if any, in one
   * transaction: an outcome is never recorded without the mail that explains
   * it, nor the mail marked applied without the outcome.
   */
  recordMail(m: MailMessageRecord, event: Omit<ApplicationEventRecord, "id"> | null, runId: number | null): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO mail_message (message_id, mailbox, received_at, from_address, subject, kinds, evidence, resolution, application_id, note, observed_at, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          m.messageId,
          m.mailbox,
          m.receivedAt,
          m.from,
          m.subject,
          m.kinds.join(","),
          m.evidence.slice(0, 5).join(" | ").slice(0, 500),
          m.resolution,
          m.applicationId,
          m.note,
          m.observedAt,
          runId,
        );
      if (event) this.appendApplicationEvent(event, runId);
    })();
  }

  mailMessages(opts: { resolutions?: readonly string[]; applicationId?: string; limit?: number } = {}): MailMessageRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.resolutions?.length) {
      where.push(`resolution IN (${opts.resolutions.map(() => "?").join(",")})`);
      args.push(...opts.resolutions);
    }
    if (opts.applicationId) {
      where.push("application_id = ?");
      args.push(opts.applicationId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM mail_message ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC LIMIT ?`)
      .all(...args, opts.limit ?? 500) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      messageId: r.message_id as string,
      mailbox: r.mailbox as string,
      receivedAt: r.received_at as string,
      from: r.from_address as string,
      subject: r.subject as string,
      kinds: ((r.kinds as string) || "").split(",").filter(Boolean),
      evidence: ((r.evidence as string | null) ?? "").split(" | ").filter(Boolean),
      resolution: r.resolution as MailMessageRecord["resolution"],
      applicationId: (r.application_id as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      observedAt: r.observed_at as string,
    }));
  }

  /* ---------------------------------------------------------------- ranking */

  /** Replace the read model whole, in one transaction, with its evaluation record. */
  replaceRanking(rows: readonly RankingRecord[], evaluation: { runId: number | null; at: string; policyVersion: string; calibration: unknown; summary: unknown }): void {
    const insert = this.db.prepare(
      `INSERT INTO ranking (opportunity_id, company, title, location, remote_status, date_posted, lane, eligible, evergreen,
         posting_state, pursuit_state, raw_fit, raw_roi, raw_priority, proj_fit, proj_roi, analyst_fit, analyst_roi, analyst_rec,
         analyst_tier, stale_assessment, fit, roi, priority, confidence, comp_band, detail_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.exec("DELETE FROM ranking");
      for (const r of rows) {
        insert.run(
          r.opportunityId, r.company, r.title, r.location, r.remoteStatus, r.datePosted, r.lane, r.eligible ? 1 : 0, r.evergreen ? 1 : 0,
          r.postingState, r.pursuitState, r.rawFit, r.rawRoi, r.rawPriority, r.projFit, r.projRoi, r.analystFit, r.analystRoi, r.analystRec,
          r.analystTier, r.staleAssessment ? 1 : 0, r.fit, r.roi, r.priority, r.confidence, r.compBand, JSON.stringify(r.detail), r.evaluatedAt,
        );
      }
      this.db
        .prepare("INSERT INTO evaluation (run_id, at, policy_version, calibration_json, summary_json) VALUES (?, ?, ?, ?, ?)")
        .run(evaluation.runId, evaluation.at, evaluation.policyVersion, JSON.stringify(evaluation.calibration), JSON.stringify(evaluation.summary));
    })();
  }

  ranking(f: RankingFilter = {}): RankingRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.opportunityId) {
      where.push("opportunity_id = ?");
      args.push(f.opportunityId);
    }
    if (f.eligible !== undefined) {
      where.push("eligible = ?");
      args.push(f.eligible ? 1 : 0);
    }
    if (f.includeEvergreen === false) where.push("evergreen = 0");
    if (f.pursuitStates?.length) {
      where.push(`pursuit_state IN (${f.pursuitStates.map(() => "?").join(",")})`);
      args.push(...f.pursuitStates);
    }
    if (f.postingStates?.length) {
      where.push(`posting_state IN (${f.postingStates.map(() => "?").join(",")})`);
      args.push(...f.postingStates);
    }
    if (f.lane) {
      where.push("lane = ?");
      args.push(f.lane);
    }
    if (f.minFit !== undefined) {
      where.push("fit >= ?");
      args.push(f.minFit);
    }
    if (f.priorities?.length) {
      where.push(`priority IN (${f.priorities.map(() => "?").join(",")})`);
      args.push(...f.priorities);
    }
    const rows = this.db
      .prepare(`SELECT * FROM ranking ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY roi DESC, fit DESC, opportunity_id LIMIT ?`)
      .all(...args, f.limit ?? 1_000_000) as Array<Record<string, unknown>>;
    return rows.map(toRanking);
  }

  rankingFor(opportunityId: string): RankingRecord | null {
    return this.ranking({ opportunityId, limit: 1 })[0] ?? null;
  }

  lastEvaluation(): { at: string; policyVersion: string; calibration: unknown; summary: unknown } | null {
    const row = this.db.prepare("SELECT * FROM evaluation ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      at: row.at as string,
      policyVersion: row.policy_version as string,
      calibration: JSON.parse(row.calibration_json as string),
      summary: JSON.parse(row.summary_json as string),
    };
  }

  /* ------------------------------------------------------------- interviews */

  addInterview(i: Omit<InterviewRecord, "id">): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO interview (application_id, company, role, stage, occurred_on, questions_json, topics_json, self_rating, comp_discussed, notes, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          i.applicationId,
          i.company,
          i.role,
          i.stage,
          i.occurredOn,
          JSON.stringify(i.questions),
          JSON.stringify(i.topics),
          i.selfRating,
          i.compDiscussed ? 1 : 0,
          i.notes,
          i.recordedAt,
        ).lastInsertRowid,
    );
  }

  interviews(company?: string): InterviewRecord[] {
    const rows = (
      company
        ? this.db.prepare("SELECT * FROM interview WHERE company LIKE ? ORDER BY occurred_on DESC").all(`%${company}%`)
        : this.db.prepare("SELECT * FROM interview ORDER BY occurred_on DESC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      applicationId: (r.application_id as string | null) ?? null,
      company: r.company as string,
      role: r.role as string,
      stage: r.stage as string,
      occurredOn: r.occurred_on as string,
      questions: JSON.parse(r.questions_json as string) as string[],
      topics: JSON.parse(r.topics_json as string) as string[],
      selfRating: (r.self_rating as number | null) ?? null,
      compDiscussed: r.comp_discussed === 1,
      notes: (r.notes as string | null) ?? null,
      recordedAt: r.recorded_at as string,
    }));
  }

  /* --------------------------------------------------------------- legacy */

  /** A historical, already-settled paid call (legacy import). */
  importModelCall(c: Omit<ModelCallRecord, "id">): void {
    this.db
      .prepare(
        `INSERT INTO model_call (run_id, purpose, subject_id, request_key, model, effort, reserved_usd, status, outcome, usage_known,
           input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, actual_usd, error, created_at, settled_at, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.runId, c.purpose, c.subjectId, c.requestKey, c.model, c.effort, c.reservedUsd, c.status, c.outcome, c.usageKnown === null ? null : c.usageKnown ? 1 : 0,
        c.usage.input, c.usage.cacheWrite, c.usage.cacheRead, c.usage.output, c.actualUsd, c.error, c.at, c.settledAt, c.provider,
      );
  }

  importRun(r: Omit<RunRecord, "id">): number {
    return Number(
      this.db
        .prepare("INSERT INTO run (command, started_at, finished_at, outcome, result_json, error) VALUES (?, ?, ?, ?, ?, ?)")
        .run(r.command, r.startedAt, r.finishedAt, r.outcome, JSON.stringify(r.result ?? null), r.error).lastInsertRowid,
    );
  }

  /** Run `fn` in one transaction (used by bulk import). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function toRun(r: Record<string, unknown>): RunRecord {
  return {
    id: r.id as number,
    command: r.command as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    outcome: r.outcome as RunRecord["outcome"],
    result: r.result_json ? JSON.parse(r.result_json as string) : null,
    error: (r.error as string | null) ?? null,
  };
}

function toSweep(r: Record<string, unknown>): SweepRecord {
  return {
    id: r.id as number,
    boardId: r.board_id as string,
    provider: r.provider as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    status: r.status as SweepRecord["status"],
    jobCount: r.job_count as number,
    error: (r.error as string | null) ?? null,
  };
}

function toAlias(r: Record<string, unknown>): AliasRecord {
  return {
    boardId: r.board_id as string,
    externalId: r.external_id as string,
    opportunityId: r.opportunity_id as string,
    provider: r.provider as string,
    url: r.url as string,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
    payloadHash: r.payload_hash as string,
    resolvedHow: r.resolved_how as string,
    snapshotKey: (r.snapshot_key as string | null) ?? null,
    snapshotJson: (r.snapshot_json as string | null) ?? null,
  };
}

function toRanking(r: Record<string, unknown>): RankingRecord {
  return {
    opportunityId: r.opportunity_id as string,
    company: r.company as string,
    title: r.title as string,
    location: r.location as string,
    remoteStatus: r.remote_status as string,
    datePosted: (r.date_posted as string | null) ?? null,
    lane: r.lane as string,
    eligible: r.eligible === 1,
    evergreen: r.evergreen === 1,
    postingState: r.posting_state as RankingRecord["postingState"],
    pursuitState: r.pursuit_state as RankingRecord["pursuitState"],
    rawFit: r.raw_fit as number,
    rawRoi: r.raw_roi as number,
    rawPriority: r.raw_priority as RankingRecord["rawPriority"],
    projFit: (r.proj_fit as number | null) ?? null,
    projRoi: (r.proj_roi as number | null) ?? null,
    analystFit: (r.analyst_fit as number | null) ?? null,
    analystRoi: (r.analyst_roi as number | null) ?? null,
    analystRec: (r.analyst_rec as string | null) ?? null,
    analystTier: (r.analyst_tier as string | null) ?? null,
    staleAssessment: r.stale_assessment === 1,
    fit: r.fit as number,
    roi: r.roi as number,
    priority: r.priority as RankingRecord["priority"],
    confidence: r.confidence as RankingRecord["confidence"],
    compBand: r.comp_band as string,
    detail: JSON.parse(r.detail_json as string) as RankingRecord["detail"],
    evaluatedAt: r.evaluated_at as string,
  };
}
