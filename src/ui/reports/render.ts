import type { Briefing } from "../../app/briefing.js";
import type { RankingRecord } from "../../ports/records.js";
import { escapeHtml as esc } from "../../domain/materials/documents.js";
import { PRIORITY_LABELS } from "../../domain/evaluation/priority.js";
import { formatRate } from "../../domain/pursuit/funnel.js";
import { REMOTEOK_ATTRIBUTION } from "../../adapters/ats/remoteok.js";
import { httpUrl } from "../../domain/catalog/normalize.js";

/**
 * Reports rendered from structured data. Markdown for the terminal and grep;
 * HTML that is fully self-contained (no scripts, no fonts, no network), so a
 * report opened offline tells nobody what you are looking at.
 */

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf7; --fg:#1c1b19; --muted:#6b6862; --line:#e2ded6; --card:#fff; --accent:#b4552d;
          --code:#f2efe9; --green:#1f7a4d; --yellow:#96700f; --red:#a33125; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16151a; --fg:#e9e6e1; --muted:#9a958d; --line:#2e2c33; --card:#1e1d23;
          --accent:#e08a5f; --code:#24232a; --green:#5fbc8a; --yellow:#d8ac4a; --red:#e07a6d; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem 5rem; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 56rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 1.25rem; padding-bottom:.6rem; border-bottom:2px solid var(--accent); }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:2.5rem 0 .8rem; }
  h3 { font-size:1.08rem; margin:0 0 .6rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.1rem 1.25rem; margin:0 0 1rem; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; margin:0 0 1rem; }
  th { text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); border-bottom:2px solid var(--line); padding:.3rem .5rem .3rem 0; }
  td { padding:.35rem .5rem .35rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  ul { margin:.3rem 0 1rem; padding-left:1.1rem; }
  a { color:var(--accent); }
  code { font-family: ui-monospace, Menlo, monospace; background:var(--code); padding:.1em .35em; border-radius:4px; font-size:.86em; }
  .muted { color:var(--muted); } .warn { color:var(--red); }
  .GREEN { color:var(--green); font-weight:600; } .YELLOW { color:var(--yellow); font-weight:600; }
  .RED { color:var(--red); font-weight:600; } .UNKNOWN { color:var(--muted); font-weight:600; }
  form.inline { display:inline; margin:0 .25rem 0 0; }
  button { font:inherit; font-size:.82rem; padding:.2rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); cursor:pointer; }
  nav a { margin-right:1rem; }
  footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.85rem; }
