import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AppContext } from "../app/context.js";
import type { Config } from "../domain/config/schema.js";
import type { Evidence } from "../domain/candidate/evidence.js";
import type { Personal } from "../domain/candidate/personal.js";
import type { Clock } from "../kernel/clock.js";
import { systemClock } from "../kernel/clock.js";
import { openDatabase, type DB } from "../adapters/sqlite/db.js";
import { SqliteStore } from "../adapters/sqlite/store.js";
import { evidenceExists, loadConfig, loadEvidence, loadPersonal } from "../adapters/fs/config-loader.js";
import { existsSync } from "node:fs";
import { PoliteTransport } from "../adapters/http/polite-transport.js";
import { buildAdapters } from "../adapters/ats/registry.js";
import { AnthropicClient } from "../adapters/anthropic/client.js";
import { GmailMailbox } from "../adapters/mail/gmail.js";
import { EmlMailbox } from "../adapters/mail/eml.js";
import { FsArtifactStore } from "../adapters/fs/artifact-store.js";
import { PlaywrightPdf } from "../adapters/fs/pdf.js";
import { PlaywrightApplicationBrowser } from "../adapters/browser/playwright-filler.js";
import { appendAnswers, saveEvidence, writeFileAtomic } from "../adapters/fs/yaml-writers.js";
import { loadEnvFile, resolvePaths, type Paths } from "../adapters/fs/paths.js";
import { terminalPrompter } from "./prompter.js";
import type { ApplicationBrowser, Mailbox, ModelClient, Prompter, Transport } from "../ports/io.js";

export interface Runtime {
  ctx: AppContext;
  db: DB;
  paths: Paths;
  close(): void;
}

export interface ComposeOverrides {
  clock?: Clock;
  transport?: Transport;
  modelClient?: ModelClient | null;
  mailbox?: Mailbox | null;
  browser?: ApplicationBrowser;
  prompter?: Prompter;
  log?: (line: string) => void;
  pdf?: AppContext["pdf"];
}

/** The composition root: the one place real adapters are wired to the app. */
export function compose(env: NodeJS.ProcessEnv = process.env, o: ComposeOverrides = {}): Runtime {
  const paths = resolvePaths(env);
  loadEnvFile(resolve(paths.home, ".env"));
  const clock = o.clock ?? systemClock;
  const db = openDatabase(paths.db, () => clock.now().toISOString());
  const store = new SqliteStore(db);
  let config: Config | null = null;
  let evidence: Evidence | null = null;
  const getConfig = () => (config ??= loadConfig(paths.config));

  const ctx: AppContext = {
    clock,
    store,
    config: getConfig,
    evidence: () => (evidence ??= loadEvidence(paths.evidence)),
    hasEvidence: () => evidenceExists(paths.evidence),
    personal: (): Personal | null => (existsSync(paths.personal) ? loadPersonal(paths.personal) : null),
    transport: () => {
      if (o.transport) return o.transport;
      const h = getConfig().operations.http;
      const contact = env.JOB_RADAR_CONTACT?.trim();
      return new PoliteTransport({
        delayMs: h.delay_ms,
        timeoutMs: h.timeout_ms,
        maxRetries: h.max_retries,
        maxRetryAfterMs: h.max_retry_after_ms,
        userAgent: contact ? `${h.user_agent} contact:${contact}` : h.user_agent,
      });
    },
    adapters: () => buildAdapters(getConfig().sources),
    modelClient: () => (o.modelClient !== undefined ? o.modelClient : AnthropicClient.fromEnv()),
    mailbox: () => {
      if (o.mailbox !== undefined) return o.mailbox;
      const mail = getConfig().operations.mail;
      const gmail = GmailMailbox.fromEnv(mail.gmail_query);
      if (gmail) return gmail;
      if (mail.eml_dir) return new EmlMailbox(isAbsolute(mail.eml_dir) ? mail.eml_dir : resolve(paths.home, mail.eml_dir));
      return null;
    },
    artifacts: new FsArtifactStore(paths.artifacts),
    pdf: o.pdf ?? new PlaywrightPdf(),
    browser: () => o.browser ?? new PlaywrightApplicationBrowser(paths.browserProfile),
    prompter: o.prompter ?? terminalPrompter,
    log: o.log ?? ((line) => process.stderr.write(`${line}\n`)),
    paths: {
      reports: paths.reports,
      backups: paths.backups,
      personal: paths.personal,
      evidence: paths.evidence,
      artifacts: paths.artifacts,
      config: paths.config,
    },
    saveLearnedAnswers: (entries) => appendAnswers(paths.personal, entries, clock.now().toISOString()),
    saveEvidence: (e) => {
      evidence = null;
      return saveEvidence(paths.evidence, e, clock.now().toISOString());
    },
    writeReport: (name, content) => {
      mkdirSync(paths.reports, { recursive: true });
      const file = resolve(paths.reports, name);
      writeFileAtomic(file, content);
      return file;
    },
  };
  return { ctx, db, paths, close: () => db.close() };
}
