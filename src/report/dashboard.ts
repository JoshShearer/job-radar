import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SourcesConfig } from "../config/schema.js";
import type { EnrichedJob } from "../model/job.js";
import type { JobRepo } from "../db/repo.js";
import { buildFunnel, MIN_SAMPLE, type FunnelReport } from "../stats/funnel.js";
import { FUNNEL_STAGES, GHOSTED_AFTER_DAYS, nextAction, STALE_AFTER_DAYS } from "../model/status.js";
import { escapeHtml, renderPage } from "./html.js";
import { paths } from "../config/load.js";

/**
 * The cumulative view: is this working, and where is it stalling.
 *
 * The briefing answers "what should I look at today" and deliberately shows
 * only NEW work. Nothing answered the other question, and every number needed
 * to answer it already existed in `src/stats/funnel.ts` - it just lived in
 * terminal output, while the thing actually opened every morning is an HTML
 * file.
 *
 * Three rules hold this page together, and all three are about not lying with
 * a layout:
 *
 *   1. A percentage never appears without the sample it came from. `formatRate`
 *      is the only thing that renders one, and it always appends `(n=…)`.
 *   2. Below the sample floor there is no chart. A line through one point looks
 *      like a trend and is not one.
 *   3. Nothing here is computed that is not in the database. No projections, no
 *      industry benchmarks next to the real rates, no placeholder that happens
 *      to look plausible.
 */

/**
 * Minimum applications before a trend line means anything.
 *
 * The funnel's own floor, imported rather than restated. If the page drew a
 * chart at a threshold the diagnosis section disagreed with, it would print a
 * warning that the numbers are noise directly above a picture of them.
 */
const TREND_MIN_SAMPLE = MIN_SAMPLE.applied;

export interface DashboardInput {
  repo: JobRepo;
  sources: SourcesConfig;
  now?: Date;
}

export function buildDashboard(input: DashboardInput): string {
  const { repo, sources } = input;
  const now = input.now ?? new Date();

  const counts = repo.counts();
  const funnel = buildFunnel(repo);
  const inFlight = repo.inFlight();
  const transitions = repo.statusTransitions();

  const body = [
    `<h1>Job Radar</h1>`,
    `<p class="lede">Cumulative view. The daily slate is <a href="latest-briefing.html">the briefing</a>.</p>`,
    renderTiles(counts, funnel, inFlight),
    renderDiagnosis(funnel),
    renderFunnelSection(funnel),
    renderTrend(transitions, funnel.stageCounts.APPLIED),
    renderInFlight(inFlight, now),
    renderAttribution(sources, inFlight),
    `<footer>Generated ${escapeHtml(now.toISOString())} by job-radar. Every number on this page is`,
    `counted from the local database. Nothing here changes anything; the CLI does that.</footer>`,
  ].join("\n");

  return renderPage(`Job Radar - dashboard`, body, DASHBOARD_CSS);
}

// ---- tiles ----------------------------------------------------------------

function renderTiles(
  counts: Record<string, number>,
  funnel: FunnelReport,
  inFlight: EnrichedJob[],
): string {
  // Reached-screen is `stageCounts.SCREEN` on its own, never a sum of the
  // later stages. `stagesReached` is cumulative, so one job that got an offer
  // already contributes to SCREEN, INTERVIEW, FINAL and OFFER alike - adding
  // them would report four replies for one conversation.
  const tiles: { label: string; value: number; note: string }[] = [
    { label: "Jobs found", value: counts.total ?? 0, note: "everything ever ingested" },
    { label: "Passed filters", value: counts.passedFilters ?? 0, note: "cleared the hard filters" },
    { label: "Analyzed", value: counts.analyzed ?? 0, note: "had a paid LLM read" },
    { label: "Applied", value: funnel.stageCounts.APPLIED, note: "reached APPLIED or beyond" },
    { label: "In flight", value: inFlight.length, note: "live and waiting on someone" },
    { label: "Reached screen", value: funnel.stageCounts.SCREEN, note: "got past the application" },
    { label: "Offers", value: funnel.stageCounts.OFFER, note: "offer on the table or taken" },
  ];

  const cards = tiles
    .map(
      (t) =>
        `<div class="tile"><div class="tile-v">${t.value}</div>` +
        `<div class="tile-l">${escapeHtml(t.label)}</div>` +
        `<div class="tile-n">${escapeHtml(t.note)}</div></div>`,
    )
    .join("\n");

  return [
    `<h2>At a glance</h2>`,
    `<div class="tiles">${cards}</div>`,
    // Stated on the page rather than in a comment, because the number is
    // otherwise quietly wrong in a way the reader cannot see.
    `<p class="caveat">"Reached screen" counts jobs whose recorded status got to SCREEN or further.`,
    `A job marked REJECTED or GHOSTED is credited only as far as APPLIED, so a rejection that came`,
    `after a real screen shows up here only if that interview was logged with`,
    `<code>job-radar interview add</code>.</p>`,
  ].join("\n");
}