</style></head>
<body><main>
${body}
</main></body></html>`;
}

function age(datePosted: string | null, now: string): string {
  if (!datePosted) return "?";
  const d = Math.round((Date.parse(now) - Date.parse(datePosted)) / 86_400_000);
  return d >= 365 ? "1y+" : `${d}d`;
}

function scoreLine(r: RankingRecord): string {
  const parts = [`fit ${Math.round(r.fit)}`, `roi ${Math.round(r.roi)}`, `${r.confidence}`];
  if (r.confidence !== "raw") parts.push(`keyword ${Math.round(r.rawFit)}`);
  return parts.join(" / ");
}

/* ------------------------------------------------------------------ markdown */

export function briefingMarkdown(b: Briefing): string {
  const L: string[] = [];
  const day = b.generatedAt.slice(0, 10);
  L.push(`# Job Radar briefing - ${day}`, "");
  L.push(
    `${b.counts.opportunities} postings tracked, ${b.counts.eligible} eligible, ${b.counts.assessed} assessed, ${b.counts.open} open, ${b.counts.closed} closed.`,
    "",
  );
  if (b.health.length) {
    L.push("## System health", "");
    for (const h of b.health) L.push(`- ${h.level === "warn" ? "**" : ""}${h.text}${h.level === "warn" ? "**" : ""}`);
    L.push("");
  }
  L.push("## Today's slate", "");
  if (!b.slate.length) L.push("_Nothing new clears the bar today. A short slate is the intended output, not a failure._", "");
  for (const [i, r] of b.slate.entries()) {
    L.push(`### ${i + 1}. ${r.company} - ${r.title}`);
    L.push(`- Priority ${r.priority}: ${PRIORITY_LABELS[r.priority]} (${scoreLine(r)})`);
    L.push(`- ${r.location} (${r.remoteStatus}), posted ${age(r.datePosted, b.generatedAt)} ago, compensation ${r.compBand}: ${r.detail.salary}`);
    if (r.analystRec) L.push(`- Analyst: ${r.analystRec.replace(/_/g, " ")} (${r.analystTier}). ${r.detail.analystSummary ?? ""}`);
    else if (r.staleAssessment) L.push("- Analyst: assessment is stale (inputs changed)");
    for (const s of r.detail.positiveSignals.slice(0, 4)) L.push(`  - + ${s}`);
    for (const s of r.detail.negativeSignals.filter((x) => !x.startsWith("WARNING")).slice(0, 3)) L.push(`  - - ${s}`);
    L.push(`- ${r.detail.applicationUrl ?? r.detail.url}`, `- \`jr show ${r.opportunityId}\``, "");
  }
  if (b.pursuing.length) {
    L.push("## In progress", "", "| Posting | State | Days | Next |", "|---|---|---|---|");
    for (const p of b.pursuing) L.push(`| ${p.row.company} - ${p.row.title} (\`${p.row.opportunityId}\`) | ${p.state} | ${p.days} | ${p.action} |`);
    L.push("");
  }
  if (b.applications.length) {
    L.push("## Applications", "", "| Application | State | Days | Next |", "|---|---|---|---|");
    for (const a of b.applications) L.push(`| ${a.company} - ${a.title} (\`${a.id}\`) | ${a.state} | ${a.days} | ${a.action} |`);
    L.push("");
  }
  if (b.silence.length) {
    L.push("## Needs an outcome", "");
    for (const s of b.silence) {
      if (s.kind === "suggest_ghosted") {
        L.push(`- ${s.app.company} - ${s.app.title}: no contact in ${Math.round(s.days)} days (mail was read the whole time). If it is dead: \`jr outcome ${s.app.id} ghosted\``);
      } else {
        L.push(`- ${s.app.company} - ${s.app.title}: quiet for ${Math.round(s.days)} days, but UNOBSERVED (${s.why}). Not suggesting anything.`);
      }
    }
    L.push("");
  }
  L.push("## Funnel", "");
  if (b.funnel.sampleWarning) L.push(`_${b.funnel.sampleWarning}_`, "");
  for (const c of b.funnel.conversions) L.push(`- ${c.from} -> ${c.to}: ${formatRate(c.rate, c.n)}`);
  for (const h of b.funnel.hypotheses) L.push(`- ${h}`);
  L.push("");
  L.push("## Spend", "", `Today $${b.spend.day.committed.toFixed(2)} of $${b.spend.budgets.perDay.toFixed(2)}; this month $${b.spend.month.committed.toFixed(2)} of $${b.spend.budgets.perMonth.toFixed(2)}.`, "");
  if (b.calibration) L.push(`_${b.calibration}_`, "");
  if (b.watchlist.length) {
    L.push("## Watchlist (no public feed; research by hand)", "", ...b.watchlist.map((w) => `- ${w.company}${w.why ? `: ${w.why}` : ""}`), "");
  }
  if (b.remoteOkAttribution) L.push("---", "", REMOTEOK_ATTRIBUTION, "");
  return L.join("\n");
}

/* ---------------------------------------------------------------------- html */

export interface ActionOptions {
  /** When set, render action buttons that POST with this token (web UI only). */
  csrf: string;
}

