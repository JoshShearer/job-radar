import type { PostingSnapshot } from "../domain/catalog/posting.js";
import type { ResolvedHow } from "../domain/catalog/resolve.js";
import type { Actor, ApplicationState, PursuitState } from "../domain/pursuit/machines.js";
import type { TokenUsage } from "../domain/budget/pricing.js";
import type { ModelProviderName } from "./io.js";
import type { Outcome } from "../kernel/result.js";
import type { Priority } from "../domain/evaluation/priority.js";
import type { PostingState } from "../domain/catalog/lifecycle.js";

/** Plain records crossing the store boundary. No behavior. */

export interface AliasRecord {
  boardId: string;
  externalId: string;
  opportunityId: string;
  provider: string;
  url: string;
  firstSeen: string;
  lastSeen: string;
  payloadHash: string;
  resolvedHow: string;
  snapshotKey: string | null;
  snapshotJson: string | null;
}

export interface PostingWrite {
  boardId: string;
  externalId: string;
  provider: string;
  url: string;
  payloadHash: string;
  payloadJson: string;
  opportunityId: string;
  resolvedHow: ResolvedHow;
  snapshot: PostingSnapshot;
  snapshotKey: string;
  keys: { dedupe: string; content: string | null; group: string };
  /** Historical sighting times (legacy import). Default: the write time. */
  firstSeen?: string;
  lastSeen?: string;
}

export interface PostingWriteResult {
  newOpportunities: number;
  newAliases: number;
  changedPayloads: number;
}

export interface PursuitEventRecord {
  id: number;
  opportunityId: string;
  to: PursuitState;
  occurredAt: string;
  recordedAt: string;
  actor: Actor;
  note: string | null;
}

export interface ApplicationRecord {
  id: string;
  opportunityId: string;
  submittedAt: string;
  recordedAt: string;
  note: string | null;
}

export interface ApplicationEventRecord {
  id: number;
  applicationId: string;
  to: ApplicationState;
  occurredAt: string;
  recordedAt: string;
  actor: Actor;
  note: string | null;
  mailMessageId: string | null;
}

export interface VoidRecord {
  id: number;
  targetTable: "pursuit_event" | "application_event";
  targetId: number;
  reason: string;
  recordedAt: string;
}

export interface ModelCallReservation {
  runId: number | null;
  purpose: string;
  subjectId: string | null;
  requestKey: string;
  model: string;
  effort: string;
  reservedUsd: number;
  at: string;
  /** Written once at reservation. Rows from before provider tracking read as "api". */
  provider: ModelProviderName;
}

export type CallOutcome = "success" | "refusal" | "truncated" | "invalid_json" | "schema" | "api_error";

export interface ModelCallSettlement {
  id: number;
  outcome: CallOutcome;
  usageKnown: boolean;
  usage: TokenUsage;
  actualUsd: number;
  error: string | null;
  at: string;
}

export interface ModelCallRecord extends ModelCallReservation {
  id: number;
  status: "reserved" | "settled";
  outcome: CallOutcome | null;
  usageKnown: boolean | null;
  usage: TokenUsage;
  actualUsd: number | null;
  error: string | null;
  settledAt: string | null;
}

export interface RankingRecord {
  opportunityId: string;
  company: string;
  title: string;
  location: string;
  remoteStatus: string;
  datePosted: string | null;
  lane: string;
  eligible: boolean;
  evergreen: boolean;
  postingState: PostingState;
  pursuitState: PursuitState;
  rawFit: number;
  rawRoi: number;
  rawPriority: Priority;
  projFit: number | null;
  projRoi: number | null;
  analystFit: number | null;
  analystRoi: number | null;
  analystRec: string | null;
  analystTier: string | null;
  staleAssessment: boolean;
  fit: number;
  roi: number;
  priority: Priority;
  confidence: "analyzed" | "projected" | "raw";
  compBand: string;
  detail: RankingDetail;
  evaluatedAt: string;
}

export interface RankingDetail {
  explanation: string;
  reasons: string[];
  warnings: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  combos: string[];
  compensationNote: string;
  salary: string;
  url: string;
  applicationUrl: string | null;
  aliases: number;
  /** The analyst's own summary, when an assessment is current. */
  analystSummary: string | null;
  /** The keyword engine's lane, kept even when the analyst's lane replaces it. */
  rawLane: string;
  /** The alias whose snapshot was judged (an opportunity can be posted in several places). */
  variant: { boardId: string; externalId: string };
}

export interface ArtifactRecord {
  id: string;
  opportunityId: string;
  kind: "resume" | "pack";
  planKey: string;
  postingMaterial: string;
  evidenceVersion: string;
  dir: string;
  manifest: ArtifactManifest;
  createdAt: string;
  approvedAt: string | null;
}

export interface ArtifactManifest {
  files: Record<string, { sha256: string; bytes: number }>;
  /** Which file is the attachable document, if any. */
  attachment: string | null;
  /** Cover letter for a pack, when one was produced. */
  coverLetter: string | null;
  /** Usable form answers (pack only), already verified. */
  answers: Array<{ question: string; answer: string }>;
  repairs: number;
  rejectedSentences: number;
}

export interface MailScanRecord {
  id: number;
  mailbox: string;
  query: string;
  rangeFrom: string;
  rangeTo: string;
  status: "running" | "complete" | "partial" | "failed";
  pages: number;
  messages: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface MailMessageRecord {
  messageId: string;
  mailbox: string;
  receivedAt: string;
  from: string;
  subject: string;
  kinds: string[];
  evidence: string[];
  resolution: "applied" | "refused" | "matched" | "ambiguous" | "unmatched" | "ignored";
  applicationId: string | null;
  note: string | null;
  observedAt: string;
}

export interface RunRecord {
  id: number;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: Outcome | "running";
  result: unknown;
  error: string | null;
}

export interface SweepRecord {
  id: number;
  boardId: string;
  provider: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "complete" | "failed";
  jobCount: number;
  error: string | null;
}

export interface InterviewRecord {
  id: number;
  applicationId: string | null;
  company: string;
  role: string;
  stage: string;
  occurredOn: string;
  questions: string[];
  topics: string[];
  selfRating: number | null;
  compDiscussed: boolean;
  notes: string | null;
  recordedAt: string;
}

export interface RankingFilter {
  opportunityId?: string;
  /** Only these opportunities. An empty list matches nothing. */
  opportunityIds?: readonly string[];
  eligible?: boolean;
  /** false excludes evergreen postings. */
  includeEvergreen?: boolean;
  pursuitStates?: readonly string[];
  postingStates?: readonly string[];
  priorities?: readonly string[];
  lane?: string;
  minFit?: number;
  /** Case-insensitive substring of the company or the title. */
  text?: string;
  limit?: number;
  offset?: number;
}

/** Counts over the whole ranking, without reading any row's detail. */
export interface RankingCounts {
  opportunities: number;
  eligible: number;
  assessed: number;
  open: number;
  closed: number;
}