// ---- diagnosis ------------------------------------------------------------

function renderDiagnosis(funnel: FunnelReport): string {
  const L: string[] = [`<h2>Diagnosis</h2>`];

  // The tool's own statement that its numbers are noise belongs above the
  // numbers, not buried under them.
  if (funnel.sampleWarning) {
    L.push(`<div class="warn">${escapeHtml(funnel.sampleWarning)}</div>`);
  }
  for (const h of funnel.hypotheses) {
    L.push(`<div class="hypothesis">${escapeHtml(h)}</div>`);
  }
  if (!funnel.sampleWarning && funnel.hypotheses.length === 0) {
    L.push(`<p class="muted">No diagnosis available.</p>`);
  }
  return L.join("\n");
}

// ---- funnel ---------------------------------------------------------------

/**
 * The only thing in this file that renders a percentage.
 *
 * `100%` from one application is noise wearing the costume of a result, so the
 * sample size is not optional and there is no second code path that could omit
 * it. A null rate means the stage above it is empty; that is `n/a`, not `0%`.
 */
export function formatRate(rate: number | null, n: number): string {
  if (rate === null) return `n/a (n=${n})`;
  const pct = Math.round(rate * 100);
  // 1 of 6919 rounds to 0%, and printing "0%" says nobody converted when
  // somebody did. The distinction between "none" and "too few to round to one
  // percent" is exactly the kind this page is supposed to preserve.
  if (pct === 0 && rate > 0) return `<1% (n=${n})`;
  return `${pct}% (n=${n})`;
}

function renderFunnelSection(funnel: FunnelReport): string {
  const top = funnel.stageCounts.DISCOVERED || 1;
  const rows = FUNNEL_STAGES.map((stage) => {
    const count = funnel.stageCounts[stage];
    // Bar width is a proportion of the widest stage, which is always the first.
    // It is decoration on top of the printed count, never a substitute for it.
    const pct = Math.max(count > 0 ? 0.6 : 0, (count / top) * 100);
    const conv = funnel.conversions.find((c) => c.to === stage);
    return (
      `<tr><th scope="row">${stage}</th>` +
      `<td class="num">${count}</td>` +
      `<td class="barcell"><span class="bar" style="width:${pct.toFixed(2)}%"></span></td>` +
      `<td class="rate">${conv ? escapeHtml(formatRate(conv.rate, conv.n)) : "&mdash;"}</td></tr>`
    );
  }).join("\n");

  return [
    `<h2>Funnel</h2>`,
    `<table class="funnel">`,
    `<tr><th>Stage</th><th class="num">Jobs</th><th></th><th class="rate">From the stage above</th></tr>`,
    rows,
    `</table>`,
  ].join("\n");
}

// ---- trend ----------------------------------------------------------------

/**
 * The Monday of the week `iso` falls in, as a UTC date string.
 *
 * Deliberately not an ISO week number. A `${year}-W${week}` key needs the ISO
 * week-YEAR, not the calendar year, or 2026-12-31 buckets as `2026-W01` and
 * lands beside the previous January. A Monday date has no week-year to get
 * wrong, sorts lexically, and reads as a date.
 */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.getUTCDay(); // 0 = Sunday
  const backToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - backToMonday));
  return monday.toISOString().slice(0, 10);
}

const RESPONSE_STATUSES = new Set(["SCREEN", "INTERVIEW", "FINAL", "OFFER"]);

export interface WeekBucket {
  week: string;
  applications: number;
  responses: number;
}