function actions(id: string, a: ActionOptions | undefined, buttons: Array<[string, string]>): string {
  if (!a) return "";
  return buttons
    .map(
      ([to, label]) =>
        `<form class="inline" method="post" action="/act"><input type="hidden" name="csrf" value="${esc(a.csrf)}"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="to" value="${esc(to)}"><button>${esc(label)}</button></form>`,
    )
    .join("");
}

/**
 * A link to a URL that came from a job board: untrusted. Only http(s) is
 * linked (a `javascript:` href runs on click, and the briefing is opened from
 * disk without the web UI's CSP); anything else is shown as withheld.
 */
export function externalLink(url: string | null | undefined, label: string): string {
  const safe = httpUrl(url);
  return safe ? `<a href="${esc(safe)}" rel="noreferrer">${esc(label)}</a>` : `<span class="muted">${esc(label)} (link withheld: not an http(s) URL)</span>`;
}

export function slateCardHtml(r: RankingRecord, now: string, a?: ActionOptions): string {
  const signals = r.detail.positiveSignals.slice(0, 4).map((s) => `<li>${esc(s)}</li>`).join("");
  const concerns = r.detail.negativeSignals.filter((x) => !x.startsWith("WARNING")).slice(0, 3).map((s) => `<li class="muted">${esc(s)}</li>`).join("");
  const analyst = r.analystRec
    ? `<p><strong>Analyst:</strong> ${esc(r.analystRec.replace(/_/g, " "))} (${esc(r.analystTier ?? "")}). ${esc(r.detail.analystSummary ?? "")}</p>`
    : r.staleAssessment
      ? `<p class="muted">Assessment is stale: the posting or the evidence changed since.</p>`
      : `<p class="muted">Not assessed.</p>`;
  return `<div class="card"><h3><a href="/o/${esc(r.opportunityId)}">${esc(r.company)} - ${esc(r.title)}</a></h3>
<p>Priority <strong>${r.priority}</strong> ${esc(PRIORITY_LABELS[r.priority])} <span class="muted">(${esc(scoreLine(r))})</span><br>
${esc(r.location)} (${esc(r.remoteStatus)}), posted ${esc(age(r.datePosted, now))} ago, <span class="${esc(r.compBand)}">${esc(r.compBand)}</span> ${esc(r.detail.salary)}</p>
${analyst}<ul>${signals}${concerns}</ul>
<p>${externalLink(r.detail.applicationUrl ?? r.detail.url, "posting")} <code>${esc(r.opportunityId)}</code></p>
${actions(r.opportunityId, a, [
  ["shortlisted", "Shortlist"],
  ["reviewed", "Reviewed"],
  ["skipped", "Skip"],
])}</div>`;
}

