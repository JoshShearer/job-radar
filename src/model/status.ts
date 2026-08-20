/** Application lifecycle. Every job carries exactly one of these. */
export const STATUSES = [
  "NEW",
  // Set by the machine, not by a person: the board stopped listing this
  // posting. Reversible - it goes back to NEW the moment the posting is seen
  // again. See `planParking` in model/freshness.ts.
  "CLOSED",
  "REVIEWED",
  "SKIPPED",
  "SAVED",
  "APPLY",
  "APPLIED",
  "CONTACTED",
  "SCREEN",
  "INTERVIEW",
  "FINAL",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
  "GHOSTED",
] as const;

export type Status = (typeof STATUSES)[number];

/**
 * Statuses a sweep may move a posting away from automatically.
 *
 * Deliberately tiny. Auto-parking acts on an INFERENCE - the board was swept
 * more recently than this posting was seen on it - and an inference must never
 * overwrite something a person recorded. A job at APPLIED or SCREEN stays
 * exactly where it is even if the posting vanishes from the board, because the
 * posting vanishing is often what happens right after you apply.
 */
export const AUTO_PARKABLE_STATUSES = ["NEW", "REVIEWED"] as const;

export function isAutoParkable(status: string): boolean {
  return (AUTO_PARKABLE_STATUSES as readonly string[]).includes(status);
}

export function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v);
}

/**
 * Statuses that mean "this is live and waiting on someone".
 *
 * These are the roles the search is actually about. They are deliberately not
 * in the daily slate, which only surfaces NEW work, so without a section of
 * their own an application vanishes the moment it is submitted - which reads
 * as the tool losing track of it.
 */
export const IN_FLIGHT_STATUSES = [
  "SAVED",
  "APPLY",
  "APPLIED",
  "CONTACTED",
  "SCREEN",
  "INTERVIEW",
  "FINAL",
  "OFFER",
] as const;

export function isInFlight(status: string): boolean {
  return (IN_FLIGHT_STATUSES as readonly string[]).includes(status);
}

/**
 * Which statuses a lifecycle-advancing command may move a job away from.
 *
 * An explicit allowlist rather than a rank comparison, because a rank cannot
 * express this rule: REVIEWED and APPLY sit at the same position in the order
 * map inside stagesReached, so "strictly greater rank" would refuse the
 * REVIEWED -> APPLY move that `apply` is supposed to make.
 *
 * Everything absent from a list is left exactly where it is. That covers two
 * different cases on purpose:
 *
 *  - Already further along (APPLIED, SCREEN, OFFER...). Preparing a pack for a
 *    job that is already at SCREEN must never drag it back to APPLY.
 *  - Deliberately parked (SKIPPED, REJECTED, WITHDRAWN, GHOSTED). A human said
 *    something about these. A command that prepares or fills does not get to
 *    overrule that quietly; it reports and leaves them alone.
 */
const ADVANCE_FROM = {
  APPLY: ["NEW", "REVIEWED", "SAVED"],
  APPLIED: ["NEW", "REVIEWED", "SAVED", "APPLY"],
} as const satisfies Record<string, readonly Status[]>;

/** The two statuses a command may set on the candidate's behalf. */
export type AdvanceTarget = keyof typeof ADVANCE_FROM;

/**
 * The status to write, or null when the job should be left alone.
 *
 * Deterministic and total: every status in STATUSES has a defined answer for
 * every target, and the answer never depends on anything but the two inputs.
 */
export function advanceStatus(current: Status, target: AdvanceTarget): Status | null {
  return (ADVANCE_FROM[target] as readonly Status[]).includes(current) ? target : null;
}

/**
 * Days after which an in-flight role with no movement is worth a nudge.
 * Applications go quiet by default; the point of tracking is to notice.
 */
export const STALE_AFTER_DAYS: Readonly<Record<string, number>> = {
  SAVED: 3,
  APPLY: 2,
  APPLIED: 10,
  CONTACTED: 7,
  SCREEN: 7,
  INTERVIEW: 7,
  FINAL: 5,
  OFFER: 3,
};

