import type { RawPosting } from "../domain/catalog/posting.js";
import type { Personal } from "../domain/candidate/personal.js";
import type { Evidence } from "../domain/candidate/evidence.js";

/** HTTP for public job-board endpoints. Implementations must rate-limit per host. */
export interface Transport {
  getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
  /** Probe without retries, for health checks and discovery. */
  status(url: string): Promise<number>;
}

/** One employer board on one provider. */
export interface BoardRef {
  provider: string;
  boardId: string;
  token: string | null;
  company: string;
}

/**
 * A source adapter fetches ONE board and maps its payload. It classifies
 * nothing and throws on failure; the sweep use case records the failure
 * against that board alone.
 */
export interface SourceAdapter {
  readonly provider: string;
  boards(): BoardRef[];
  fetchBoard(board: BoardRef, transport: Transport): Promise<RawPosting[]>;
  endpoint(board: BoardRef): string;
}

/** The raw paid-model API. The gateway (app layer) owns budgets, receipts and validation. */
export interface ModelRequest {
  model: string;
  effort: string;
  maxOutputTokens: number;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
}

export interface ModelClient {
  create(req: ModelRequest): Promise<unknown>;
}

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

/** Read-only. There is no method that sends, labels, archives or deletes. */
export interface Mailbox {
  readonly name: string;
  readonly query: string;
  page(args: { after: string; before: string; pageToken: string | null; pageSize: number }): Promise<{ messages: Email[]; nextPageToken: string | null }>;
}

/** HTML to PDF bytes. Bytes, not a path, so a PDF can only land inside a published generation. */
export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

/**
 * Immutable, content-addressed document generations. Files are written to a
 * temporary directory and moved into place in one rename, so a reader sees a
 * whole generation or none of it.
 */
export interface ArtifactStore {
  publish(opportunityId: string, generationId: string, files: Record<string, string | Uint8Array>): {
    dir: string;
    files: Record<string, { sha256: string; bytes: number }>;
  };
  path(dir: string, file: string): string;
  read(dir: string, file: string): string | null;
}

export interface FillInput {
  url: string;
  company: string;
  title: string;
  personal: Personal;
  evidence: Evidence | null;
  answers: Array<{ question: string; answer: string }>;
  resumePath: string | null;
  coverLetterPath: string | null;
  screenshotDir: string;
  headless: boolean;
}

export interface FieldOutcome {
  label: string;
  intent: string;
  status: "filled" | "needs_you" | "left_alone" | "failed";
  value?: string;
  why: string;
  options?: string[];
}

export interface FillSession {
  outcomes: FieldOutcome[];
  stoppedFor: string | null;
  notes: string[];
  screenshot: string | null;
  /** Resolves when the human closes the window; yields the last field snapshot. */
  waitForClose(): Promise<{ interrupted: boolean; snapshot: Array<{ label: string; intent: string; kind: string; value: string }> }>;
  close(): Promise<void>;
}

/** Drives an ordinary, undisguised browser. Never submits. */
export interface ApplicationBrowser {
  fill(input: FillInput): Promise<FillSession>;
}

/** Ask the human a yes/no question. Absent terminal means "no". */
export interface Prompter {
  confirm(question: string): Promise<boolean>;
}