export function briefingHtml(b: Briefing, a?: ActionOptions): string {
  const P: string[] = [];
  P.push(`<h1>Job Radar - ${esc(b.generatedAt.slice(0, 10))}</h1>`);
  if (a) P.push(`<nav><a href="/">Briefing</a><a href="/dashboard">Dashboard</a><a href="/top">Ranked</a><a href="/apps">Applications</a></nav>`);
  P.push(
    `<p class="muted">${b.counts.opportunities} tracked, ${b.counts.eligible} eligible, ${b.counts.assessed} assessed, ${b.counts.open} open, ${b.counts.closed} closed.</p>`,
  );
  if (b.health.length) {
    P.push("<h2>System health</h2><div class=\"card\"><ul>");
    for (const h of b.health) P.push(`<li class="${h.level === "warn" ? "warn" : "muted"}">${esc(h.text)}</li>`);
    P.push("</ul></div>");
  }
  P.push("<h2>Today's slate</h2>");
  if (!b.slate.length) P.push(`<p class="muted">Nothing new clears the bar today.</p>`);
  for (const r of b.slate) P.push(slateCardHtml(r, b.generatedAt, a));
  if (b.pursuing.length) {
    P.push("<h2>In progress</h2><table><tr><th>Posting</th><th>State</th><th>Days</th><th>Next</th></tr>");
    for (const p of b.pursuing) {
      P.push(`<tr><td><a href="/o/${esc(p.row.opportunityId)}">${esc(p.row.company)} - ${esc(p.row.title)}</a></td><td>${esc(p.state)}</td><td>${p.days}</td><td>${esc(p.action)}</td></tr>`);
    }
    P.push("</table>");
  }
  if (b.applications.length) {
    P.push("<h2>Applications</h2><table><tr><th>Application</th><th>State</th><th>Days</th><th>Next</th></tr>");
    for (const x of b.applications) {
      P.push(`<tr><td>${esc(x.company)} - ${esc(x.title)} <code>${esc(x.id)}</code></td><td>${esc(x.state)}</td><td>${x.days}</td><td>${esc(x.action)}</td></tr>`);
    }
    P.push("</table>");
  }
  if (b.silence.length) {
    P.push("<h2>Needs an outcome</h2><div class=\"card\"><ul>");
    for (const s of b.silence) {
      P.push(
        s.kind === "suggest_ghosted"
          ? `<li>${esc(s.app.company)} - ${esc(s.app.title)}: no contact in ${Math.round(s.days)} days. <code>jr outcome ${esc(s.app.id)} ghosted</code></li>`
          : `<li class="muted">${esc(s.app.company)} - ${esc(s.app.title)}: quiet ${Math.round(s.days)} days but unobserved (${esc(s.why ?? "")}).</li>`,
      );
    }
    P.push("</ul></div>");
  }
  P.push(funnelHtml(b));
  P.push(`<h2>Spend</h2><p>Today $${b.spend.day.committed.toFixed(2)} of $${b.spend.budgets.perDay.toFixed(2)}; this month $${b.spend.month.committed.toFixed(2)} of $${b.spend.budgets.perMonth.toFixed(2)}.</p>`);
  if (b.watchlist.length) P.push(`<h2>Watchlist</h2><ul>${b.watchlist.map((w) => `<li>${esc(w.company)}${w.why ? `: ${esc(w.why)}` : ""}</li>`).join("")}</ul>`);
  if (b.remoteOkAttribution) P.push(`<footer>Remote listings courtesy of <a href="https://remoteok.com">Remote OK</a>.</footer>`);
  return renderPage(`Job Radar ${b.generatedAt.slice(0, 10)}`, P.join("\n"));
}

export function funnelHtml(b: Briefing): string {
  const rows = b.funnel.conversions.map((c) => `<tr><td>${esc(c.from)} &rarr; ${esc(c.to)}</td><td>${esc(formatRate(c.rate, c.n))}</td></tr>`).join("");
  const notes = [b.funnel.sampleWarning, ...b.funnel.hypotheses].filter(Boolean).map((h) => `<li>${esc(h!)}</li>`).join("");
  return `<h2>Funnel</h2><table><tr><th>Stage</th><th>Conversion</th></tr>${rows}</table><ul>${notes}</ul>`;
}

export function rankedHtml(rows: readonly RankingRecord[], now: string, a?: ActionOptions): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td><a href="/o/${esc(r.opportunityId)}">${esc(r.company)} - ${esc(r.title)}</a></td><td>${r.priority}</td><td>${Math.round(r.fit)}</td><td>${Math.round(r.roi)}</td><td>${esc(r.confidence)}</td><td>${esc(r.postingState)}</td><td>${esc(r.pursuitState)}</td><td>${esc(age(r.datePosted, now))}</td><td>${actions(r.opportunityId, a, [["shortlisted", "+"], ["skipped", "x"]])}</td></tr>`,
    )
    .join("");
  return `<table><tr><th>Posting</th><th>P</th><th>Fit</th><th>ROI</th><th>Basis</th><th>Posting</th><th>Pursuit</th><th>Age</th><th></th></tr>${body}</table>`;
}
