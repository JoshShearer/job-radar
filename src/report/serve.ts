import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { log } from "../lib/log.js";

/**
 * A local viewer for generated briefings.
 *
 * This project has no web application - the dashboard is a Phase 3 item - so
 * this is deliberately small: a read-only static server over the reports
 * directory with an index of past briefings. It exists because opening a
 * file:// URL is awkward on some setups and because comparing this week to last
 * week is genuinely useful.
 *
 * Two security properties matter, because a briefing lists exactly where
 * someone is applying and what they are being paid:
 *
 *   1. It binds to 127.0.0.1 only, never 0.0.0.0. Nothing on the local network
 *      can reach it.
 *   2. It serves only files inside the reports directory, resolved and checked,
 *      so a crafted path cannot walk out to /etc/passwd or the SQLite database.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServeOptions {
  dir: string;
  port: number;
  host?: string;
  /**
   * Watch mode only: tell the browser to re-request the page every N seconds.
   *
   * Sent as the HTTP `Refresh` response header rather than injected as a
   * `<meta http-equiv>` into the document, and that choice is the whole point.
   * The generated pages are self-contained and script-free by design, with
   * tests asserting it. A header leaves the served bytes byte-identical to the
   * file on disk, so a development convenience cannot alter the artifact even
   * by accident. It also rules out the obvious alternative - a live-reload
   * script - which would put JavaScript into a page that promises it has none.
   *
   * Unset or 0 sends nothing, which is every non-watch run.
   */
  refreshSeconds?: number;
}

export function createReportServer(opts: ServeOptions) {
  const root = resolve(opts.dir);
  const refresh = opts.refreshSeconds && opts.refreshSeconds > 0 ? String(opts.refreshSeconds) : null;
  const htmlHeaders = (contentType: string): Record<string, string> => ({
    "content-type": contentType,
    "cache-control": "no-store",
    ...(refresh ? { refresh } : {}),
  });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Only reads. There is nothing here to write to.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      const body = renderIndex(root);
      res.writeHead(200, htmlHeaders("text/html; charset=utf-8"));
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    // Path containment. basename() alone would be enough here, but resolving
    // and re-checking the prefix is the check that stays correct if this ever
    // grows subdirectories.
    const requested = resolve(root, `.${pathname}`);
    if (requested !== root && !requested.startsWith(`${root}/`)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const ext = extname(requested).toLowerCase();
    if (!MIME[ext]) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!existsSync(requested) || !statSync(requested).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }

    const body = readFileSync(requested);
    // Only HTML gets the refresh header. Re-fetching a Markdown file on a timer
    // reloads a text document out from under whoever is reading it.
    res.writeHead(200, ext === ".html" ? htmlHeaders(MIME[ext]!) : {
      "content-type": MIME[ext]!,
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

/**
 * The two rolling files. Both are regenerated every run and neither is a dated
 * archive entry, so both are excluded from the list below - otherwise
 * `latest-briefing` sorts in among the dates as a row that is not a date.
 */
const ROLLING = new Set(["latest.html", "latest-briefing.html"]);

/** Index of every briefing on disk, newest first. */
function renderIndex(root: string): string {
  let files: string[] = [];
  if (existsSync(root)) {
    files = readdirSync(root)
      .filter((f) => f.endsWith(".html") && !ROLLING.has(f))
      .sort()
      .reverse();
  }

  const rows = files
    .map((f) => {
      const label = basename(f, ".html");
      const md = existsSync(resolve(root, `${label}.md`))
        ? ` &middot; <a href="/${encodeURIComponent(label)}.md">markdown</a>`
        : "";
      return `<li><a href="/${encodeURIComponent(f)}">${escapeHtml(label)}</a>${md}</li>`;
    })
    .join("\n");

  // Each link is gated on the file existing. A header link into a directory
  // that has never been generated is a 404 dressed as navigation.
  const hasDashboard = existsSync(resolve(root, "latest.html"));
  const hasBriefing = existsSync(resolve(root, "latest-briefing.html"));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Job Radar - briefings</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf7; --fg:#1c1b19; --muted:#6b6862; --accent:#b4552d; --line:#e2ded6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16151a; --fg:#e9e6e1; --muted:#9a958d; --accent:#e08a5f; --line:#2e2c33; }
  }
  body { margin:0; padding:3rem 1.25rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width:40rem; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p.sub { color:var(--muted); margin:0 0 2rem; font-size:.92rem; }
  a { color:var(--accent); }
  p.links { display:flex; gap:.6rem; flex-wrap:wrap; margin:0 0 2rem; }
  .latest { display:inline-block; padding:.7rem 1.1rem; border:1px solid var(--accent);
            border-radius:8px; text-decoration:none; font-weight:600; }
  .latest.secondary { border-color:var(--line); color:var(--fg); font-weight:500; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:.6rem 0; border-bottom:1px solid var(--line); }
  footer { margin-top:2.5rem; color:var(--muted); font-size:.85rem; }
</style></head>
<body><main>
<h1>Job Radar</h1>
<p class="sub">Local briefing archive. Served from 127.0.0.1 only.</p>
<p class="links">
${hasDashboard ? '<a class="latest" href="/latest.html">Dashboard &rarr;</a>' : ""}
${hasBriefing ? '<a class="latest secondary" href="/latest-briefing.html">Today\'s briefing &rarr;</a>' : ""}
</p>
<ul>
${rows || "<li>No briefings yet. Run <code>npm run radar</code>.</li>"}
</ul>
<footer>Regenerate with <code>npm run radar</code>, then refresh.</footer>
</main></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Start the server, retrying on the next port if one is already in use. */
export function startReportServer(
  opts: ServeOptions,
  maxAttempts = 10,
): Promise<{ port: number; address: string; close: () => void }> {
  // Bind host is not configurable from the CLI on purpose; see the note above.
  const host = opts.host ?? "127.0.0.1";

  return new Promise((resolvePromise, reject) => {
    let port = opts.port;
    let attempts = 0;

    const attempt = () => {
      const server = createReportServer(opts);
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && ++attempts < maxAttempts) {
          log.debug(`port ${port} in use, trying ${port + 1}`);
          port++;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(port, host, () => {
        const addr = server.address();
        resolvePromise({
          port,
          address: typeof addr === "object" && addr ? addr.address : host,
          close: () => server.close(),
        });
      });
    };

    attempt();
  });
}
