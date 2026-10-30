import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppContext } from "../../app/context.js";
import { buildBriefing, type Briefing } from "../../app/briefing.js";
import { withRun } from "../../app/run.js";
import { isApplicationState, isPursuitState, recordOutcome, recordSubmission, transitionPursuit } from "../../app/pursuit.js";
import { approve } from "../../app/materials.js";
import { UserError, type UseCaseResult } from "../../kernel/result.js";
import { admit, sameOrigin, type Admission } from "./access.js";
import { localDay, page, type Shell } from "./html.js";
import { appsPage, generationPage, inFlightApplications, messagePage, parseRankedQuery, postingPage, rankedPage, readableFiles, submitPage, systemPage, todayPage, type PageContext } from "./pages.js";

/**
 * The web UI. It binds 127.0.0.1 only; reaching it from another device goes
 * through `tailscale serve` on this machine, admitted by `access.ts` (allowed
 * host AND an allowed tailnet login). Pages carry no scripts and no inline
 * styles. The only writes are the human's own statements: pursuit decisions,
 * a submission they made, an outcome an employer gave them, and approval of a
 * pack they read. Each goes through the same use case the CLI calls, inside
 * `withRun`, guarded by a per-process CSRF token and a same-origin check.
 * Nothing here spends money, fills a form, or sends anything.
 */
export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const ASSET_DIR = resolve(import.meta.dirname, "assets");
const ASSETS: Record<string, string> = {
  "app.css": "text/css; charset=utf-8",
  "archivo-latin.woff2": "font/woff2",
  "archivo-latin-ext.woff2": "font/woff2",
  "ARCHIVO-OFL.txt": "text/plain; charset=utf-8",
  "icon.svg": "image/svg+xml",
};
const PAGE_CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
/** Generated HTML documents are shown sandboxed: no script, no same-origin access, no network. */
const DOC_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const MAX_BODY = 10_000;
const FLASH_KEEP = 200;

interface Flash {
  text: string;
  tone: "ok" | "refused";
}

