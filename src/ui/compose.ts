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
import { checkCwd, ClaudeCliClient, nodeRunner, resolveBinary, type Runner } from "../adapters/claude-cli/client.js";
import { GmailMailbox } from "../adapters/mail/gmail.js";
import { EmlMailbox } from "../adapters/mail/eml.js";
import { FsArtifactStore } from "../adapters/fs/artifact-store.js";
import { PlaywrightPdf } from "../adapters/fs/pdf.js";
import { PlaywrightApplicationBrowser } from "../adapters/browser/playwright-filler.js";
import { appendAnswers, saveEvidence, writeFileAtomic } from "../adapters/fs/yaml-writers.js";
import { loadEnvFile, resolvePaths, type Paths } from "../adapters/fs/paths.js";
import { terminalPrompter } from "./prompter.js";
import type { ApplicationBrowser, Mailbox, ModelClient, ModelProviderStatus, Prompter, Transport } from "../ports/io.js";

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
  /** Spawns the claude CLI; tests inject a fake so the real binary never runs. */
  runner?: Runner;
}

/** Why the api provider cannot be called. */
const NO_API_KEY = "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a key.";

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
  const cliCwd = resolve(paths.home, "data", "claude-cli-cwd");
  const cliPromptDir = resolve(paths.home, "data", "claude-cli-prompts");

  /**
   * Provider policy, decided here and nowhere else. claude-cli spends the
   * owner's subscription quota, so it exists only when JR_ALLOW_MODEL=1 (a
   * /run-tickets lane never sets it), and only with an executable binary and
   * a clean working directory: a missing binary must refuse BEFORE the
   * gateway reserves, or every attempt would leave a worst-case receipt.
   */
  const resolveProvider = (): ModelProviderStatus & { binary: string | null; apiKey: string | null } => {
    const m = getConfig().operations.model;
    if (m.provider === "api") {
      const apiKey = (env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY) || null;
      return {
        provider: "api",
        available: apiKey !== null,
        reason: apiKey ? null : NO_API_KEY,
        detail: apiKey ? "api, configured" : "api, no ANTHROPIC_API_KEY (assess/tailor/prepare unavailable)",
        binary: null,
        apiKey,
      };
    }
    const no = (reason: string, binary: string | null = null) => ({
      provider: "claude-cli" as const,
      available: false,
      reason,
      detail: `claude-cli, not allowed: ${reason}`,
      binary,
      apiKey: null,
    });
    if (env.JR_ALLOW_MODEL !== "1") {
      return no("model.provider is claude-cli and JR_ALLOW_MODEL is not 1, so no model call is allowed here. Set JR_ALLOW_MODEL=1 to spend subscription quota.");
    }
    const binary = resolveBinary(m.cli.binary, env.PATH ?? "");
    if (!binary) {
      return no(`model.cli.binary "${m.cli.binary}" was not found or is not executable${m.cli.binary.includes("/") ? "" : " on PATH"}. Set model.cli.binary in operations.yaml to the absolute path of claude.`);
    }
    const cwdProblem = checkCwd(cliCwd) ?? checkCwd(cliPromptDir, false);
    if (cwdProblem) return no(`the claude CLI's working directory is unusable: ${cwdProblem}`, binary);
    return {
      provider: "claude-cli",
      available: true,
      reason: null,
      detail: `claude-cli, allowed (JR_ALLOW_MODEL=1, ${binary}); dollar figures are subscription, list-price equivalent`,
      binary,
      apiKey: null,
    };
  };

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
    modelClient: () => {
      if (o.modelClient !== undefined) return o.modelClient;
      const p = resolveProvider();
      if (!p.available) return null;
      if (p.provider === "api") return AnthropicClient.fromEnv(env);
      const cli = getConfig().operations.model.cli;
      return new ClaudeCliClient({ binary: p.binary!, cwd: cliCwd, promptDir: cliPromptDir, timeoutMs: cli.timeout_ms, baseEnv: env, runner: o.runner ?? nodeRunner });
    },
    modelProvider: () => {
      const { binary: _b, apiKey: _k, ...p } = resolveProvider();
      if (o.modelClient === undefined) return p;
      // An injected client (tests) stands in for the provider's own.
      return o.modelClient
        ? { ...p, available: true, reason: null }
        : { ...p, available: false, reason: p.reason ?? "No model client is configured." };
    },
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
