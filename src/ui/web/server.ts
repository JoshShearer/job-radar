import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AppContext } from "../../app/context.js";
import { buildBriefing } from "../../app/briefing.js";
import { withRun } from "../../app/run.js";
import { applicationFold, applicationViews, isPursuitState, pursuitOf, transitionPursuit } from "../../app/pursuit.js";
import { spendFor } from "../../app/spend.js";
import { briefingHtml, externalLink, funnelHtml, rankedHtml, renderPage } from "../reports/render.js";
import { escapeHtml as esc } from "../../domain/materials/documents.js";
import { PRIORITY_LABELS } from "../../domain/evaluation/priority.js";

/**
 * The local web UI. Loopback only: it binds 127.0.0.1 and refuses requests
 * whose Host is anything else (a DNS-rebinding page cannot drive it). Pages
 * carry no scripts. The only writes are pursuit decisions, made through the
 * same use case the CLI calls, guarded by a per-process CSRF token and a
 * same-origin check. Nothing here spends money, fills a form, or sends mail.
 */
export interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startServer(ctx: AppContext, opts: { port: number }): Promise<ServerHandle> {
  const csrf = randomBytes(18).toString("hex");
  const server = createServer((req, res) => {
    handle(ctx, csrf, opts.port, req, res).catch((err: unknown) => {
      send(res, 500, renderPage("Error", `<h1>Error</h1><p>${esc(err instanceof Error ? err.message : String(err))}</p>`));
    });
  });
  await new Promise<void>((ok) => server.listen(opts.port, "127.0.0.1", ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function loopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function handle(ctx: AppContext, csrf: string, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!loopbackHost(req)) return send(res, 403, "forbidden");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const nav = `<nav><a href="/">Briefing</a><a href="/top">Ranked</a><a href="/apps">Applications</a><a href="/dashboard">Dashboard</a></nav>`;
  const flash = url.searchParams.get("msg") ? `<p class="card">${esc(url.searchParams.get("msg")!)}</p>` : "";

  if (req.method === "POST" && url.pathname === "/act") {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, "cross-origin request refused");
    const form = await readForm(req);
    if (form.get("csrf") !== csrf) return send(res, 403, "bad token");
    const id = form.get("id") ?? "";
    const to = form.get("to") ?? "";
    if (!ctx.store.opportunityExists(id) || !isPursuitState(to)) return send(res, 400, "bad request");
    const r = await withRun(ctx, "web:pursue", (runId) => transitionPursuit(ctx, runId, id, to, { note: "from the web UI" }));
    const msg = r.outcome === "ok" ? `${id}: ${r.value.from} -> ${r.value.to}` : r.notes.join(" ");
    const back = req.headers.referer && req.headers.referer.startsWith(`http://127.0.0.1:${port}`) ? new URL(req.headers.referer).pathname : "/";
    return send(res, 303, "", { location: `${back}?msg=${encodeURIComponent(msg)}` });
  }
  if (req.method !== "GET") return send(res, 405, "method not allowed");

  if (url.pathname === "/") {
    return send(res, 200, briefingHtml(buildBriefing(ctx), { csrf }).replace("<main>", `<main>${flash}`));
  }
  if (url.pathname === "/top") {
    const rows = ctx.store.ranking({ eligible: true, pursuitStates: ["new", "reviewed", "shortlisted"], postingStates: ["open", "unknown"], includeEvergreen: false, limit: 100 });
    return send(res, 200, renderPage("Ranked", `<h1>Ranked</h1>${nav}${flash}${rankedHtml(rows, ctx.clock.now().toISOString(), { csrf })}`));
  }
  if (url.pathname === "/apps") {
    const rows = applicationViews(ctx)
      .map((a) => `<tr><td><a href="/o/${esc(a.opportunityId)}">${esc(a.company)} - ${esc(a.title)}</a></td><td>${esc(a.state)}</td><td>${esc(a.submittedAt.slice(0, 10))}</td><td>${esc(a.furthest)}</td></tr>`)
      .join("");
    return send(res, 200, renderPage("Applications", `<h1>Applications</h1>${nav}<table><tr><th>Application</th><th>State</th><th>Submitted</th><th>Furthest</th></tr>${rows}</table>`));
  }
  if (url.pathname === "/dashboard") {
    const b = buildBriefing(ctx);
    const health = b.health.map((h) => `<li class="${h.level === "warn" ? "warn" : "muted"}">${esc(h.text)}</li>`).join("");
    const spend = b.spend.byPurpose.map((p) => `<tr><td>${esc(p.purpose)}</td><td>${p.calls}</td><td>$${p.usd.toFixed(4)}</td></tr>`).join("");
    return send(
      res,
      200,
      renderPage(
        "Dashboard",
        `<h1>Dashboard</h1>${nav}<h2>Health</h2><ul>${health || "<li>All observers current.</li>"}</ul>${funnelHtml(b)}<h2>Spend (30 days)</h2><table><tr><th>Purpose</th><th>Calls</th><th>USD</th></tr>${spend}</table>`,
      ),
    );
  }
  const m = /^\/o\/([A-Za-z0-9]+)$/.exec(url.pathname);
  if (m) {
    const id = m[1]!;
    const r = ctx.store.rankingFor(id);
    if (!r) return send(res, 404, renderPage("Not found", `<h1>Not found</h1>${nav}`));
    const pursuit = pursuitOf(ctx, id);
    const apps = ctx.store.applications(id).map((a) => `<li>Application <code>${esc(a.id)}</code>: ${esc(applicationFold(ctx, a.id).state)}</li>`).join("");
    const gens = ctx.store.artifacts(id).map((g) => `<li>${esc(g.kind)} <code>${esc(g.id)}</code>${g.approvedAt ? " (approved)" : ""}</li>`).join("");
    const spent = spendFor(ctx, id);
    const buttons = (["reviewed", "shortlisted", "skipped"] as const)
      .map((to) => `<form class="inline" method="post" action="/act"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="to" value="${to}"><button>${to}</button></form>`)
      .join("");
    return send(
      res,
      200,
      renderPage(
        `${r.company} - ${r.title}`,
        `<h1>${esc(r.company)} - ${esc(r.title)}</h1>${nav}${flash}
<div class="card"><p>Priority <strong>${r.priority}</strong> ${esc(PRIORITY_LABELS[r.priority])}: fit ${Math.round(r.fit)}, roi ${Math.round(r.roi)} (${esc(r.confidence)})<br>
Posting ${esc(r.postingState)} | pursuit ${esc(pursuit.state)} | <span class="${esc(r.compBand)}">${esc(r.compBand)}</span> ${esc(r.detail.salary)}</p>
${r.detail.analystSummary ? `<p><strong>Analyst:</strong> ${esc(r.detail.analystSummary)}</p>` : ""}
<p>${buttons}</p></div>
<h2>Why it scored this way</h2><pre>${esc(r.detail.explanation)}</pre>
<h2>Applications and documents</h2><ul>${apps}${gens}</ul>
<p class="muted">Spent on this posting: $${spent.usd.toFixed(4)} (${spent.calls} calls). Tailoring, preparing, filling and submitting happen from the CLI.</p>
<p>${externalLink(r.detail.applicationUrl ?? r.detail.url, "Open the posting")}</p>`,
      ),
    );
  }
  return send(res, 404, renderPage("Not found", `<h1>Not found</h1>${nav}`));
}
