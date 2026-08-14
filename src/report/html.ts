import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../config/load.js";

/**
 * Render the daily briefing as a self-contained HTML page.
 *
 * Markdown in a gitignored folder is a file, not a delivery. This produces
 * something you can actually open, read on a phone, and click through to the
 * application links - with no external assets, no CDN, and no network access,
 * so it works offline and cannot leak what you are looking at to anyone.
 *
 * A deliberately small Markdown subset is supported, because the input is our
 * own generator rather than arbitrary user content.
 */
export function markdownToHtml(markdown: string, title: string): string {
  return renderPage(title, renderBlocks(markdown));
}

/**
 * The page shell: doctype, head, stylesheet, body wrapper.
 *
 * Shared by the briefing and the dashboard so there is exactly one place where
 * "self-contained, no external assets" is true or false. Two pages with two
 * copies of this would drift, and the copy that drifts is the one that starts
 * requesting a font from a CDN and telling someone what you are looking at.
 *
 * `extraCss` is appended after the base rules, so a page can add its own
 * components without forking the palette.
 */
export function renderPage(title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf7; --fg: #1c1b19; --muted: #6b6862; --line: #e2ded6;
    --card: #ffffff; --accent: #b4552d; --code-bg: #f2efe9;
    --green: #1f7a4d; --yellow: #96700f; --red: #a33125;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16151a; --fg: #e9e6e1; --muted: #9a958d; --line: #2e2c33;
      --card: #1e1d23; --accent: #e08a5f; --code-bg: #24232a;
      --green: #5fbc8a; --yellow: #d8ac4a; --red: #e07a6d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 6rem; background: var(--bg); color: var(--fg);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 54rem; margin: 0 auto; }
  h1 {
    font-size: 1.6rem; letter-spacing: -0.02em; margin: 0 0 1.5rem;
    padding-bottom: .75rem; border-bottom: 2px solid var(--accent);
  }
  h2 {
    font-size: .8rem; text-transform: uppercase; letter-spacing: .1em;
    color: var(--muted); margin: 3rem 0 1rem; font-weight: 650;
  }
  h3 {
    font-size: 1.15rem; letter-spacing: -0.01em; margin: 0 0 1rem;
  }
  section.job {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 1.5rem; margin: 0 0 1.25rem;
  }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1.25rem; font-size: .9rem; }
  td { padding: .4rem .6rem .4rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td:first-child { color: var(--muted); width: 12rem; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  th { padding: .35rem .6rem .35rem 0; border-bottom: 2px solid var(--line); text-align: left;
       font-size: .74rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  /* Label/value tables mute and fix their first column. A table with a real
     header row is a data grid, so that styling has to be undone for it. */
  table:has(th) td:first-child { color: inherit; width: auto; white-space: nowrap; font-weight: 600; }
  ul { margin: .4rem 0 1.1rem; padding-left: 1.15rem; }
  li { margin: .3rem 0; }
  p { margin: 0 0 1rem; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { background: var(--code-bg); padding: .12em .38em; border-radius: 4px; font-size: .88em; }
  pre {
    background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 1rem; overflow-x: auto; font-size: .85rem; line-height: 1.5;
  }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid var(--line); margin: 2.5rem 0; }
  strong { font-weight: 640; }
  em { color: var(--muted); }
  .GREEN { color: var(--green); font-weight: 640; }
  .YELLOW { color: var(--yellow); font-weight: 640; }
  .RED { color: var(--red); font-weight: 640; }
  .UNKNOWN { color: var(--muted); font-weight: 640; }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--line);
           color: var(--muted); font-size: .85rem; }
${extraCss}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export { escapeHtml };

/** Wrap each `### N. Title` section and everything under it in a card. */
function renderBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  let inJob = false;
  let inCode = false;
  let listOpen = false;
  let tableOpen = false;

  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  const closeTable = () => {
    if (tableOpen) {
      out.push("</table>");
      tableOpen = false;
    }
  };
  const closeJob = () => {
    closeList();
    closeTable();
    if (inJob) {
      out.push("</section>");
      inJob = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;

    if (line.startsWith("```")) {
      closeList();
      closeTable();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    if (line.startsWith("# ")) {
      closeJob();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith("## ")) {
      closeJob();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith("### ")) {
      closeJob();
      out.push('<section class="job">');
      inJob = true;
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
      continue;
    }

    // Markdown table. Two shapes reach here: label/value tables with no header
    // row (job details), and real data grids with one (the in-flight table).
    // Separator and empty-header rows are dropped either way.
    if (line.startsWith("|")) {
      closeList();
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c) || c === "")) continue;
      if (!tableOpen) {
        out.push("<table>");
        tableOpen = true;
        // A row followed by a `|---|` separator is a header row. NOTE: the
        // loop increments `i` immediately after reading, so `lines[i]` is
        // already the NEXT line - `lines[i + 1]` would skip one.
        const next = lines[i] ?? "";
        const isHeader =
          next.trim().startsWith("|") &&
          next
            .split("|")
            .slice(1, -1)
            .every((c) => /^\s*:?-+:?\s*$/.test(c));
        if (isHeader) {
          out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`);
          continue;
        }
      }
      out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      continue;
    }
    closeTable();

    if (line.startsWith("- ")) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    closeList();

    if (line.trim() === "---") {
      closeJob();
      out.push("<hr>");
      continue;
    }
    if (line.trim() === "") continue;

    if (line.startsWith("_") && line.endsWith("_")) {
      out.push(`<footer>${inline(line.slice(1, -1))}</footer>`);
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
  }

  closeJob();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

/** Inline markdown: escape first, then apply a fixed set of transforms. */
function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  // Bare URLs -> links. Runs after the markdown-link rule so it does not
  // double-wrap an href that is already inside an anchor tag.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noreferrer">$2</a>');
  s = s.replace(/\b(GREEN|YELLOW|RED|UNKNOWN)\b/g, '<span class="$1">$1</span>');
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Write the HTML briefing next to the Markdown one. Returns the dated path.
 *
 * The rolling copy is `latest-briefing.html`, not `latest.html`: the dashboard
 * took the landing name, because that is what `open` opens and what `serve`
 * links. The dated archive stays the briefing, so `serve`'s index continues to
 * mean "past briefings" and old links keep resolving.
 */
export function writeHtmlReport(markdown: string, dir = paths.reports()): string {
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const html = markdownToHtml(markdown, `Job Radar - ${date}`);
  const file = resolve(dir, `${date}.html`);
  writeFileSync(file, html, "utf8");
  writeFileSync(resolve(dir, BRIEFING_LATEST), html, "utf8");
  return file;
}

/** The rolling briefing filename, shared with `serve` so the two cannot drift. */
export const BRIEFING_LATEST = "latest-briefing.html";
