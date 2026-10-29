import type { Clock } from "../kernel/clock.js";
import type { Config } from "../domain/config/schema.js";
import type { Evidence } from "../domain/candidate/evidence.js";
import type { Personal } from "../domain/candidate/personal.js";
import type { Store } from "../ports/store.js";
import type {
  ApplicationBrowser,
  ArtifactStore,
  Mailbox,
  ModelClient,
  ModelProviderStatus,
  PdfRenderer,
  Prompter,
  SourceAdapter,
  Transport,
} from "../ports/io.js";

/**
 * Everything a use case may touch, injected. A use case never reads the wall
 * clock, the filesystem, the network or the environment directly, so every one
 * of them can run end to end against an in-memory database, a fixed clock and
 * fake adapters.
 */
export interface AppContext {
  clock: Clock;
  store: Store;
  config(): Config;
  /** The evidence ledger. Throws when it does not exist. */
  evidence(): Evidence;
  hasEvidence(): boolean;
  personal(): Personal | null;
  transport(): Transport;
  adapters(): SourceAdapter[];
  /** Null when the configured provider may not be called (see modelProvider().reason). */
  modelClient(): ModelClient | null;
  /** The configured model provider, whether it may be called, and why not. */
  modelProvider(): ModelProviderStatus;
  /** Null when no mailbox is configured. */
  mailbox(): Mailbox | null;
  artifacts: ArtifactStore;
  pdf: PdfRenderer;
  browser(): ApplicationBrowser;
  prompter: Prompter;
  /** Human-facing progress lines. The CLI prints them; tests collect them. */
  log(line: string): void;
  paths: { reports: string; backups: string; personal: string; evidence: string; artifacts: string; config: string };
  /** Persist learned answers to personal.yaml; returns the backup path. */
  saveLearnedAnswers(entries: ReadonlyArray<{ match: string; answer: string }>): string | null;
  /** Persist an imported evidence ledger; returns the backup path. */
  saveEvidence(e: Evidence): string | null;
  writeReport(name: string, content: string): string;
}
