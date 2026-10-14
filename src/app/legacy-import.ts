import type { AppContext } from "./context.js";
import type { LegacyData, LegacyJob } from "../ports/legacy.js";
import type { PostingWrite, ApplicationRecord } from "../ports/records.js";
import type { RawPosting } from "../domain/catalog/posting.js";
import type { Period } from "../domain/text/salary.js";
import type { ApplicationState, PursuitState } from "../domain/pursuit/machines.js";
import { normalizePosting } from "../domain/catalog/normalize.js";
import { contentKey, dedupeKey, groupKey } from "../domain/catalog/resolve.js";
import { canonicalJson, sha256, shortId } from "../kernel/hash.js";
import { ok, refused, type UseCaseResult } from "../kernel/result.js";
import { snapshotKey } from "./sweep.js";
import { DOSSIER_KIND, TRIAGE_KIND } from "./assessment-requests.js";
import type { CallOutcome } from "../ports/records.js";

/**
 * Bring a previous Job Radar database across without losing history.
 *
 *   jobs + job_sources      -> opportunities, aliases, posting versions
 *   status_changed history  -> pursuit and application EVENTS at their
 *                              original times (state is a fold over them)
 *   analyses                -> kept for reference, deliberately STALE: the
 *                              exact inputs they were formed against are not
 *                              knowable, so they never count as current
 *   email_events            -> mail messages
 *   model_receipts + runs   -> the one spend ledger (pre-receipt runs as
 *                              lower-bound estimates)
 *   interviews, runs        -> as they were
 *
 * No board coverage is imported, so nothing is inferred closed until the
 * first real sweep. Refuses to run into a database that already has data.
 */
export interface LegacyImportSummary {
  opportunities: number;
  aliases: number;
  pursuitEvents: number;
  applications: number;
  applicationEvents: number;
  legacyAssessments: number;
  mail: number;
  modelCalls: number;
  runs: number;
  interviews: number;
  automaticGhosts: number;
  /** Links the old content dedupe made to ANOTHER job's own posting, or to a posting already linked elsewhere. Not imported. */
  contestedLinks: number;
  /** Applications whose history never recorded a human submission (e.g. it starts with a mailed rejection). */
  unconfirmedSubmissions: number;
  /** Application events the old history later moved back past (e.g. SCREEN then APPLIED again), imported and voided. */
  correctedEvents: number;
}

const PURSUIT_MAP: Record<string, PursuitState> = { REVIEWED: "reviewed", SAVED: "shortlisted", SKIPPED: "skipped", APPLY: "preparing" };
const APP_MAP: Record<string, ApplicationState> = {
  APPLIED: "submitted",
  CONTACTED: "contacted",
  SCREEN: "screen",
  INTERVIEW: "interview",
  FINAL: "final",
  OFFER: "offer",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
  GHOSTED: "ghosted",
};
const OUTCOMES = new Set<CallOutcome>(["success", "refusal", "truncated", "invalid_json", "schema", "api_error"]);

function rawFor(j: LegacyJob, boardId: string, externalId: string, url: string): RawPosting {
  return {
    provider: j.source,
    boardId,
    externalId,
    sourceUrl: url,
    applicationUrl: j.applicationUrl,
    company: j.company,
    title: j.title,
    locationRaw: j.location,
    isRemote: j.remoteStatus === "remote" ? true : null,
    workplaceType: j.remoteStatus === "hybrid" ? "Hybrid" : j.remoteStatus === "onsite" ? "On-site" : null,
    employmentTypeRaw: j.employmentType === "unknown" ? null : j.employmentType.replace(/_/g, " "),
    datePosted: j.datePosted,
    descriptionHtml: "",
    descriptionPlain: j.description,
    department: j.department,
    team: j.team,
    salary:
      j.salaryMin != null || j.salaryMax != null
        ? { min: j.salaryMin, max: j.salaryMax, currency: j.salaryCurrency, period: (j.salaryPeriod as Period | null) ?? null }
        : null,
  };
}