/**
 * Days of silence after which an in-flight role has probably gone nowhere.
 *
 * Only ever used to ASK. Nothing sets GHOSTED automatically: whether an
 * employer stopped replying is a fact about what they did, and inferring it
 * from a clock would put a made-up outcome into the funnel that the funnel then
 * treats as evidence.
 */
export const GHOSTED_AFTER_DAYS = 30;

/** What to do next, given a status and how long it has sat there. */
export function nextAction(status: string, daysInStatus: number): string {
  const stale = daysInStatus >= (STALE_AFTER_DAYS[status] ?? 7);
  switch (status) {
    case "SAVED":
      return stale ? "prepared but never submitted - finish it or skip it" : "pack prepared; submit when ready";
    case "APPLY":
      // `apply` sets this status, so a pack exists on disk. Saying only
      // "marked to apply" would hide that and read as untouched work.
      return stale
        ? "pack prepared and still not submitted - finish it or skip it"
        : "pack prepared; submit when ready";
    case "APPLIED":
      return stale ? "no reply - send the outreach draft or follow up" : "waiting on them";
    case "CONTACTED":
      return stale ? "outreach sent with no reply - one polite follow-up, then move on" : "outreach sent";
    case "SCREEN":
      return stale ? "screen done and no word - ask about next steps" : "screen scheduled or done";
    case "INTERVIEW":
      return stale ? "no update since the interview - ask for a timeline" : "in the loop";
    case "FINAL":
      return stale ? "final round with no decision - ask directly" : "final round";
    case "OFFER":
      return stale ? "offer outstanding - respond before it expires" : "offer on the table";
    default:
      return "";
  }
}

/**
 * Ordered funnel stages. Conversion rates are computed between adjacent
 * entries, so the order here defines the funnel.
 */
export const FUNNEL_STAGES = [
  "DISCOVERED",
  "QUALIFIED",
  "APPLIED",
  "SCREEN",
  "INTERVIEW",
  "FINAL",
  "OFFER",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Which funnel stages a given status implies the job has reached. */
export function stagesReached(status: Status): FunnelStage[] {
  const reached: FunnelStage[] = ["DISCOVERED"];
  const order: Record<Status, number> = {
    NEW: 0,
    // A posting that left the board never got further than DISCOVERED. Giving
    // it QUALIFIED would inflate the funnel with jobs nobody ever acted on.
    CLOSED: 0,
    REVIEWED: 1,
    SKIPPED: 1,
    SAVED: 1,
    APPLY: 1,
    APPLIED: 2,
    CONTACTED: 2,
    SCREEN: 3,
    INTERVIEW: 4,
    FINAL: 5,
    OFFER: 6,
    // Terminal outcomes do not tell us how far the process got on their own;
    // the interview log is the source of truth for those. We credit them at
    // least to APPLIED so the applied count is not silently wrong.
    REJECTED: 2,
    WITHDRAWN: 2,
    GHOSTED: 2,
  };
  const n = order[status];
  if (n >= 1) reached.push("QUALIFIED");
  if (n >= 2) reached.push("APPLIED");
  if (n >= 3) reached.push("SCREEN");
  if (n >= 4) reached.push("INTERVIEW");
  if (n >= 5) reached.push("FINAL");
  if (n >= 6) reached.push("OFFER");
  return reached;
}

/** Interview process stages tracked per company/role. */
export const INTERVIEW_STAGES = [
  "Applied",
  "Recruiter Screen",
  "Hiring Manager",
  "Technical",
  "Take-home",
  "Panel",
  "Final",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Ghosted",
] as const;

export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

export const PRIORITIES = ["A", "B", "C", "D"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  A: "APPLY + HUMAN OUTREACH",
  B: "APPLY",
  C: "NETWORK / WATCH",
  D: "SKIP",
};
