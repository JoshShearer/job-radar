import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppContext } from "../../src/app/context.js";
import type { Config } from "../../src/domain/config/schema.js";
import { EvidenceSchema, type Evidence } from "../../src/domain/candidate/evidence.js";
import { PersonalSchema, type Personal } from "../../src/domain/candidate/personal.js";
import { FixedClock } from "../../src/kernel/clock.js";
import { openDatabase } from "../../src/adapters/sqlite/db.js";
import { SqliteStore } from "../../src/adapters/sqlite/store.js";
import { loadConfig } from "../../src/adapters/fs/config-loader.js";
import { FsArtifactStore } from "../../src/adapters/fs/artifact-store.js";
import { buildAdapters } from "../../src/adapters/ats/registry.js";
import type { ApplicationBrowser, Email, FillInput, Mailbox, ModelClient, ModelRequest, Transport } from "../../src/ports/io.js";

export const EXAMPLE_CONFIG = resolve(import.meta.dirname, "..", "..", "config.example");

/** A small ledger: two roles, distinct claims, verified and not. */
export const TEST_EVIDENCE: Evidence = EvidenceSchema.parse({
  basics: {
    name: "Pat Example",
    location: "Austin, TX",
    headlines: [
      { id: "h-full", text: "Senior full-stack engineer (TypeScript, React, Next.js)" },
      { id: "h-seo", text: "Senior engineer for technical SEO and growth" },
    ],
    summaries: [{ id: "s-main", text: "Builds and operates production web platforms end to end." }],
  },
  skills: [
    { name: "TypeScript", aliases: ["TS"] },
    { name: "React" },
    { name: "Next.js", aliases: ["NextJS"] },
    { name: "Node.js", aliases: ["Node"] },
    { name: "SEO" },
    { name: "PostgreSQL", aliases: ["Postgres"] },
  ],
  experience: [
    {
      id: "acme",
      company: "Acme Marketplace",
      title: "Founder and Engineer",
      start: "2020-01",
      end: null,
      claims: [
        { id: "acme-1", text: "Built a production Next.js marketplace with Payload CMS", skills: ["Next.js", "React", "TypeScript"] },
        { id: "acme-2", text: "Designed and ran 200+ measured SEO experiments", skills: ["SEO"] },
        { id: "acme-3", text: "Contributed to the checkout flow", skills: ["TypeScript"] },
        { id: "acme-4", text: "Led a team of four engineers through a platform migration", skills: ["Node.js"], verified: false },
      ],
    },
    {
      id: "globex",
      company: "Globex",
      title: "Software Engineer",
      start: "2016-03",
      end: "2019-12",
      claims: [{ id: "globex-1", text: "Maintained PostgreSQL-backed reporting services in Node.js", skills: ["PostgreSQL", "Node.js"] }],
    },
  ],
  education: [{ id: "edu-1", school: "State University", credential: "BS Electrical Engineering", year: "2015" }],
});

export const TEST_PERSONAL: Personal = PersonalSchema.parse({
  identity: { first_name: "Pat", last_name: "Example", email: "pat@example.com", city: "Austin", state: "Texas" },
  work_eligibility: { authorized_to_work_us: true, requires_sponsorship: null },
});

/* ------------------------------------------------------------------ fakes */

export interface Routes {
  [url: string]: unknown | Error | (() => unknown);
}

export class FakeTransport implements Transport {
  calls: string[] = [];
  constructor(public routes: Routes) {}
  async getJson<T>(url: string): Promise<T> {
    this.calls.push(url);
    const hit = Object.entries(this.routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`HTTP 404 Not Found (${url})`);
    const v = hit[1];
    if (v instanceof Error) throw v;
    return (typeof v === "function" ? (v as () => unknown)() : v) as T;
  }
  async status(url: string): Promise<number> {
    return Object.keys(this.routes).some((k) => url.includes(k)) ? 200 : 404;
  }
}

export type ModelReply =
  | { json: unknown; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }; stop_reason?: string }
  | { raw: unknown }
  | { throws: Error };

