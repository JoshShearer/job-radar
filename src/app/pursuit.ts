import type { AppContext } from "./context.js";
import type { ApplicationRecord } from "../ports/records.js";
import {
  foldApplication,
  foldPursuit,
  furthestStage,
  type Actor,
  type ApplicationState,
  type Folded,
  type PursuitState,
  APPLICATION_STATES,
  PURSUIT_STATES,
} from "../domain/pursuit/machines.js";
import { normalizeForIdentity } from "../domain/text/identity.js";
import { shortId } from "../kernel/hash.js";
import { ok, refused, UserError, type UseCaseResult } from "../kernel/result.js";

export function isPursuitState(s: string): s is PursuitState {
  return (PURSUIT_STATES as readonly string[]).includes(s);
}
export function isApplicationState(s: string): s is ApplicationState {
  return (APPLICATION_STATES as readonly string[]).includes(s);
}

/**
 * Resolve what a human typed: an opportunity id, a unique id prefix, or a
 * company name that identifies exactly one candidate. An ambiguous company is
 * NEVER resolved by picking one; the candidates are listed instead.
 */
export function resolveOpportunity(ctx: AppContext, query: string): string {
  const byId = ctx.store.resolveOpportunityId(query);
  if (byId && "id" in byId) return byId.id;
  if (byId && "ambiguous" in byId) throw new UserError(`"${query}" matches several ids: ${byId.ambiguous.join(", ")}`);
  const q = normalizeForIdentity(query);
  if (!q) throw new UserError(`Nothing matches "${query}".`);
  const rows = ctx.store.ranking({}).filter((r) => normalizeForIdentity(r.company).startsWith(q));
  if (rows.length === 1) return rows[0]!.opportunityId;
  if (rows.length === 0) throw new UserError(`Nothing matches "${query}".`);
  // Listed active-first for convenience, but never chosen between: picking
  // "the active one" is still picking.
  const rank = (s: string) => (s === "new" || s === "skipped" ? 1 : 0);
  const pool = [...rows].sort((a, b) => rank(a.pursuitState) - rank(b.pursuitState));
  throw new UserError(
    `"${query}" matches ${pool.length} postings; use an id:\n` +
      pool.slice(0, 10).map((r) => `  ${r.opportunityId}  ${r.company} - ${r.title} [${r.pursuitState}]`).join("\n"),
  );
}

export function pursuitOf(ctx: AppContext, opportunityId: string): Folded<PursuitState> {
  const voids = ctx.store.voids("pursuit_event").map((v) => ({ id: v.id, voids: v.targetId }));
  return foldPursuit(ctx.store.pursuitEvents(opportunityId), voids);
}

export function applicationFold(ctx: AppContext, applicationId: string): Folded<ApplicationState> {
  const voids = ctx.store.voids("application_event").map((v) => ({ id: v.id, voids: v.targetId }));
  return foldApplication(ctx.store.applicationEvents(applicationId), voids);
}

export function transitionPursuit(
  ctx: AppContext,
  runId: number | null,
  opportunityId: string,
  to: PursuitState,
  opts: { note?: string; actor?: Actor; occurredAt?: string } = {},
): UseCaseResult<{ from: PursuitState; to: PursuitState }> {
  if (to === "applied") throw new UserError("Use `jr submitted <id>` to record a submission; it creates the application.");
  const current = pursuitOf(ctx, opportunityId);
  const at = ctx.clock.now().toISOString();
  const occurredAt = opts.occurredAt ?? at;
  const event = { id: Number.MAX_SAFE_INTEGER, to, occurredAt, recordedAt: at, actor: opts.actor ?? "human", note: opts.note ?? null };
  const voids = ctx.store.voids("pursuit_event").map((v) => ({ id: v.id, voids: v.targetId }));
  const trial = foldPursuit([...ctx.store.pursuitEvents(opportunityId), { ...event, opportunityId }], voids);
  const step = trial.steps.find((s) => s.event.id === Number.MAX_SAFE_INTEGER);
  if (!step?.applied) return refused({ from: current.state, to }, [`Not moved: ${step?.reason ?? "invalid transition"}.`]);
  ctx.store.appendPursuitEvent({ opportunityId, to, occurredAt, recordedAt: at, actor: opts.actor ?? "human", note: opts.note ?? null }, runId);
  return ok({ from: current.state, to });
}

/**
 * Record that the HUMAN submitted an application. This is a statement of fact
 * by the candidate; nothing in the system infers it from a page.
 */