export async function startServer(ctx: AppContext, opts: { port?: number } = {}): Promise<ServerHandle> {
  const web = ctx.config().operations.web;
  const policy = { allowedHosts: web.allowed_hosts, allowedLogins: web.allowed_logins };
  const csrf = randomBytes(18).toString("hex");
  const assets = new Map(Object.keys(ASSETS).map((name) => [name, readFileSync(resolve(ASSET_DIR, name))]));
  const versioned = (name: string) => `/assets/${name}?v=${createHash("sha256").update(assets.get(name)!).digest("hex").slice(0, 10)}`;
  const cssUrl = versioned("app.css");
  const iconUrl = versioned("icon.svg");
  const flashes = new Map<string, Flash>();
  const state: ServerState = { ctx, csrf, cssUrl, iconUrl, assets, flashes, policy };

  const server = createServer((req, res) => {
    handle(state, req, res).catch((err: unknown) => {
      ctx.log(`web: ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) sendText(res, 500, "Something went wrong rendering this page. The details are in the server log.");
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? web.port, "127.0.0.1", () => ok());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? web.port);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

interface ServerState {
  ctx: AppContext;
  csrf: string;
  cssUrl: string;
  iconUrl: string;
  assets: Map<string, Buffer>;
  flashes: Map<string, Flash>;
  policy: { allowedHosts: readonly string[]; allowedLogins: readonly string[] };
}

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'" });
  res.end(text);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...BASE_HEADERS, location, "cache-control": "no-store" });
  res.end();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new HttpError(415, "Forms must be sent as application/x-www-form-urlencoded.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large.");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A local path to come back to after a write; anything else falls back to "/". */
export function safeBack(back: string | null): string {
  if (!back || !back.startsWith("/") || back.startsWith("//") || back.includes("\\")) return "/";
  try {
    const u = new URL(back, "http://local.invalid");
    if (u.origin !== "http://local.invalid") return "/";
    u.searchParams.delete("f");
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

/**
 * When something happened, from a date input. Today means now (so it sorts
 * after anything already recorded today); an earlier day means local noon of
 * that day. A future date is refused: an event cannot have happened yet.
 */
export function occurredAt(on: string | null, now: Date): string {
  const today = localDay(now);
  if (!on || on === today) return now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new UserError(`"${on}" is not a date.`);
  if (on > today) throw new UserError("That date is in the future.");
  const t = new Date(`${on}T12:00:00`);
  if (Number.isNaN(t.getTime()) || localDay(t) !== on) throw new UserError(`"${on}" is not a date.`);
  return t.toISOString();
}

function note(form: URLSearchParams, prefix: string): string {
  const n = (form.get("note") ?? "").trim().slice(0, 500);
  return n ? `${prefix}: ${n}` : prefix;
}

function resultText<T>(r: UseCaseResult<T>, ok: (v: T) => string): Flash {
  if (r.outcome === "ok") return { text: ok(r.value), tone: "ok" };
  return { text: r.notes.join(" ") || `Not recorded (${r.outcome}).`, tone: "refused" };
}

function relative(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const hours = (now.getTime() - Date.parse(iso)) / 3_600_000;
  if (!Number.isFinite(hours)) return null;
  if (hours < 1) return "under an hour ago";
  if (hours < 36) return `${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

async function handle(s: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const access = admit(req.headers, s.policy);
  if (!access.ok) {
    s.ctx.log(`web: refused ${req.method} ${req.url}: ${access.why}`);
    return sendText(res, 403, `Forbidden: ${access.why}.`);
  }
  const url = new URL(req.url ?? "/", "http://local.invalid");

  // ---- static assets: fixed names only, never a path from the request
  const asset = /^\/assets\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
  if (asset && req.method === "GET") {
    const body = s.assets.get(asset[1]!);
    if (!body) return sendText(res, 404, "Not found.");
    res.writeHead(200, { ...BASE_HEADERS, "content-type": ASSETS[asset[1]!]!, "cache-control": "public, max-age=31536000, immutable" });
    return void res.end(body);
  }

  try {
    if (req.method === "POST") return await post(s, access, req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD, POST");
      return sendText(res, 405, "Method not allowed.");
    }
    return await get(s, access, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendText(res, err.status, err.message);
    throw err;
  }
}

function shell(s: ServerState, access: Admission & { ok: true }, b: Briefing, title: string, section: Shell["section"], flash: Flash | null): Shell {
  const now = s.ctx.clock.now();
  return {
    title,
    section,
    csrf: s.csrf,
    css: s.cssUrl,
    icon: s.iconUrl,
    viewer: access.via === "tailnet" ? { via: "tailnet", login: access.login, name: access.name } : { via: "loopback" },
    rail: {
      warnings: b.health.filter((h) => h.level === "warn").length,
      slate: b.slate.length,
      activeApps: inFlightApplications(b).length,
      lastSweep: relative(s.ctx.store.lastCompleteSweepAt(), now),
    },
    flash,
    remoteOk: b.remoteOkAttribution,
  };
}

async function get(s: ServerState, access: Admission & { ok: true }, res: ServerResponse, url: URL): Promise<void> {
  const { ctx } = s;
  const fid = url.searchParams.get("f");
  const flash = fid ? (s.flashes.get(fid) ?? null) : null;
  url.searchParams.delete("f");
  const here = `${url.pathname}${url.search}`;
  const p: PageContext = { ctx, csrf: s.csrf, here };
  const b = buildBriefing(ctx);
  const render = (status: number, title: string, section: Shell["section"], body: string) => sendHtml(res, status, page(shell(s, access, b, title, section, flash), body));
  const notFound = (what: string) => render(404, "Not found", null, messagePage("Not found", what));

  if (url.pathname === "/") return render(200, "Today", "today", todayPage(p, b));
  if (url.pathname === "/ranked") return render(200, "Ranked", "ranked", rankedPage(p, parseRankedQuery(url)));
  if (url.pathname === "/apps") return render(200, "Applications", "apps", appsPage(p));
  if (url.pathname === "/system") return render(200, "System", "system", systemPage(p, b));

  const m = /^\/o\/([A-Za-z0-9]{1,64})(?:\/(submit|g\/([A-Za-z0-9-]{1,64})(?:\/f\/([^/]{1,200}))?))?$/.exec(url.pathname);
  if (!m) return notFound("There is no page at this address.");
  const id = m[1]!;
  const r = ctx.store.rankingFor(id);
  if (!r) return notFound(`No evaluated posting has the id ${id}.`);
  const title = `${r.company}, ${r.title}`;
  if (!m[2]) return render(200, title, null, postingPage(p, r));
  if (m[2] === "submit") {
    if (ctx.store.applications(id).length) return render(409, title, null, messagePage("Already recorded", "This posting already has a submitted application. Record what the employer did from the posting page."));
    return render(200, `Record submission: ${title}`, null, submitPage(p, r));
  }
  const g = ctx.store.artifacts(id).find((x) => x.id === m[3]);
  if (!g) return notFound(`No generation ${m[3]} for this posting.`);
  if (!m[4]) return render(200, `${g.kind === "pack" ? "Pack" : "Resume"}: ${title}`, null, generationPage(p, r, g, (f) => ctx.artifacts.read(g.dir, f)));

  // ---- one file of a generation: listed in its manifest, and unchanged since
  let file: string;
  try {
    file = decodeURIComponent(m[4]);
  } catch {
    return notFound("Malformed file name.");
  }
  const entry = g.manifest.files[file];
  const { others, docs } = readableFiles(g);
  if (!entry || (!others.includes(file) && !docs.includes(file))) return notFound(`${file} is not a readable file of this generation.`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(ctx.artifacts.path(g.dir, file));
  } catch {
    return notFound(`${file} is missing from disk.`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    return render(409, "File changed", null, messagePage("This file changed on disk", `${file} no longer matches the hash recorded when it was generated, so it is not shown. Generations are immutable; regenerate instead of editing.`));
  }
  const type = file.endsWith(".pdf") ? "application/pdf" : file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  res.writeHead(200, {
    ...BASE_HEADERS,
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": file.endsWith(".pdf") ? "default-src 'none'; object-src 'self'" : DOC_CSP,
    "content-disposition": `inline; filename="${file.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
  });
  res.end(bytes);
}

async function post(s: ServerState, _access: Admission & { ok: true }, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { ctx } = s;
  if (!sameOrigin(req.headers)) return sendText(res, 403, "Forbidden: cross-origin request refused.");
  const form = await readForm(req);
  if (form.get("csrf") !== s.csrf) return sendText(res, 403, "Forbidden: this form is from an older session of the server. Reload the page and try again.");
  const back = safeBack(form.get("back"));

  let flash: Flash;
  try {
    flash = await act(ctx, url.pathname, form);
  } catch (err) {
    if (err instanceof UserError) flash = { text: err.message, tone: "refused" };
    else throw err;
  }
  const fid = randomBytes(8).toString("hex");
  s.flashes.set(fid, flash);
  while (s.flashes.size > FLASH_KEEP) s.flashes.delete(s.flashes.keys().next().value!);
  const u = new URL(back, "http://local.invalid");
  u.searchParams.set("f", fid);
  return redirect(res, `${u.pathname}${u.search}`);
}

async function act(ctx: AppContext, action: string, form: URLSearchParams): Promise<Flash> {
  const name = (id: string) => {
    const r = ctx.store.rankingFor(id);
    return r ? `${r.company}, ${r.title}` : id;
  };
  switch (action) {
    case "/act/pursue": {
      const id = form.get("id") ?? "";
      const to = form.get("to") ?? "";
      if (!ctx.store.opportunityExists(id)) throw new HttpError(400, "Unknown posting.");
      // "applied" is a submission; it has its own confirmation step.
      if (!isPursuitState(to) || to === "applied") throw new HttpError(400, "Not a decision this form can record.");
      const r = await withRun(ctx, "web:pursue", (runId) => transitionPursuit(ctx, runId, id, to, { note: "from the web UI" }));
      const verb: Record<string, string> = { shortlisted: "Shortlisted", reviewed: "Marked reviewed", preparing: "Marked preparing", skipped: "Skipped", new: "Moved back to new" };
      return resultText(r, () => `${verb[to] ?? `Moved to ${to}`}: ${name(id)}.`);
    }
    case "/act/submit": {
      const id = form.get("id") ?? "";
      if (!ctx.store.opportunityExists(id)) throw new HttpError(400, "Unknown posting.");
      // A submission is the human's statement of fact; only an explicit yes records it.
      if (form.get("confirm") !== "yes") return { text: "Nothing recorded: tick “I submitted this application myself” to record a submission.", tone: "refused" };
      const submittedAt = occurredAt(form.get("on"), ctx.clock.now());
      const r = await withRun(ctx, "web:submitted", (runId) => recordSubmission(ctx, runId, id, { submittedAt, note: note(form, "from the web UI") }));
      return resultText(r, (v) => `Recorded your submission to ${name(id)} as application ${v.applicationId}.`);
    }
    case "/act/outcome": {
      const appId = form.get("app") ?? "";
      const to = form.get("to") ?? "";
      const app = ctx.store.application(appId);
      if (!app) throw new HttpError(400, "Unknown application.");
      if (!isApplicationState(to) || to === "submitted") throw new HttpError(400, "Not an outcome this form can record.");
      const at = occurredAt(form.get("on"), ctx.clock.now());
      const r = await withRun(ctx, "web:outcome", (runId) => recordOutcome(ctx, runId, app.id, to, { occurredAt: at, note: note(form, "from the web UI") }));
      return resultText(r, (v) => `Recorded ${v.to} for ${name(app.opportunityId)} (was ${v.from}).`);
    }
    case "/act/approve": {
      const id = form.get("id") ?? "";
      const gen = form.get("gen") ?? "";
      if (!ctx.store.opportunityExists(id)) throw new HttpError(400, "Unknown posting.");
      // Approval certifies the human read the pack; only an explicit yes records it.
      if (form.get("read") !== "yes") return { text: "Not approved: tick “I have read this pack” to approve it.", tone: "refused" };
      const n = (form.get("note") ?? "").trim().slice(0, 500);
      const r = await withRun(ctx, "web:approve", () => approve(ctx, id, gen, n ? `from the web UI: ${n}` : "from the web UI"));
      return resultText(r, (v) => (r.notes.some((x) => x.startsWith("Already")) ? r.notes.join(" ") : `Approved pack ${v.generationId}. jr fill may now use it.`));
    }
    default:
      throw new HttpError(404, "No such action.");
  }
}