export function importLegacy(ctx: AppContext, data: LegacyData): UseCaseResult<LegacyImportSummary> {
  const s: LegacyImportSummary = {
    opportunities: 0,
    aliases: 0,
    pursuitEvents: 0,
    applications: 0,
    applicationEvents: 0,
    legacyAssessments: 0,
    mail: 0,
    modelCalls: 0,
    runs: 0,
    interviews: 0,
    automaticGhosts: 0,
    contestedLinks: 0,
    unconfirmedSubmissions: 0,
    correctedEvents: 0,
  };
  if (ctx.store.allAliases().length > 0 || ctx.store.applications().length > 0) {
    return refused(s, ["This database already has data. Import into a fresh one (set JR_DB to a new path)."]);
  }
  const prefs = ctx.config().preferences;
  const now = ctx.clock.now().toISOString();

  ctx.store.transaction(() => {
    // Postings.
    const extra = new Map<string, LegacyData["sources"]>();
    for (const src of data.sources) extra.set(src.jobId, [...(extra.get(src.jobId) ?? []), src]);
    // A job's own posting is its identity; a job_sources link to it from
    // another job is the old content dedupe merging two different roles. The
    // owner must not depend on which job happens to be imported first.
    const ownerOf = new Map<string, string>();
    for (const j of data.jobs) ownerOf.set(`${j.source}|${j.externalId}`, j.id);
    const linkCount = new Map<string, number>();
    for (const src of data.sources) {
      const k = `${src.source}|${src.externalId}`;
      linkCount.set(k, (linkCount.get(k) ?? 0) + 1);
    }
    for (const j of data.jobs) {
      const writes: PostingWrite[] = [];
      const add = (boardId: string, provider: string, externalId: string, url: string, firstSeen: string, lastSeen: string) => {
        const raw = rawFor(j, boardId, externalId, url);
        const payloadJson = canonicalJson(raw);
        const payloadHash = sha256(payloadJson);
        const snapshot = normalizePosting(raw, prefs);
        writes.push({
          boardId,
          externalId,
          provider,
          url,
          payloadHash,
          payloadJson,
          opportunityId: j.id,
          resolvedHow: writes.length === 0 ? "new" : "alias",
          snapshot,
          snapshotKey: snapshotKey(payloadHash, prefs),
          keys: { dedupe: dedupeKey(snapshot), content: contentKey(snapshot), group: groupKey(snapshot) },
          firstSeen,
          lastSeen,
        });
      };
      add(j.boardId, j.source, j.externalId, j.sourceUrl, j.firstSeen, j.lastSeen);
      for (const src of extra.get(j.id) ?? []) {
        if (src.source === j.source && src.externalId === j.externalId) continue;
        const k = `${src.source}|${src.externalId}`;
        const owner = ownerOf.get(k);
        // Another job's own posting, or one the old dedupe gave to several
        // jobs: no job has a better claim than another, so none gets it and
        // the next sweep resolves it afresh.
        if ((owner !== undefined && owner !== j.id) || (owner === undefined && (linkCount.get(k) ?? 0) > 1)) {
          s.contestedLinks++;
          continue;
        }
        const token = src.externalId.includes(":") ? src.externalId.split(":")[0] : null;
        add(token ? `${src.source}:${token}` : src.source, src.source, src.externalId, src.url, src.firstSeen, src.lastSeen);
      }
      const r = ctx.store.recordPostings(null, now, writes);
      s.opportunities += r.newOpportunities;
      s.aliases += r.newAliases;
    }

    // Decisions, replayed as events at their original times.
    const events = new Map<string, LegacyData["statusEvents"]>();
    for (const e of data.statusEvents) events.set(e.jobId, [...(events.get(e.jobId) ?? []), e]);
    const appByJob = new Map<string, string>();
    for (const j of data.jobs) {
      const history = [...(events.get(j.id) ?? [])];
      if (!history.length && j.status !== "NEW" && j.status !== "CLOSED") {
        history.push({ jobId: j.id, from: null, to: j.status, at: j.statusChangedAt ?? j.firstSeen, note: "imported current status (no history)" });
      }
      let appId: string | null = null;
      let sinceSubmission: Array<{ id: number; at: string }> = [];
      for (const e of history) {
        const pursuit = PURSUIT_MAP[e.to];
        const appState = APP_MAP[e.to];
        const fromMail = /from email/i.test(e.note ?? "");
        const automatic = e.to === "GHOSTED" && /no response in \d+ days/i.test(e.note ?? "");
        if (pursuit && !appId) {
          ctx.store.appendPursuitEvent({ opportunityId: j.id, to: pursuit, occurredAt: e.at, recordedAt: now, actor: "human", note: `legacy: ${e.note ?? e.to}` }, null);
          s.pursuitEvents++;
        } else if (appState) {
          if (!appId) {
            // Only a human APPLIED is a recorded submission. A history whose
            // first application event is anything else (a rejection read from
            // mail, an automatic ghosting, a bare current status) never
            // recorded one: the application is imported, attributed to what
            // actually produced it, and flagged for the human to confirm.
            const confirmed = appState === "submitted" && !fromMail;
            const app: ApplicationRecord = {
              id: shortId(`${j.id}|${e.at}`, 10),
              opportunityId: j.id,
              submittedAt: e.at,
              recordedAt: now,
              note: confirmed ? "imported from legacy status history" : "imported: the old history has no recorded submission; confirm it or void it",
            };
            ctx.store.createApplication(
              app,
              {
                opportunityId: j.id,
                to: "applied",
                occurredAt: e.at,
                recordedAt: now,
                actor: confirmed ? "human" : fromMail ? "mail" : "system",
                note: confirmed ? "legacy" : `legacy, UNCONFIRMED: first recorded event was ${e.to}${e.note ? ` (${e.note})` : ""}`,
              },
              null,
            );
            if (!confirmed) s.unconfirmedSubmissions++;
            appId = app.id;
            appByJob.set(j.id, appId);
            s.applications++;
            s.pursuitEvents++;
          }
          if (appState === "submitted" && !fromMail) {
            // A human moving BACK to APPLIED is the old tool's only way to undo
            // a mistaken later state. Keep the record, void it. (A late
            // confirmation email is not a correction, so it voids nothing.)
            for (const prior of sinceSubmission) {
              ctx.store.appendVoid({
                targetTable: "application_event",
                targetId: prior.id,
                reason: `legacy: status moved back to APPLIED at ${e.at}`,
                recordedAt: now,
              });
              s.correctedEvents++;
            }
            sinceSubmission = [];
          } else {
            const eventId = ctx.store.appendApplicationEvent(
              {
                applicationId: appId,
                to: appState,
                occurredAt: e.at,
                recordedAt: now,
                actor: automatic ? "system" : fromMail ? "mail" : "human",
                note: automatic ? `legacy AUTOMATIC ghosting (${e.note}); void it if it was wrong` : `legacy: ${e.note ?? e.to}`,
                mailMessageId: null,
              },
              null,
            );
            sinceSubmission.push({ id: eventId, at: e.at });
            s.applicationEvents++;
            if (automatic) s.automaticGhosts++;
          }
        }
      }
    }

    // Analyses: kept, and stale by construction.
    for (const j of data.jobs) {
      if (!j.analysisJson) continue;
      let parsed: { interviewProbability?: unknown } = {};
      try {
        parsed = JSON.parse(j.analysisJson);
      } catch {
        continue;
      }
      const key = `legacy:${j.id}`;
      ctx.store.putDerivation("assessment:legacy", key, { model: j.analysisModel, analyzedAt: j.analyzedAt, analysis: parsed }, null, j.analyzedAt ?? now);
      ctx.store.useDerivation(parsed.interviewProbability == null ? TRIAGE_KIND : DOSSIER_KIND, j.id, key, j.analyzedAt ?? now);
      s.legacyAssessments++;
    }

    // Mail.
    for (const m of data.emails) {
      ctx.store.recordMail(
        {
          messageId: m.messageId,
          mailbox: m.source,
          receivedAt: m.receivedAt,
          from: m.from,
          subject: m.subject,
          kinds: m.kinds.split(",").filter(Boolean),
          evidence: (m.evidence ?? "").split(" | ").filter(Boolean),
          resolution: m.appliedStatus ? "applied" : (["matched", "ambiguous", "unmatched", "ignored"].includes(m.resolution) ? m.resolution : "matched") as "matched",
          applicationId: m.jobId ? (appByJob.get(m.jobId) ?? null) : null,
          note: m.note,
          observedAt: m.seenAt,
        },
        null,
        null,
      );
      s.mail++;
    }

    // Spend: receipts, plus pre-receipt runs as lower-bound estimates.
    const firstReceipt = data.receipts[0]?.at ?? null;
    for (const r of data.receipts) {
      ctx.store.importModelCall({
        runId: null,
        purpose: r.purpose,
        subjectId: r.jobId,
        requestKey: `legacy:${r.at}:${r.purpose}`,
        model: r.model,
        effort: "unknown",
        reservedUsd: r.price,
        at: r.at,
        status: "settled",
        outcome: OUTCOMES.has(r.outcome as CallOutcome) ? (r.outcome as CallOutcome) : "api_error",
        usageKnown: r.usageKnown,
        usage: { input: r.input, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead, output: r.output },
        actualUsd: r.price,
        error: null,
        settledAt: r.at,
      });
      s.modelCalls++;
    }
    for (const run of data.runs) {
      ctx.store.importRun({
        command: `legacy:${run.command}`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.ok ? "ok" : "failed",
        result: run.stats,
        error: run.ok ? null : String((run.stats as { error?: unknown } | null)?.error ?? "unknown"),
      });
      s.runs++;
      const usd = Number((run.stats as { estimatedCostUsd?: unknown } | null)?.estimatedCostUsd ?? 0);
      if (usd > 0 && (!firstReceipt || run.startedAt < firstReceipt)) {
        const u = ((run.stats as { usage?: Record<string, number> } | null)?.usage ?? {}) as Record<string, number>;
        ctx.store.importModelCall({
          runId: null,
          purpose: `legacy:${run.command}`,
          subjectId: (run.stats as { jobId?: string } | null)?.jobId ?? null,
          requestKey: `legacy-run:${run.startedAt}`,
          model: "unknown",
          effort: "unknown",
          reservedUsd: usd,
          at: run.startedAt,
          status: "settled",
          outcome: "success",
          usageKnown: true,
          usage: { input: u.input ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheRead: u.cacheRead ?? 0, output: u.output ?? 0 },
          actualUsd: usd,
          error: "legacy run-level estimate (lower bound)",
          settledAt: run.startedAt,
        });
        s.modelCalls++;
      }
    }

    for (const i of data.interviews) {
      ctx.store.addInterview({
        applicationId: i.job_id ? (appByJob.get(String(i.job_id)) ?? null) : null,
        company: String(i.company),
        role: String(i.role),
        stage: String(i.stage),
        occurredOn: String(i.occurred_on),
        questions: safeArray(i.questions),
        topics: [...safeArray(i.technical_topics), ...safeArray(i.behavioral_topics)],
        selfRating: (i.answer_quality as number | null) ?? null,
        compDiscussed: i.comp_discussed === 1,
        notes: [i.notes, i.signals, i.result ? `result: ${i.result}` : null].filter(Boolean).join("\n") || null,
        recordedAt: String(i.created_at ?? now),
      });
      s.interviews++;
    }
  });

  const notes = ["Imported. Run `jr evaluate`, then a real `jr sweep` before trusting open/closed states."];
  if (s.legacyAssessments) notes.push(`${s.legacyAssessments} legacy assessment(s) are kept for reference and treated as stale; re-assess what you still care about.`);
  if (s.contestedLinks)
    notes.push(`${s.contestedLinks} posting link(s) from the old content dedupe were not imported: each pointed at another job's own posting, or at a posting several jobs claimed. Each posting stays with the job it belongs to; unclaimed ones are matched afresh by the next sweep.`);
  if (s.unconfirmedSubmissions)
    notes.push(`${s.unconfirmedSubmissions} application(s) have no recorded submission in the old history (it starts with a later state); they are flagged UNCONFIRMED in \`jr apps --events\`. Void any you did not submit.`);
  if (s.correctedEvents) notes.push(`${s.correctedEvents} application event(s) were later moved back to APPLIED in the old history; they are imported and voided.`);
  if (s.automaticGhosts) notes.push(`${s.automaticGhosts} GHOSTED outcome(s) were set automatically by the old tool, which never read mail. Review them: \`jr apps\`, and \`jr void application <event-id>\` any that were wrong.`);
  notes.push("Application documents in the old applications/ directory were not imported; they stay where they are.");
  return ok(s, notes);
}

function safeArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}