/**
 * Roles applied to, and roles that first heard back, per week. Oldest first.
 *
 * Counted **once per job**, not once per event. The event log is a log: a job
 * re-marked APPLIED after a correction has two APPLIED rows, and a job that
 * goes SCREEN then INTERVIEW has two response rows. Counting rows made the real
 * database render 26 applications in the trend beside 23 in the tile - both
 * arithmetically true, describing different things, with nothing on the page to
 * tell the reader which question either was answering.
 *
 * So each job contributes at most one application, in the week it was first
 * applied to, and at most one response, in the week they first replied. That is
 * what "applications per week" means to the person reading it, and it
 * reconciles with the tiles above.
 *
 * `transitions` must be oldest first; `repo.statusTransitions` guarantees it.
 */
export function bucketByWeek(transitions: { jobId: string; to: string; at: string }[]): WeekBucket[] {
  const weeks = new Map<string, WeekBucket>();
  const applied = new Set<string>();
  const responded = new Set<string>();

  const bucketFor = (week: string) => {
    const existing = weeks.get(week);
    if (existing) return existing;
    const fresh = { week, applications: 0, responses: 0 };
    weeks.set(week, fresh);
    return fresh;
  };

  for (const t of transitions) {
    const isApplication = t.to === "APPLIED" && !applied.has(t.jobId);
    const isResponse = RESPONSE_STATUSES.has(t.to) && !responded.has(t.jobId);
    if (!isApplication && !isResponse) continue;

    const week = weekStart(t.at);
    if (!week) continue;
    if (isApplication) {
      applied.add(t.jobId);
      bucketFor(week).applications += 1;
    }
    if (isResponse) {
      responded.add(t.jobId);
      bucketFor(week).responses += 1;
    }
  }
  return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
}

function renderTrend(
  transitions: { jobId: string; to: string; at: string }[],
  appliedTotal: number,
): string {
  const buckets = bucketByWeek(transitions);

  // No chart below the floor. The sample warning already says the rates are
  // noise; drawing them anyway would contradict it in the more persuasive
  // medium, and the picture is what people remember.
  if (appliedTotal < TREND_MIN_SAMPLE) {
    return [
      `<h2>Over time</h2>`,
      `<p class="muted">Not enough data yet (n=${appliedTotal} applications, ${TREND_MIN_SAMPLE} needed).`,
      `A line through this many points would look like a trend without being one.`,
      `${buckets.length} week${buckets.length === 1 ? "" : "s"} of history recorded so far.</p>`,
    ].join("\n");
  }

  const peak = Math.max(...buckets.map((b) => Math.max(b.applications, b.responses)), 1);
  const rows = buckets
    .map(
      (b) =>
        `<tr><th scope="row">${escapeHtml(b.week)}</th>` +
        `<td class="barcell"><span class="bar" style="width:${((b.applications / peak) * 100).toFixed(2)}%"></span></td>` +
        `<td class="num">${b.applications}</td>` +
        `<td class="barcell"><span class="bar alt" style="width:${((b.responses / peak) * 100).toFixed(2)}%"></span></td>` +
        `<td class="num">${b.responses}</td></tr>`,
    )
    .join("\n");

  return [
    `<h2>Over time</h2>`,
    `<table class="trend">`,
    `<tr><th>Week of</th><th></th><th class="num">Applied</th><th></th><th class="num">Replies</th></tr>`,
    rows,
    `</table>`,
    `<p class="muted">Weeks start Monday, counted in UTC. Each role counts once, in the week it was`,
    `first applied to and the week they first replied, so a role applied to in one week and answered`,
    `in another appears in both columns but never twice in either.</p>`,
  ].join("\n");
}

// ---- in flight ------------------------------------------------------------

function daysSince(iso: string | null, now: Date): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000));
}