export function recordSubmission(
  ctx: AppContext,
  runId: number | null,
  opportunityId: string,
  opts: { submittedAt?: string; note?: string } = {},
): UseCaseResult<{ applicationId: string | null }> {
  const existing = ctx.store.applications(opportunityId);
  if (existing.length) {
    return refused({ applicationId: existing[0]!.id }, [`Already recorded as submitted (application ${existing[0]!.id}).`]);
  }
  const at = ctx.clock.now().toISOString();
  const submittedAt = opts.submittedAt ?? at;
  const app: ApplicationRecord = { id: shortId(`${opportunityId}|${submittedAt}`, 10), opportunityId, submittedAt, recordedAt: at, note: opts.note ?? null };
  ctx.store.createApplication(app, { opportunityId, to: "applied", occurredAt: submittedAt, recordedAt: at, actor: "human", note: opts.note ?? null }, runId);
  return ok({ applicationId: app.id });
}

/** An application by id, or the application on an opportunity named by id/prefix/company. */
export function resolveApplication(ctx: AppContext, query: string): ApplicationRecord {
  const direct = ctx.store.application(query);
  if (direct) return direct;
  const oppId = resolveOpportunity(ctx, query);
  const apps = ctx.store.applications(oppId);
  if (!apps.length) throw new UserError(`No submitted application for ${oppId}. Record one with \`jr submitted ${oppId}\`.`);
  return apps[apps.length - 1]!;
}

export function recordOutcome(
  ctx: AppContext,
  runId: number | null,
  applicationId: string,
  to: ApplicationState,
  opts: { occurredAt?: string; note?: string; actor?: Actor; mailMessageId?: string } = {},
): UseCaseResult<{ from: ApplicationState; to: ApplicationState }> {
  const before = applicationFold(ctx, applicationId);
  const at = ctx.clock.now().toISOString();
  const occurredAt = opts.occurredAt ?? at;
  const probe = { id: Number.MAX_SAFE_INTEGER, applicationId, to, occurredAt, recordedAt: at, actor: opts.actor ?? "human", note: opts.note ?? null, mailMessageId: null };
  const voids = ctx.store.voids("application_event").map((v) => ({ id: v.id, voids: v.targetId }));
  const trial = foldApplication([...ctx.store.applicationEvents(applicationId), probe], voids);
  const step = trial.steps.find((s) => s.event.id === Number.MAX_SAFE_INTEGER);
  if (!step?.applied) return refused({ from: before.state, to }, [`Not recorded: ${step?.reason ?? "invalid transition"}.`]);
  ctx.store.appendApplicationEvent(
    { applicationId, to, occurredAt, recordedAt: at, actor: opts.actor ?? "human", note: opts.note ?? null, mailMessageId: opts.mailMessageId ?? null },
    runId,
  );
  return ok({ from: before.state, to });
}

/** Exclude a mistaken event from every fold. The event itself is kept. */
export function voidEvent(ctx: AppContext, table: "pursuit_event" | "application_event", eventId: number, reason: string): UseCaseResult<{ voided: number }> {
  const exists =
    table === "pursuit_event"
      ? ctx.store.pursuitEvents().some((e) => e.id === eventId)
      : ctx.store.applicationEvents().some((e) => e.id === eventId);
  if (!exists) throw new UserError(`No ${table.replace("_", " ")} with id ${eventId}.`);
  ctx.store.appendVoid({ targetTable: table, targetId: eventId, reason, recordedAt: ctx.clock.now().toISOString() });
  return ok({ voided: eventId });
}

export interface ApplicationView {
  id: string;
  opportunityId: string;
  company: string;
  title: string;
  submittedAt: string;
  state: ApplicationState;
  since: string;
  furthest: ApplicationState;
  lastContactAt: string;
}

export function applicationViews(ctx: AppContext): ApplicationView[] {
  const applications = ctx.store.applications();
  const ranking = new Map(ctx.store.ranking({ opportunityIds: [...new Set(applications.map((a) => a.opportunityId))] }).map((r) => [r.opportunityId, r]));
  const mail = ctx.store.mailMessages({ resolutions: ["applied", "matched", "refused"], limit: 100_000 });
  const lastMail = new Map<string, string>();
  for (const m of mail) {
    if (!m.applicationId) continue;
    const prior = lastMail.get(m.applicationId);
    if (!prior || m.receivedAt > prior) lastMail.set(m.applicationId, m.receivedAt);
  }
  return applications.map((a) => {
    const f = applicationFold(ctx, a.id);
    const r = ranking.get(a.opportunityId);
    const since = f.since ?? a.submittedAt;
    const mailAt = lastMail.get(a.id);
    return {
      id: a.id,
      opportunityId: a.opportunityId,
      company: r?.company ?? "(unknown)",
      title: r?.title ?? "(unknown)",
      submittedAt: a.submittedAt,
      state: f.state,
      since,
      furthest: furthestStage(f),
      lastContactAt: mailAt && mailAt > since ? mailAt : since,
    };
  });
}
