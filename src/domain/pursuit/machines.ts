/**
 * Three things the old single `status` column conflated, kept apart:
 *
 *   posting lifecycle  open/missing/closed - DERIVED from sweeps (catalog)
 *   pursuit            how far the candidate has taken an opportunity
 *   application        what happened after the candidate submitted
 *
 * Pursuit and application state are PURE FOLDS over append-only events,
 * applied in the order things HAPPENED (occurredAt), not the order they were
 * recorded. So an older interview invitation processed after a newer
 * rejection cannot undo it: sorted by time, the rejection comes last.
 *
 * Nothing is ever overwritten. A mistaken event is excluded by a later `void`
 * event that names it, and the fold simply skips it.
 */

export const PURSUIT_STATES = ["new", "reviewed", "shortlisted", "preparing", "skipped", "applied"] as const;
export type PursuitState = (typeof PURSUIT_STATES)[number];

export const APPLICATION_STATES = [
  "submitted",
  "contacted",
  "screen",
  "interview",
  "final",
  "offer",
  "rejected",
  "withdrawn",
  "ghosted",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

export type Actor = "human" | "mail" | "system";

export interface StateEvent<S extends string> {
  id: number;
  to: S;
  occurredAt: string;
  actor: Actor;
  note: string | null;
}

export interface VoidEvent {
  id: number;
  voids: number;
}

export interface FoldStep<S extends string> {
  event: StateEvent<S>;
  applied: boolean;
  /** Why an event was not applied. */
  reason: string | null;
}

export interface Folded<S extends string> {
  state: S;
  since: string | null;
  steps: FoldStep<S>[];
}

function fold<S extends string>(
  initial: S,
  events: readonly StateEvent<S>[],
  voids: readonly VoidEvent[],
  allowed: (from: S, to: S) => string | null,
): Folded<S> {
  const voided = new Set(voids.map((v) => v.voids));
  // By instant, not by string: "2026-09-01 10:00:00" and "...T08:00:00+02:00"
  // do not sort correctly as text. An unparseable time sorts as text, last.
  const when = (t: string) => {
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(t) ? `${t.replace(" ", "T")}Z` : t);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const sorted = [...events].sort((a, b) => when(a.occurredAt) - when(b.occurredAt) || a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id);
  let state = initial;
  let since: string | null = null;
  const steps: FoldStep<S>[] = [];
  for (const e of sorted) {
    if (voided.has(e.id)) {
      steps.push({ event: e, applied: false, reason: "voided" });
      continue;
    }
    if (e.to === state) {
      steps.push({ event: e, applied: false, reason: `already ${state}` });
      continue;
    }
    const refusal = allowed(state, e.to);
    if (refusal) {
      steps.push({ event: e, applied: false, reason: refusal });
      continue;
    }
    state = e.to;
    since = e.occurredAt;
    steps.push({ event: e, applied: true, reason: null });
  }
  return { state, since, steps };
}

/* ------------------------------------------------------------------ pursuit */

const PURSUIT_FROM: Record<PursuitState, readonly PursuitState[]> = {
  new: ["reviewed", "shortlisted", "preparing", "skipped", "applied"],
  reviewed: ["shortlisted", "preparing", "skipped", "applied"],
  shortlisted: ["reviewed", "preparing", "skipped", "applied"],
  preparing: ["shortlisted", "skipped", "applied"],
  skipped: ["reviewed", "shortlisted", "applied"],
  applied: [],
};

export function pursuitTransitionRefusal(from: PursuitState, to: PursuitState): string | null {
  if (PURSUIT_FROM[from].includes(to)) return null;
  if (from === "applied") return "already applied; outcomes are recorded on the application";
  return `${from} -> ${to} is not a pursuit transition`;
}

export function foldPursuit(events: readonly StateEvent<PursuitState>[], voids: readonly VoidEvent[] = []): Folded<PursuitState> {
  return fold<PursuitState>("new", events, voids, pursuitTransitionRefusal);
}

/** The states a machine-initiated preparation may move a pursuit out of. */
export function mayBeginPreparing(state: PursuitState): boolean {
  return state === "new" || state === "reviewed" || state === "shortlisted";
}

/* -------------------------------------------------------------- application */

const PROGRESS: Partial<Record<ApplicationState, number>> = {
  submitted: 1,
  contacted: 2,
  screen: 3,
  interview: 4,
  final: 5,
  offer: 6,
};
const TERMINAL: ReadonlySet<ApplicationState> = new Set(["rejected", "withdrawn"]);

export function applicationTransitionRefusal(from: ApplicationState, to: ApplicationState): string | null {
  if (TERMINAL.has(from)) return `${from} is final`;
  if (to === "submitted") return "an application is only submitted once";
  if (TERMINAL.has(to)) return null;
  if (to === "ghosted") {
    return from === "submitted" || from === "contacted" ? null : `cannot be ghosted from ${from}; there was contact`;
  }
  // A reply after silence revives a ghosted application.
  if (from === "ghosted") return null;
  const a = PROGRESS[from] ?? 0;
  const b = PROGRESS[to] ?? 0;
  // Backwards moves are the same thread repeating its scheduling language.
  return b > a ? null : `${from} is already past ${to}`;
}

export function foldApplication(events: readonly StateEvent<ApplicationState>[], voids: readonly VoidEvent[] = []): Folded<ApplicationState> {
  return fold<ApplicationState>("submitted", events, voids, applicationTransitionRefusal);
}

export function isActiveApplication(s: ApplicationState): boolean {
  return !TERMINAL.has(s) && s !== "offer" && s !== "ghosted";
}

/** The furthest progress stage an application ever reached (for the funnel). */
export function furthestStage(f: Folded<ApplicationState>): ApplicationState {
  let best: ApplicationState = "submitted";
  for (const s of f.steps) {
    if (!s.applied) continue;
    if ((PROGRESS[s.event.to] ?? 0) > (PROGRESS[best] ?? 0)) best = s.event.to;
  }
  return best;
}

export function progressRank(s: ApplicationState): number {
  return PROGRESS[s] ?? 0;
}

/** Days after which an application in this state with no movement deserves a nudge. */
export const NUDGE_AFTER_DAYS: Partial<Record<ApplicationState | PursuitState, number>> = {
  preparing: 3,
  shortlisted: 5,
  submitted: 10,
  contacted: 7,
  screen: 7,
  interview: 7,
  final: 5,
  offer: 3,
};

export function nextAction(state: string, days: number): string {
  const stale = days >= (NUDGE_AFTER_DAYS[state as ApplicationState] ?? 7);
  switch (state) {
    case "shortlisted":
      return stale ? "shortlisted and untouched - prepare it or skip it" : "on the shortlist";
    case "preparing":
      return stale ? "prepared and still not submitted - finish it or skip it" : "materials prepared; submit when ready";
    case "submitted":
      return stale ? "no reply - send the outreach draft or follow up" : "waiting on them";
    case "contacted":
      return stale ? "outreach sent with no reply - one follow-up, then move on" : "outreach sent";
    case "screen":
      return stale ? "screen done and no word - ask about next steps" : "screen scheduled or done";
    case "interview":
      return stale ? "no update since the interview - ask for a timeline" : "in the loop";
    case "final":
      return stale ? "final round with no decision - ask directly" : "final round";
    case "offer":
      return stale ? "offer outstanding - respond before it expires" : "offer on the table";
    default:
      return "";
  }
}