function renderInFlight(jobs: EnrichedJob[], now: Date): string {
  if (jobs.length === 0) {
    return [
      `<h2>In flight</h2>`,
      `<p class="muted">Nothing submitted or in progress.</p>`,
    ].join("\n");
  }

  const rows = jobs
    .map((j) => {
      const days = daysSince(j.statusChangedAt, now);
      const stale = days >= (STALE_AFTER_DAYS[j.status] ?? 7);
      const ghosted = days >= GHOSTED_AFTER_DAYS;
      const flag = ghosted ? "ghosted" : stale ? "stale" : "";
      const role = `${escapeHtml(j.company)} - ${escapeHtml(j.title)}`;
      // Linked to the posting, same as the briefing. An anchor is navigation
      // the reader chooses; it is not a request this page makes on open, so it
      // does not compromise the self-contained property.
      const url = j.applicationUrl ?? j.sourceUrl;
      const cell = url ? `<a href="${escapeHtml(url)}" rel="noreferrer">${role}</a>` : role;
      return (
        `<tr class="${flag}"><td>${escapeHtml(j.status)}</td>` +
        `<td>${cell}</td>` +
        `<td class="num">${days}d</td>` +
        `<td class="muted">${escapeHtml(nextAction(j.status, days))}</td></tr>`
      );
    })
    .join("\n");

  const stale = jobs.filter((j) => daysSince(j.statusChangedAt, now) >= (STALE_AFTER_DAYS[j.status] ?? 7));

  return [
    `<h2>In flight</h2>`,
    stale.length
      ? `<p class="warn">${stale.length} of ${jobs.length} ha${stale.length === 1 ? "s" : "ve"} gone quiet. ` +
        `Record the outcome: <code>job-radar inflight --stale</code></p>`
      : "",
    `<table class="inflight">`,
    `<tr><th>Status</th><th>Role</th><th class="num">Age</th><th>What now</th></tr>`,
    rows,
    `</table>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- attribution ----------------------------------------------------------

/**
 * Required by the Remote OK API terms: a followed link back, naming them as the
 * source. Emitted when the source is enabled OR when a displayed job came from
 * it. Over-attributing costs one line; under-attributing breaks the terms we
 * use their feed under.
 */
function renderAttribution(sources: SourcesConfig, shown: EnrichedJob[]): string {
  const enabled = sources.sources.remoteok?.enabled === true;
  const displayed = shown.some((j) => j.source === "remoteok");
  if (!enabled && !displayed) return "";
  return [
    `<hr>`,
    `<p class="muted">Some listings counted here were sourced from`,
    `<a href="https://remoteok.com" rel="noreferrer">Remote OK</a>.`,
    `Remote OK is the source for those postings.</p>`,
  ].join("\n");
}

// ---- styling --------------------------------------------------------------

const DASHBOARD_CSS = `
  p.lede { color: var(--muted); margin: -0.75rem 0 2rem; }
  p.caveat, p.muted { color: var(--muted); font-size: .88rem; }
  .tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; }
  .tile-v { font-size: 1.9rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
  .tile-l { font-size: .82rem; font-weight: 600; margin-top: .25rem; }
  .tile-n { font-size: .74rem; color: var(--muted); margin-top: .15rem; }
  .warn { background: var(--code-bg); border-left: 3px solid var(--yellow); border-radius: 0 6px 6px 0;
          padding: .8rem 1rem; margin: 0 0 1rem; font-size: .9rem; }
  .hypothesis { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
                padding: .9rem 1rem; margin: 0 0 .75rem; font-size: .9rem; }
  table.funnel td, table.trend td, table.inflight td,
  table.funnel th, table.trend th, table.inflight th { vertical-align: middle; }
  table.funnel td:first-child, table.trend td:first-child, table.inflight td:first-child {
    color: inherit; width: auto; white-space: nowrap; }
  table.funnel th[scope=row], table.trend th[scope=row] {
    text-transform: none; letter-spacing: 0; font-size: .85rem; color: var(--fg);
    border-bottom: 1px solid var(--line); white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.rate, th.rate { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap;
                     font-size: .84rem; color: var(--muted); }
  td.barcell { width: 45%; }
  .bar { display: block; height: .55rem; border-radius: 3px; background: var(--accent); opacity: .75; }
  .bar.alt { background: var(--green); }
  tr.stale td { background: color-mix(in srgb, var(--yellow) 9%, transparent); }
  tr.ghosted td { background: color-mix(in srgb, var(--red) 9%, transparent); }
`;

/** Write the dashboard as the landing page. Returns the path. */
export function writeDashboard(html: string, dir = paths.reports()): string {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "latest.html");
  writeFileSync(file, html, "utf8");
  return file;
}
