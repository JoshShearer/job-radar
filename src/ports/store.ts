/**
 * The persistence port. The application layer depends on this interface
 * only; `adapters/sqlite/store.ts` implements it.
 *
 * GENERATED from the implementation's declarations by `npm run gen:port`, so
 * the two cannot drift; `implements Store` makes the compiler hold them
 * together. Edit the implementation, then regenerate.
 */
import type { ResolutionIndex } from "../domain/catalog/resolve.js";
import type { BoardCoverage } from "../domain/catalog/lifecycle.js";
import type { Committed } from "../domain/budget/budget.js";
import type { Outcome } from "../kernel/result.js";
import type { AliasRecord, ApplicationEventRecord, ApplicationRecord, ArtifactRecord, InterviewRecord, MailMessageRecord, MailScanRecord, ModelCallRecord, ModelCallReservation, ModelCallSettlement, PostingWrite, PostingWriteResult, PursuitEventRecord, RankingCounts, RankingFilter, RankingRecord, RunRecord, SweepRecord, VoidRecord } from "./records.js";

export interface Store {
    close(): void;
    startRun(command: string, at: string): number;
    finishRun(id: number, outcome: Outcome, result: unknown, error: string | null, at: string): void;
    recentRuns(sinceIso: string, limit?: number): RunRecord[];
    lastRun(command: string, outcomes: readonly string[]): RunRecord | null;
    recordConfigVersion(kind: string, hash: string, body: unknown, at: string): void;
    beginSweep(runId: number | null, boardId: string, provider: string, at: string): number;
    finishSweep(id: number, status: "complete" | "failed", jobCount: number, error: string | null, at: string): void;
    /** Latest complete sweep per board, with the start of the one before it. */
    boardCoverage(): BoardCoverage[];
    latestSweeps(limit?: number): SweepRecord[];
    lastCompleteSweepAt(): string | null;
    resolutionIndex(): ResolutionIndex;
    /**
     * Record one sweep's postings. One transaction: payload blob, a new posting
     * version when the payload changed, the alias, and the opportunity.
     */
    recordPostings(sweepId: number | null, at: string, items: readonly PostingWrite[]): PostingWriteResult;
    allAliases(): AliasRecord[];
    aliasesFor(opportunityId: string): AliasRecord[];
    blob(hash: string): string | null;
    saveSnapshotMemos(memos: ReadonlyArray<{
        boardId: string;
        externalId: string;
        key: string;
        json: string;
    }>): void;
    postingVersions(boardId: string, externalId: string): Array<{
        payloadHash: string;
        observedAt: string;
    }>;
    opportunityExists(id: string): boolean;
    /** Exact id, or a unique id prefix. */
    resolveOpportunityId(idOrPrefix: string): {
        id: string;
    } | {
        ambiguous: string[];
    } | null;
    appendPursuitEvent(e: Omit<PursuitEventRecord, "id">, runId: number | null): number;
    pursuitEvents(opportunityId?: string): PursuitEventRecord[];
    /** An application and the pursuit event that records it, together. */
    createApplication(app: ApplicationRecord, pursuit: Omit<PursuitEventRecord, "id">, runId: number | null): void;
    applications(opportunityId?: string): ApplicationRecord[];
    application(id: string): ApplicationRecord | null;
    appendApplicationEvent(e: Omit<ApplicationEventRecord, "id">, runId: number | null): number;
    applicationEvents(applicationId?: string): ApplicationEventRecord[];
    appendVoid(v: Omit<VoidRecord, "id">): number;
    voids(targetTable: VoidRecord["targetTable"]): VoidRecord[];
    recordOverride(opportunityId: string, gate: string, detail: string, at: string, runId: number | null): void;
    overrides(opportunityId: string): Array<{
        gate: string;
        detail: string | null;
        recordedAt: string;
    }>;
    /**
     * Reserve, atomically with the budget check: the committed totals are read
     * and the reservation is written in one IMMEDIATE transaction, so two
     * processes cannot both fit under the same ceiling.
     */
    reserveModelCall(r: ModelCallReservation, windows: {
        dayStart: string;
        monthStart: string;
    }, check: (committed: Committed) => string | null): {
        id: number;
    } | {
        refused: string;
    };
    settleModelCall(s: ModelCallSettlement): void;
    /**
     * Settled cost where known; the reserved worst case where the call never
     * settled or settled without a usage receipt. Unknown is never zero.
     */
    committedSpend(runId: number | null, windows: {
        dayStart: string;
        monthStart: string;
    }): Committed;
    modelCalls(opts?: {
        sinceIso?: string;
        runId?: number;
        subjectId?: string;
    }): ModelCallRecord[];
    getDerivation(kind: string, inputKey: string): {
        output: unknown;
        createdAt: string;
    } | null;
    putDerivation(kind: string, inputKey: string, output: unknown, modelCallId: number | null, at: string): void;
    useDerivation(kind: string, subjectId: string, inputKey: string, at: string): void;
    /** Every input key this subject has ever had a derivation of this kind for. */
    derivationUses(kind: string, subjectId: string): Array<{
        inputKey: string;
        at: string;
    }>;
    subjectsWithDerivation(kind: string): Set<string>;
    recordAssessmentFailure(opportunityId: string, inputKey: string, kind: string, counts: boolean, reason: string, at: string): void;
    countedFailures(inputKey: string): number;
    recentFailures(limit?: number): Array<{
        opportunityId: string;
        kind: string;
        reason: string;
        counts: boolean;
        at: string;
    }>;
    recordArtifact(a: Omit<ArtifactRecord, "approvedAt">, runId: number | null): void;
    artifacts(opportunityId: string, kind?: ArtifactRecord["kind"]): ArtifactRecord[];
    approveArtifact(artifactId: string, at: string, note: string | null): void;
    beginMailScan(runId: number | null, mailbox: string, query: string, from: string, to: string, at: string): number;
    finishMailScan(id: number, status: "complete" | "partial" | "failed", pages: number, messages: number, error: string | null, at: string): void;
    mailScans(mailbox?: string): MailScanRecord[];
    mailSeen(messageId: string): boolean;
    /**
     * A message, and the application event it caused if any, in one
     * transaction: an outcome is never recorded without the mail that explains
     * it, nor the mail marked applied without the outcome.
     */
    recordMail(m: MailMessageRecord, event: Omit<ApplicationEventRecord, "id"> | null, runId: number | null): void;
    mailMessages(opts?: {
        resolutions?: readonly string[];
        applicationId?: string;
        limit?: number;
    }): MailMessageRecord[];
    /** Replace the read model whole, in one transaction, with its evaluation record. */
    replaceRanking(rows: readonly RankingRecord[], evaluation: {
        runId: number | null;
        at: string;
        policyVersion: string;
        calibration: unknown;
        summary: unknown;
    }): void;
    ranking(f?: RankingFilter): RankingRecord[];
    /** How many rows `ranking(f)` would return without `limit` and `offset`. */
    rankingCount(f?: RankingFilter): number;
    /**
     * One page of `ranking(f)` and the total it is a page of, read in one
     * transaction so an evaluate replacing the table between the two reads
     * cannot make the total disagree with the rows (WAL gives the transaction
     * a single snapshot).
     */
    rankingPage(f?: RankingFilter): {
        rows: RankingRecord[];
        total: number;
    };
    rankingCounts(): RankingCounts;
    rankingFor(opportunityId: string): RankingRecord | null;
    lastEvaluation(): {
        at: string;
        policyVersion: string;
        calibration: unknown;
        summary: unknown;
    } | null;
    addInterview(i: Omit<InterviewRecord, "id">): number;
    interviews(company?: string): InterviewRecord[];
    /** A historical, already-settled paid call (legacy import). */
    importModelCall(c: Omit<ModelCallRecord, "id">): void;
    importRun(r: Omit<RunRecord, "id">): number;
    /** Run `fn` in one transaction (used by bulk import). */
    transaction<T>(fn: () => T): T;
}
