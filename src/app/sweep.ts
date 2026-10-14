import type { AppContext } from "./context.js";
import type { BoardRef, SourceAdapter } from "../ports/io.js";
import type { PostingWrite } from "../ports/records.js";
import type { Preferences } from "../domain/config/schema.js";
import type { RawPosting } from "../domain/catalog/posting.js";
import { normalizePosting, NORMALIZE_VERSION } from "../domain/catalog/normalize.js";
import { contentKey, dedupeKey, groupKey, resolveBatch } from "../domain/catalog/resolve.js";
import { canonicalJson, hashInput, sha256 } from "../kernel/hash.js";
import { degraded, ok, type UseCaseResult } from "../kernel/result.js";

export interface SweepSummary {
  boardsAttempted: number;
  boardsComplete: number;
  boardsFailed: number;
  postingsSeen: number;
  newOpportunities: number;
  newAliases: number;
  changedPayloads: number;
  failures: Array<{ boardId: string; error: string }>;
}

/** The memo key for a normalized snapshot: payload, normalizer version, and the prefs it reads. */
export function snapshotKey(payloadHash: string, prefs: Preferences): string {
  return hashInput({ payloadHash, v: NORMALIZE_VERSION, location: prefs.location });
}

/**
 * Fetch every configured board. Each board is fetched, normalized, resolved
 * and committed on its own, and its sweep is recorded complete or failed on
 * its own: a failed board leaves every other board's result intact and its own
 * postings untouched (absence is only ever inferred from a COMPLETE sweep).
 */
export async function sweep(ctx: AppContext, runId: number, opts: { providers?: string[] } = {}): Promise<UseCaseResult<SweepSummary>> {
  const config = ctx.config();
  let adapters = ctx.adapters();
  if (opts.providers?.length) {
    const want = new Set(opts.providers.map((p) => p.toLowerCase()));
    adapters = adapters.filter((a) => want.has(a.provider));
  }
  const summary: SweepSummary = {
    boardsAttempted: 0,
    boardsComplete: 0,
    boardsFailed: 0,
    postingsSeen: 0,
    newOpportunities: 0,
    newAliases: 0,
    changedPayloads: 0,
    failures: [],
  };
  if (adapters.length === 0) {
    return { outcome: "failed", value: summary, notes: ["No sources are enabled. Check config/sources.yaml."] };
  }

  const transport = ctx.transport();
  // Providers in parallel (different hosts); boards within a provider in
  // sequence. The transport rate-limits per host either way.
  await Promise.all(adapters.map((a) => sweepProvider(ctx, runId, a, transport, config.preferences, summary)));

  if (summary.boardsComplete === 0) {
    return { outcome: "failed", value: summary, notes: ["Every board failed; nothing was refreshed."] };
  }
  if (summary.boardsFailed > 0) {
    return degraded(summary, [`${summary.boardsFailed} of ${summary.boardsAttempted} boards failed; their postings were left as they were.`]);
  }
  return ok(summary);
}

async function sweepProvider(
  ctx: AppContext,
  runId: number,
  adapter: SourceAdapter,
  transport: ReturnType<AppContext["transport"]>,
  prefs: Preferences,
  summary: SweepSummary,
): Promise<void> {
  for (const board of adapter.boards()) {
    summary.boardsAttempted++;
    const sweepId = ctx.store.beginSweep(runId, board.boardId, board.provider, ctx.clock.now().toISOString());
    try {
      const raws = await adapter.fetchBoard(board, transport);
      const result = recordBoard(ctx, sweepId, board, raws, prefs);
      ctx.store.finishSweep(sweepId, "complete", raws.length, null, ctx.clock.now().toISOString());
      summary.boardsComplete++;
      summary.postingsSeen += raws.length;
      summary.newOpportunities += result.newOpportunities;
      summary.newAliases += result.newAliases;
      summary.changedPayloads += result.changedPayloads;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      ctx.store.finishSweep(sweepId, "failed", 0, message.slice(0, 500), ctx.clock.now().toISOString());
      summary.boardsFailed++;
      summary.failures.push({ boardId: board.boardId, error: message });
      ctx.log(`  ${board.boardId} failed: ${message}`);
    }
  }
}

export function recordBoard(ctx: AppContext, sweepId: number, board: BoardRef, raws: readonly RawPosting[], prefs: Preferences) {
  const prepared = raws.map((raw) => {
    const payloadJson = canonicalJson(raw);
    const payloadHash = sha256(payloadJson);
    return { raw, payloadJson, payloadHash, snapshot: normalizePosting(raw, prefs) };
  });
  const resolved = resolveBatch(
    prepared.map((p) => p.snapshot),
    ctx.store.resolutionIndex(),
  );
  const writes: PostingWrite[] = prepared.map((p, i) => {
    const r = resolved[i]!;
    return {
      boardId: board.boardId,
      externalId: p.raw.externalId,
      provider: board.provider,
      url: p.raw.sourceUrl,
      payloadHash: p.payloadHash,
      payloadJson: p.payloadJson,
      opportunityId: r.opportunityId,
      resolvedHow: r.how,
      snapshot: p.snapshot,
      snapshotKey: snapshotKey(p.payloadHash, prefs),
      keys: { dedupe: dedupeKey(p.snapshot), content: contentKey(p.snapshot), group: groupKey(p.snapshot) },
    };
  });
  return ctx.store.recordPostings(sweepId, ctx.clock.now().toISOString(), writes);
}
