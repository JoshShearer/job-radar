import { escapeHtml as esc } from "../../domain/materials/documents.js";
import type { Priority } from "../../domain/evaluation/priority.js";
import type { RankingRecord } from "../../ports/records.js";

/**
 * The web UI's building blocks. Every value interpolated into markup goes
 * through `esc`; the only raw HTML is what these helpers build themselves.
 * Pages carry no scripts and no inline styles (the CSP forbids both).
 */
export { esc };

export interface Shell {
  title: string;
  /** Which nav entry is current. */
  section: "today" | "ranked" | "apps" | "system" | null;
  /** Hidden token every POST form carries. */
  csrf: string;
  /** Versioned stylesheet URL. */
  css: string;
  /** Who is looking: a tailnet user, or someone on this machine. */
  viewer: { via: "loopback" } | { via: "tailnet"; login: string; name: string | null };
  /** Counts shown in the rail. */
  rail: { warnings: number; slate: number; activeApps: number; lastSweep: string | null };
  flash: { text: string; tone: "ok" | "refused" } | null;
  remoteOk: boolean;
}

export const GRADE_NAMES: Record<Priority, string> = {
  A: "Apply and reach out",
  B: "Apply",
  C: "Network or watch",
  D: "Skip",
};

export const BAND_WORDS: Record<string, string> = {
  GREEN: "meets target",
  YELLOW: "under target",
  RED: "below your floor",
  UNKNOWN: "not published",
};

export const BASIS_WORDS: Record<RankingRecord["confidence"], string> = {
  analyzed: "analyst",
  projected: "projected",
  raw: "keyword",
};

export function page(s: Shell, body: string): string {
  const nav = (
    [
      ["today", "/", "Today", s.rail.slate],
      ["ranked", "/ranked", "Ranked", null],
      ["apps", "/apps", "Applications", s.rail.activeApps],
      ["system", "/system", "System", null],
    ] as const
  )
    .map(([key, href, label, count]) => {
      const current = s.section === key ? ' aria-current="page"' : "";
      const n = count ? `<span class="count">${count}</span>` : "";
      return `<a href="${href}"${current}>${label}${n}</a>`;
    })
    .join("");
  const who = s.viewer.via === "tailnet" ? `Signed in as ${esc(s.viewer.name ?? s.viewer.login)} through the tailnet` : "Open on this machine";
  const warnings = s.rail.warnings
    ? `<p><a class="alarm" href="/system">${s.rail.warnings} health ${s.rail.warnings === 1 ? "warning" : "warnings"}</a></p>`
    : "";
  const sweep = `<p>${s.rail.lastSweep ? `Last full sweep ${esc(s.rail.lastSweep)}` : "No full sweep yet"}</p>`;
  const flash = s.flash ? `<div class="flash${s.flash.tone === "refused" ? " refused" : ""}" role="status"><p>${esc(s.flash.text)}</p></div>` : "";
  const attribution = s.remoteOk ? `<footer class="site-foot">Remote listings courtesy of <a href="https://remoteok.com" rel="noreferrer">Remote OK</a>.</footer>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(s.title)} | Job Radar</title>
<link rel="preload" href="/assets/archivo-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${esc(s.css)}">
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="frame">
<header class="rail">
<a class="mark" href="/">Job Radar</a>
<nav aria-label="Sections">${nav}</nav>
<div class="rail-foot">${warnings}${sweep}<p>${who}</p></div>
</header>
<main id="main">
${flash}${body}
${attribution}
</main>
</div>
</body></html>`;
}

/** A POST form: CSRF token, where to come back to, hidden fields, and its controls. */
export function postForm(action: string, csrf: string, back: string, hidden: Record<string, string>, controls: string, cls = ""): string {
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form method="post" action="${esc(action)}"${cls ? ` class="${esc(cls)}"` : ""}><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="${esc(back)}">${fields}${controls}</form>`;
}

export function pursueButton(csrf: string, back: string, id: string, to: string, label: string, cls: string): string {
  return postForm("/act/pursue", csrf, back, { id, to }, `<button class="${esc(cls)}">${esc(label)}</button>`);
}

/** A bar 0..100 drawn with a width class (no inline style is allowed). */
export function bar(value: number | null, cls = ""): string {
  const v = value === null ? 0 : Math.max(0, Math.min(100, Math.round(value / 5) * 5));
  return `<span class="track" aria-hidden="true"><span class="fill v-${v}${cls ? ` ${cls}` : ""}"></span></span>`;
}

export function daysAgo(iso: string | null, now: Date): string {
  if (!iso) return "date unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "date unknown";
  const d = Math.floor((now.getTime() - t) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return "over a year ago";
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return esc(iso.slice(0, 10));
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** YYYY-MM-DD for `now` in this machine's time zone (what a date input shows). */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function stateTag(state: string): string {
  return `<span class="state state-${esc(state)}">${esc(state)}</span>`;
}

/* ----------------------------------------------------------------- markdown */

function inline(text: string): string {
  // Escape first; the patterns below only ever add tags around escaped text.
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

/**
 * The small subset of Markdown the generated documents use: headings, lists,
 * quotes, pipe tables and paragraphs. Headings drop one level so a document's
 * own `#` sits under the page title. Links are left as text: a generated file
 * has no business sending the reader anywhere.
 */
export function markdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const level = Math.min(h[1]!.length + 1, 4);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) q.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`);
      continue;
    }
    if (/^([-*]|\d+[.)])\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(l);
        if (m) items.push(m[2]!);
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (t.startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = lines[i++]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        rows.push(cells);
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="table-wrap"><table>${head ? `<tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>` : ""}${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</table></div>`,
      );
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return out.join("\n");
}