export class FakeModel implements ModelClient {
  calls: ModelRequest[] = [];
  constructor(public reply: (req: ModelRequest, n: number) => ModelReply) {}
  async create(req: ModelRequest): Promise<unknown> {
    this.calls.push(req);
    const r = this.reply(req, this.calls.length);
    if ("throws" in r) throw r.throws;
    if ("raw" in r) return r.raw;
    return {
      stop_reason: r.stop_reason ?? "end_turn",
      content: [{ type: "text", text: JSON.stringify(r.json) }],
      usage: r.usage ?? { input_tokens: 2000, output_tokens: 400 },
    };
  }
}

export class FakeMailbox implements Mailbox {
  readonly name = "fake";
  readonly query = "fake";
  pages = 0;
  /** Throw on these page numbers (1-based, per scan) once. */
  failOn = new Set<number>();
  private scanPage = 0;
  constructor(public messages: Email[], public pageSize = 2) {}
  async page(args: { after: string; before: string; pageToken: string | null; pageSize: number }) {
    if (!args.pageToken) this.scanPage = 0;
    this.scanPage++;
    this.pages++;
    if (this.failOn.has(this.scanPage)) {
      this.failOn.delete(this.scanPage);
      throw new Error("simulated mailbox outage");
    }
    const inWindow = this.messages.filter((m) => m.receivedAt >= args.after && m.receivedAt < args.before).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const start = args.pageToken ? Number(args.pageToken) : 0;
    const slice = inWindow.slice(start, start + this.pageSize);
    return { messages: slice, nextPageToken: start + this.pageSize < inWindow.length ? String(start + this.pageSize) : null };
  }
}

export class FakeBrowser implements ApplicationBrowser {
  inputs: FillInput[] = [];
  constructor(public snapshot: Array<{ label: string; intent: string; kind: string; value: string }> = []) {}
  async fill(input: FillInput) {
    this.inputs.push(input);
    return {
      outcomes: [
        { label: "First Name", intent: "first_name", status: "filled" as const, why: "personal.yaml" },
        { label: "Are you a veteran?", intent: "eeo", status: "needs_you" as const, why: "never answered automatically" },
      ],
      stoppedFor: null,
      notes: [],
      screenshot: null,
      waitForClose: async () => ({ interrupted: false, snapshot: this.snapshot }),
      close: async () => {},
    };
  }
}

/* ----------------------------------------------------------------- context */

export interface TestEnv {
  ctx: AppContext;
  store: SqliteStore;
  clock: FixedClock;
  config: Config;
  logs: string[];
  transport: FakeTransport;
  model: FakeModel | null;
  mailbox: FakeMailbox | null;
  browser: FakeBrowser;
  confirms: boolean[];
  savedAnswers: Array<{ match: string; answer: string }>;
  savedEvidence: Evidence[];
  reports: Map<string, string>;
  artifactsDir: string;
  setEvidence(e: Evidence | null): void;
}

export function testConfig(tweak?: (c: Config) => void): Config {
  const c = loadConfig(EXAMPLE_CONFIG);
  c.sources.sources.greenhouse.boards = [{ token: "acme", company: "Acme" }];
  c.sources.sources.lever.boards = [];
  c.sources.sources.ashby.boards = [];
  c.sources.sources.remoteok.enabled = false;
  c.sources.watchlist = [];
  tweak?.(c);
  return c;
}

