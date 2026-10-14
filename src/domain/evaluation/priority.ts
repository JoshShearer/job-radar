import type { EvaluationPolicy } from "../config/schema.js";

export const PRIORITIES = ["A", "B", "C", "D"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  A: "APPLY + HUMAN OUTREACH",
  B: "APPLY",
  C: "NETWORK / WATCH",
  D: "SKIP",
};

/**
 * The one priority policy. Every deterministic path uses it; thresholds come
 * from config. `ceiling` expresses the invariant that a statistical projection
 * may never reach A: "apply and reach out today" rests on an actual analysis.
 */
export function assignPriority(
  args: { fit: number; roi: number; comboCount: number; eligible: boolean; ceiling?: Priority },
  policy: EvaluationPolicy["priority"],
): Priority {
  if (!args.eligible) return "D";
  let p: Priority = "D";
  const a = policy.A;
  if (args.fit >= a.min_fit && args.roi >= a.min_roi && (args.comboCount > 0 || args.fit >= policy.a_without_combo_min_fit)) p = "A";
  else if (args.fit >= policy.B.min_fit && args.roi >= policy.B.min_roi) p = "B";
  else if (args.fit >= policy.C.min_fit) p = "C";
  if (args.ceiling && PRIORITIES.indexOf(p) < PRIORITIES.indexOf(args.ceiling)) p = args.ceiling;
  return p;
}

export function priorityForRecommendation(rec: string): Priority {
  switch (rec) {
    case "apply_and_outreach":
      return "A";
    case "apply":
      return "B";
    case "network_or_watch":
      return "C";
    default:
      return "D";
  }
}
