import { DAY_MS } from "../../kernel/clock.js";

/**
 * Is a posting still listed? DERIVED from sweep coverage, never stored as a
 * status, and never inferred from a board that failed.
 *
 *   open     listed by its board's latest complete sweep
 *   missing  not listed by the latest complete sweep, not yet for long
 *   closed   unlisted across complete sweeps for at least `parkAfterDays`
 *   unknown  no complete sweep of its board, or the board's absences were
 *            implausible (a truncated response looks like a mass closure)
 *
 * An opportunity is open if ANY of its aliases is open. Reopening needs no
 * code: the next sweep that lists it makes it open again.
 */
export type PostingState = "open" | "missing" | "closed" | "unknown";

export interface AliasSighting {
  opportunityId: string;
  boardId: string;
  lastSeen: string;
}

export interface BoardCoverage {
  boardId: string;
  /** Latest sweep of this board that completed successfully. */
  startedAt: string;
  finishedAt: string;
  /** Start of the complete sweep before that one, if any. */
  previousStartedAt: string | null;
}

export interface LifecyclePolicy {
  parkAfterDays: number;
  maxFractionPerBoard: number;
}

export interface LifecycleResult {
  states: Map<string, PostingState>;
  /** Boards whose absences were refused as implausible. Reported, never silent. */
  refusedBoards: Array<{ boardId: string; wouldClose: number; total: number }>;
}

const RANK: Record<PostingState, number> = { open: 3, unknown: 2, missing: 1, closed: 0 };

export function deriveLifecycle(
  sightings: readonly AliasSighting[],
  coverage: readonly BoardCoverage[],
  policy: LifecyclePolicy,
): LifecycleResult {
  const byBoard = new Map(coverage.map((c) => [c.boardId, c]));
  const perAlias: Array<{ s: AliasSighting; state: PostingState }> = [];
  // The guard compares against what the PREVIOUS complete sweep listed, so
  // postings closed long ago never dilute or inflate it.
  const vanishing = new Map<string, { listedBefore: number; vanished: number }>();

  for (const s of sightings) {
    const cov = byBoard.get(s.boardId);
    let state: PostingState;
    if (!cov) state = "unknown";
    else if (s.lastSeen >= cov.startedAt) state = "open";
    else {
      const gone = Date.parse(cov.finishedAt) - Date.parse(s.lastSeen);
      state = gone > policy.parkAfterDays * DAY_MS ? "closed" : "missing";
    }
    perAlias.push({ s, state });
    if (cov?.previousStartedAt && s.lastSeen >= cov.previousStartedAt) {
      const v = vanishing.get(s.boardId) ?? { listedBefore: 0, vanished: 0 };
      v.listedBefore++;
      if (state !== "open") v.vanished++;
      vanishing.set(s.boardId, v);
    }
  }

  const refused = new Set<string>();
  const refusedBoards: LifecycleResult["refusedBoards"] = [];
  for (const [boardId, v] of vanishing) {
    if (v.listedBefore > 1 && v.vanished / v.listedBefore > policy.maxFractionPerBoard) {
      refused.add(boardId);
      refusedBoards.push({ boardId, wouldClose: v.vanished, total: v.listedBefore });
    }
  }

  const states = new Map<string, PostingState>();
  for (const { s, state } of perAlias) {
    const effective: PostingState = refused.has(s.boardId) && state !== "open" ? "unknown" : state;
    const prior = states.get(s.opportunityId);
    if (!prior || RANK[effective] > RANK[prior]) states.set(s.opportunityId, effective);
  }
  return { states, refusedBoards };
}