export function makeEnv(opts: {
  now?: string;
  config?: Config;
  evidence?: Evidence | null;
  routes?: Routes;
  model?: FakeModel | null;
  mailbox?: FakeMailbox | null;
  personal?: Personal | null;
  confirms?: boolean[];
  pdfFails?: boolean;
} = {}): TestEnv {
  const clock = new FixedClock(opts.now ?? "2026-10-01T12:00:00.000Z");
  const db = openDatabase(":memory:", () => clock.now().toISOString());
  const store = new SqliteStore(db);
  const config = opts.config ?? testConfig();
  const logs: string[] = [];
  const transport = new FakeTransport(opts.routes ?? {});
  const browser = new FakeBrowser();
  const confirms = [...(opts.confirms ?? [])];
  const reports = new Map<string, string>();
  const artifactsDir = mkdtempSync(join(tmpdir(), "jr-art-"));
  let evidence: Evidence | null = opts.evidence === undefined ? TEST_EVIDENCE : opts.evidence;
  const env: TestEnv = {
    ctx: undefined as never,
    store,
    clock,
    config,
    logs,
    transport,
    model: opts.model ?? null,
    mailbox: opts.mailbox ?? null,
    browser,
    confirms,
    savedAnswers: [],
    savedEvidence: [],
    reports,
    artifactsDir,
    setEvidence: (e) => {
      evidence = e;
    },
  };
  env.ctx = {
    clock,
    store,
    config: () => config,
    evidence: () => {
      if (!evidence) throw new Error("no evidence ledger");
      return evidence;
    },
    hasEvidence: () => evidence !== null,
    personal: () => (opts.personal === undefined ? TEST_PERSONAL : opts.personal),
    transport: () => transport,
    adapters: () => buildAdapters(config.sources),
    modelClient: () => env.model,
    mailbox: () => env.mailbox,
    artifacts: new FsArtifactStore(artifactsDir),
    pdf: {
      render: async (html: string) => {
        if (opts.pdfFails) throw new Error("no chromium");
        return new TextEncoder().encode(`%PDF-fake ${html.length}`);
      },
    },
    browser: () => browser,
    prompter: { confirm: async () => confirms.shift() ?? false },
    log: (l) => logs.push(l),
    paths: { reports: "/tmp/jr-test-reports", backups: "/tmp/jr-test-backups", personal: "/tmp/personal.yaml", evidence: "/tmp/evidence.yaml", artifacts: artifactsDir, config: EXAMPLE_CONFIG },
    saveLearnedAnswers: (entries) => {
      env.savedAnswers.push(...entries);
      return "/tmp/personal.yaml.bak";
    },
    saveEvidence: (e) => {
      env.savedEvidence.push(e);
      evidence = e;
      return null;
    },
    writeReport: (name, content) => {
      reports.set(name, content);
      return `/tmp/jr-test-reports/${name}`;
    },
  };
  return env;
}

/* --------------------------------------------------------------- payloads */

export interface GhJobSpec {
  id: number;
  title: string;
  location?: string;
  content?: string;
  posted?: string;
}

export function ghBoard(jobs: GhJobSpec[]) {
  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${j.id}`,
      first_published: j.posted ?? "2026-09-28T12:00:00Z",
      location: { name: j.location ?? "Remote - US" },
      company_name: "Acme",
      departments: [{ name: "Engineering" }],
      content:
        j.content ??
        `<h3>What you will do</h3><ul><li>Build the product with TypeScript, React and Next.js</li><li>Own technical SEO for marketing pages</li></ul>
         <h3>Requirements</h3><ul><li>5+ years with TypeScript and React</li><li>Experience with Next.js in production</li><li>PostgreSQL</li></ul>
         <p>Compensation: $170,000 - $195,000 per year.</p>`,
    })),
  };
}

export const GH_ACME = "boards-api.greenhouse.io/v1/boards/acme/";

/** A valid triage verdict. */
export function triageVerdict(over: Record<string, unknown> = {}) {
  return {
    fitScore: 82,
    applicationRoi: 78,
    lane: "full_stack",
    recommendation: "apply",
    salaryClassification: "green",
    reasoningSummary: "Strong stack overlap; small team.",
    ...over,
  };
}

/** A valid dossier. */
export function dossierVerdict(over: Record<string, unknown> = {}) {
  return {
    ...triageVerdict(),
    strengths: ["Next.js marketplace in production [c:acme-1]"],
    risks: ["Competition"],
    missingRequirements: [{ requirement: "Kubernetes", kind: "learnable_tool", required: false }],
    differentiation: "SEO plus full-stack.",
    salaryReasoning: "Published range clears the target.",
    interviewProbability: 30,
    competitionEstimate: "moderate",
    outreachTargets: ["Engineering Manager"],
    ...over,
  };
}

/** Reply with a triage or dossier depending on which schema was requested. */
export function verdictReplies(over: { triage?: Record<string, unknown>; dossier?: Record<string, unknown> } = {}) {
  return (req: ModelRequest): ModelReply => {
    const isDossier = "strengths" in ((req.jsonSchema as { properties?: object }).properties ?? {});
    return { json: isDossier ? dossierVerdict(over.dossier) : triageVerdict(over.triage) };
  };
}
