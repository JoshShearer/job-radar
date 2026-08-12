/** Application lifecycle. Every job carries exactly one of these. */
export const STATUSES = [
  "NEW",
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

export function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v);
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
