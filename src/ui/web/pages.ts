import type { AppContext } from "../../app/context.js";
import type { Briefing } from "../../app/briefing.js";
import { RANKING_SORT_KEYS, type ArtifactRecord, type RankingFilter, type RankingRecord, type RankingSortKey } from "../../ports/records.js";
import { applicationFold, applicationViews, pursuitOf } from "../../app/pursuit.js";
import { basisNote, spendFor, spendSummary } from "../../app/spend.js";
import { mailCoverageSpan } from "../../app/mail.js";
import { APPLICATION_STATES, nextAction, PURSUIT_STATES, type ApplicationState } from "../../domain/pursuit/machines.js";
import { PRIORITIES, type Priority } from "../../domain/evaluation/priority.js";
import { formatRate } from "../../domain/pursuit/funnel.js";
import { externalLink } from "../reports/render.js";
import { BAND_WORDS, BASIS_WORDS, bar, daysAgo, esc, GRADE_NAMES, localDay, markdown, postForm, pursueButton, shortDate, stateTag } from "./html.js";

/**
 * Page bodies. Each takes what it shows and returns markup for the shell;
 * the server owns routing, access and the shell itself. Reads go through the
 * same store and use cases as the CLI; nothing here computes a score.
 */

export interface PageContext {
  ctx: AppContext;
  csrf: string;
  /** The path (with query) of the page being rendered: where a form comes back to. */
  here: string;
}

const OUTCOME_STATES = APPLICATION_STATES.filter((s) => s !== "submitted");
const CLOSED_APPLICATION_STATES: readonly ApplicationState[] = ["rejected", "withdrawn", "ghosted"];

function gradeBlock(r: RankingRecord): string {
  return `<div class="grade grade-${esc(r.priority)}">
<span class="letter" aria-hidden="true">${esc(r.priority)}</span>
<span class="visually-hidden">Priority ${esc(r.priority)}:</span>
<span class="grade-name">${esc(GRADE_NAMES[r.priority])}</span>
<span class="scores"><span><b>${Math.round(r.fit)}</b> fit</span><span><b>${Math.round(r.roi)}</b> roi</span></span>
<span class="grade-name">${esc(BASIS_WORDS[r.confidence])} basis</span>
</div>`;
}

function facts(r: RankingRecord, now: Date): string {
  const remote = r.remoteStatus && r.remoteStatus !== "unknown" && !r.location.toLowerCase().includes(r.remoteStatus.toLowerCase()) ? `, ${r.remoteStatus}` : "";
  const where = `${r.location}${remote}`;
  return `<dl class="facts">
<div><dt>Where</dt><dd>${esc(where)}</dd></div>
<div><dt>Posted</dt><dd>${esc(daysAgo(r.datePosted, now))}</dd></div>
<div><dt>Pay</dt><dd>${esc(r.detail.salary)} <span class="band band-${esc(r.compBand)}">${esc(BAND_WORDS[r.compBand] ?? r.compBand)}</span></dd></div>
<div><dt>Lane</dt><dd>${esc(r.lane.replace(/_/g, " "))}</dd></div>
</dl>`;
}

function analystLine(r: RankingRecord): string {
  if (r.analystRec) {
    return `<p class="analyst"><strong>Analyst, ${esc(r.analystTier ?? "assessment")}:</strong> ${esc(r.analystRec.replace(/_/g, " "))}. ${esc(r.detail.analystSummary ?? "")}</p>`;
  }
  if (r.staleAssessment) return `<p class="analyst muted">An earlier assessment exists, but the posting or the evidence changed since. It does not count.</p>`;
  return `<p class="analyst muted">Not assessed. Ranked on ${esc(BASIS_WORDS[r.confidence])} fit.</p>`;
}

function signals(r: RankingRecord, limits = { plus: 4, minus: 3 }): string {
  const plus = r.detail.positiveSignals.slice(0, limits.plus).map((s) => `<li class="plus">${esc(s)}</li>`);
  const minus = r.detail.negativeSignals
    .filter((x) => !x.startsWith("WARNING"))
    .slice(0, limits.minus)
    .map((s) => `<li class="minus">${esc(s)}</li>`);
  return plus.length || minus.length ? `<ul class="signals">${plus.join("")}${minus.join("")}</ul>` : "";
}

/* -------------------------------------------------------------------- today */

export function todayPage(p: PageContext, b: Briefing): string {
  const now = new Date(b.generatedAt);
  const P: string[] = [];
  const day = now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
  P.push(`<h1 class="dateline">${esc(day)}</h1>`);
  const waiting = b.silence.filter((s) => s.kind === "suggest_ghosted").length;
  const inFlight = inFlightApplications(b);
  const lede = b.slate.length
    ? `${b.slate.length === 1 ? "One new posting clears" : `${b.slate.length} new postings clear`} the bar today.`
    : "Nothing new clears the bar today. A short slate is the intended result, not a failure.";
  const more = [
    b.pursuing.length ? `${b.pursuing.length} on your shortlist` : "",
    inFlight.length ? `${inFlight.length} ${inFlight.length === 1 ? "application" : "applications"} in flight` : "",
    waiting ? `${waiting} gone quiet` : "",
  ].filter(Boolean);
  P.push(`<p class="lede">${esc(lede)}${more.length ? ` ${esc(sentenceList(more))}.` : ""}</p>`);

  const warn = b.health.filter((h) => h.level === "warn");
  if (warn.length) {
    const what = warn.length === 1 ? "One thing" : `${warn.length} things`;
    P.push(`<details class="check-first" open><summary>${what} to check before trusting this list</summary><ul>${warn.map((h) => `<li>${codeText(h.text)}</li>`).join("")}</ul><p><a href="/system">See system health</a></p></details>`);
  }

  if (b.slate.length) {
    P.push(`<h2 class="section-title">Worth a look</h2><p class="section-note">Ranked by return on effort, spread across companies. Shortlist what you would apply to, skip what you would not.</p>`);
    P.push(`<div class="slate">${b.slate.map((r) => slateEntry(p, r, now)).join("")}</div>`);
  }

  if (b.pursuing.length) {
    P.push(`<h2 class="section-title">On your shortlist</h2><div class="table-wrap"><table><tr><th>Posting</th><th>State</th><th class="num">Days</th><th>Next</th></tr>`);
    for (const x of b.pursuing) {
      P.push(
        `<tr><td><a class="row-link" href="/o/${esc(x.row.opportunityId)}">${esc(x.row.title)}</a><span class="sub">${esc(x.row.company)}</span></td><td>${stateTag(x.state)}</td><td class="num">${x.days}</td><td>${esc(x.action)}</td></tr>`,
      );
    }
    P.push(`</table></div>`);
  }

  if (inFlight.length) {
    P.push(`<h2 class="section-title">Waiting on employers</h2><div class="table-wrap"><table><tr><th>Application</th><th>State</th><th class="num">Days</th><th>Next</th></tr>`);
    for (const a of inFlight) {
      P.push(
        `<tr><td><a class="row-link" href="/o/${esc(a.opportunityId)}">${esc(a.title)}</a><span class="sub">${esc(a.company)}</span></td><td>${stateTag(a.state)}</td><td class="num">${a.days}</td><td>${esc(a.action)}</td></tr>`,
      );
    }
    P.push(`</table></div>`);
  }

  if (b.silence.length) {
    P.push(`<h2 class="section-title">Needs an outcome</h2><p class="section-note">Silence counts only while mail was being read. Nothing is marked ghosted unless you mark it.</p><div class="table-wrap"><table><tr><th>Application</th><th class="num">Quiet</th><th></th></tr>`);
    for (const s of b.silence) {
      const action =
        s.kind === "suggest_ghosted"
          ? postForm("/act/outcome", p.csrf, p.here, { app: s.app.id, to: "ghosted" }, `<button class="small">Mark ghosted</button>`)
          : `<span class="muted">Not observed: ${esc(s.why ?? "mail was not read")}</span>`;
      P.push(
        `<tr><td><a class="row-link" href="/o/${esc(s.app.opportunityId)}">${esc(s.app.title)}</a><span class="sub">${esc(s.app.company)}</span></td><td class="num">${Math.round(s.days)} days</td><td>${action}</td></tr>`,
      );
    }
    P.push(`</table></div>`);
  }

  P.push(
    `<p class="section-note">${b.counts.opportunities.toLocaleString("en-US")} postings tracked, ${b.counts.eligible.toLocaleString("en-US")} eligible, ${b.counts.assessed} assessed by the analyst. Today's model spend is $${b.spend.day.committed.toFixed(2)} of $${b.spend.budgets.perDay.toFixed(2)}${esc(basisNote(b.spend.day))}.</p>`,
  );
  return P.join("\n");
}

/** Applications still waiting on an employer. Ghosted ones stay foldable (a reply revives them) but are not in flight. */
export function inFlightApplications(b: Briefing): Briefing["applications"] {
  return b.applications.filter((a) => a.state !== "ghosted");
}

/** Escaped text with `backticked` spans set as code, the way the briefing writes commands. */
function codeText(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function sentenceList(xs: string[]): string {
  const s = xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function slateEntry(p: PageContext, r: RankingRecord, now: Date): string {
  const id = r.opportunityId;
  return `<article class="posting grade-${esc(r.priority)}" aria-labelledby="t-${esc(id)}">
${gradeBlock(r)}
<div class="body">
<p class="company">${esc(r.company)}</p>
<h3 id="t-${esc(id)}"><a href="/o/${esc(id)}">${esc(r.title)}</a></h3>
${facts(r, now)}
${analystLine(r)}
${signals(r)}
<div class="actions">
${pursueButton(p.csrf, p.here, id, "shortlisted", "Shortlist", "primary")}
${r.pursuitState === "reviewed" ? "" : pursueButton(p.csrf, p.here, id, "reviewed", "Mark reviewed", "")}
${pursueButton(p.csrf, p.here, id, "skipped", "Skip", "quiet")}
<span class="ext">${externalLink(r.detail.applicationUrl ?? r.detail.url, "Open the posting")}</span>
</div>
</div>
</article>`;
}

/* ------------------------------------------------------------------- ranked */

export interface RankedQuery {
  q: string;
  priorities: Priority[];
  pursuit: string;
  posting: string;
  lane: string;
  evergreen: boolean;
  ineligible: boolean;
  sort: RankingSortKey;
  dir: "asc" | "desc";
  page: number;
}

const PURSUIT_VIEWS: Record<string, { label: string; states: readonly string[] | undefined }> = {
  active: { label: "New, reviewed or shortlisted", states: ["new", "reviewed", "shortlisted"] },
  all: { label: "Any", states: undefined },
  ...Object.fromEntries(PURSUIT_STATES.map((s) => [s, { label: s.charAt(0).toUpperCase() + s.slice(1), states: [s] }])),
};
const POSTING_VIEWS: Record<string, { label: string; states: readonly string[] | undefined }> = {
  live: { label: "Open or not yet swept", states: ["open", "unknown"] },
  all: { label: "Any", states: undefined },
  open: { label: "Open", states: ["open"] },
  missing: { label: "Missing from the last sweep", states: ["missing"] },
  closed: { label: "Closed", states: ["closed"] },
};
export const PAGE_SIZE = 50;

/**
 * How each sortable column reads, and which way it goes on the first click:
 * scores and dates biggest or newest first, words and states from the top of
 * their order. A second click on the active column reverses it.
 */
const SORTS: Record<RankingSortKey, { first: "asc" | "desc"; asc: string; desc: string }> = {
  roi: { first: "desc", asc: "lowest return on effort first", desc: "best return on effort first" },
  fit: { first: "desc", asc: "lowest fit first", desc: "highest fit first" },
  title: { first: "asc", asc: "by title, A to Z", desc: "by title, Z to A" },
  basis: { first: "desc", asc: "keyword basis first", desc: "analyst basis first" },
  posting: { first: "asc", asc: "open postings first", desc: "closed postings first" },
  decision: { first: "asc", asc: "by decision, new first", desc: "by decision, applied first" },
  posted: { first: "desc", asc: "oldest posting first", desc: "newest posting first" },
};
const DEFAULT_SORT: RankingSortKey = "roi";

export function parseRankedQuery(u: URL): RankedQuery {
  const ps = u.searchParams.getAll("p").filter((x): x is Priority => (PRIORITIES as readonly string[]).includes(x));
  const pursuit = u.searchParams.get("pursuit") ?? "active";
  const posting = u.searchParams.get("posting") ?? "live";
  const page = Number(u.searchParams.get("page") ?? "1");
  const sortParam = u.searchParams.get("sort") ?? "";
  const sort = (RANKING_SORT_KEYS as readonly string[]).includes(sortParam) ? (sortParam as RankingSortKey) : DEFAULT_SORT;
  const dirParam = u.searchParams.get("dir");
  const dir = sort !== sortParam ? SORTS[DEFAULT_SORT].first : dirParam === "asc" || dirParam === "desc" ? dirParam : SORTS[sort].first;
  return {
    q: (u.searchParams.get("q") ?? "").slice(0, 100),
    priorities: ps,
    pursuit: pursuit in PURSUIT_VIEWS ? pursuit : "active",
    posting: posting in POSTING_VIEWS ? posting : "live",
    lane: (u.searchParams.get("lane") ?? "").slice(0, 60),
    evergreen: u.searchParams.get("evergreen") === "1",
    ineligible: u.searchParams.get("ineligible") === "1",
    sort,
    dir,
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

export function rankedPage(p: PageContext, query: RankedQuery): string {
  const { ctx } = p;
  const lanes = Object.keys(ctx.config().strategy.lanes);
  const filter: RankingFilter = {
    ...(query.ineligible ? {} : { eligible: true }),
    ...(query.evergreen ? {} : { includeEvergreen: false }),
    ...(PURSUIT_VIEWS[query.pursuit]!.states ? { pursuitStates: PURSUIT_VIEWS[query.pursuit]!.states! } : {}),
    ...(POSTING_VIEWS[query.posting]!.states ? { postingStates: POSTING_VIEWS[query.posting]!.states! } : {}),
    ...(query.priorities.length ? { priorities: query.priorities } : {}),
    ...(query.lane && lanes.includes(query.lane) ? { lane: query.lane } : {}),
    ...(query.q.trim() ? { text: query.q } : {}),
    sort: { key: query.sort, dir: query.dir },
    limit: PAGE_SIZE + 1,
    offset: (query.page - 1) * PAGE_SIZE,
  };
  const fetched = ctx.store.ranking(filter);
  const total = ctx.store.rankingCount(filter);
  const rows = fetched.slice(0, PAGE_SIZE);
  const hasNext = fetched.length > PAGE_SIZE;
  const now = ctx.clock.now();

  const opt = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
  const chips = PRIORITIES.map(
    (g) => `<label title="${esc(GRADE_NAMES[g])}"><input type="checkbox" name="p" value="${g}"${query.priorities.includes(g) ? " checked" : ""}><span>${g}</span></label>`,
  ).join("");
  const P: string[] = [];
  P.push(`<h1 class="page-title">Ranked</h1>`);
  P.push(`<form class="filters" method="get" action="/ranked" role="search">
<div><label for="f-q">Company or title</label><input type="search" id="f-q" name="q" value="${esc(query.q)}"></div>
<fieldset><legend>Priority</legend><div class="chips">${chips}</div></fieldset>
<div><label for="f-pursuit">Your decision</label><select id="f-pursuit" name="pursuit">${Object.entries(PURSUIT_VIEWS).map(([k, v]) => opt(k, v.label, query.pursuit)).join("")}</select></div>
<div><label for="f-posting">Posting</label><select id="f-posting" name="posting">${Object.entries(POSTING_VIEWS).map(([k, v]) => opt(k, v.label, query.posting)).join("")}</select></div>
<div><label for="f-lane">Lane</label><select id="f-lane" name="lane">${opt("", "Any lane", query.lane)}${lanes.map((l) => opt(l, l, query.lane)).join("")}</select></div>
<div class="stack">
<label class="check"><input type="checkbox" name="evergreen" value="1"${query.evergreen ? " checked" : ""}> Include evergreen postings</label>
<label class="check"><input type="checkbox" name="ineligible" value="1"${query.ineligible ? " checked" : ""}> Include ineligible postings</label>
</div>
${isDefaultSort(query) ? "" : `<input type="hidden" name="sort" value="${esc(query.sort)}"><input type="hidden" name="dir" value="${esc(query.dir)}">`}
<div><button class="primary">Filter</button></div>
<a class="reset" href="/ranked">Clear filters</a>
</form>`);
  if (!rows.length) {
    P.push(`<p class="section-note">No postings match these filters. Widen the decision or posting filter, or clear them.</p>`);
    return P.join("\n");
  }
  const first = (query.page - 1) * PAGE_SIZE + 1;
  P.push(`<p class="section-note">Showing ${first} to ${first + rows.length - 1} of ${total.toLocaleString("en-US")}, ${esc(SORTS[query.sort][query.dir])}.</p>`);
  const th = (key: RankingSortKey, label: string, cls = "") => {
    const active = query.sort === key;
    const dir = active ? (query.dir === "asc" ? "desc" : "asc") : SORTS[key].first;
    const u = new URL(p.here, "http://x");
    u.searchParams.delete("page");
    u.searchParams.delete("f");
    if (key === DEFAULT_SORT && dir === SORTS[DEFAULT_SORT].first) {
      u.searchParams.delete("sort");
      u.searchParams.delete("dir");
    } else {
      u.searchParams.set("sort", key);
      u.searchParams.set("dir", dir);
    }
    const arrow = active ? `<span class="sort-dir" aria-hidden="true">${query.dir === "asc" ? "\u2191" : "\u2193"}</span>` : "";
    const aria = active ? ` aria-sort="${query.dir === "asc" ? "ascending" : "descending"}"` : "";
    return `<th${cls ? ` class="${cls}"` : ""}${aria}><a class="sort" href="${esc(`${u.pathname}${u.search}`)}" title="Sort ${esc(SORTS[key][dir])}">${esc(label)}${arrow}</a></th>`;
  };
  P.push(
    `<div class="table-wrap"><table><tr><th><span class="visually-hidden">Priority</span></th>${th("title", "Posting")}${th("fit", "Fit", "num")}${th("roi", "ROI", "num")}${th("basis", "Basis")}${th("posting", "Posting")}${th("decision", "Decision")}${th("posted", "Posted")}<th><span class="visually-hidden">Actions</span></th></tr>`,
  );
  for (const r of rows) {
    const quick =
      r.pursuitState === "new" || r.pursuitState === "reviewed"
        ? `${pursueButton(p.csrf, p.here, r.opportunityId, "shortlisted", "Shortlist", "small")} ${pursueButton(p.csrf, p.here, r.opportunityId, "skipped", "Skip", "small quiet")}`
        : "";
    P.push(
      `<tr><td><span class="mini-grade grade-${esc(r.priority)}" title="${esc(GRADE_NAMES[r.priority])}">${esc(r.priority)}</span></td><td><a class="row-link" href="/o/${esc(r.opportunityId)}">${esc(r.title)}</a><span class="sub">${esc(r.company)}, ${esc(r.location)}</span></td><td class="num">${Math.round(r.fit)}</td><td class="num">${Math.round(r.roi)}</td><td>${esc(BASIS_WORDS[r.confidence])}</td><td>${esc(r.postingState)}</td><td>${stateTag(r.pursuitState)}</td><td class="nowrap">${esc(daysAgo(r.datePosted, now))}</td><td class="nowrap">${quick}</td></tr>`,
    );
  }
  P.push(`</table></div>`);
  const link = (page: number) => {
    const u = new URL(p.here, "http://x");
    u.searchParams.set("page", String(page));
    return `${u.pathname}${u.search}`;
  };
  P.push(
    `<nav class="pager" aria-label="Pages">${query.page > 1 ? `<a href="${esc(link(query.page - 1))}">Previous ${PAGE_SIZE}</a>` : ""}${hasNext ? `<a href="${esc(link(query.page + 1))}">Next ${PAGE_SIZE}</a>` : ""}</nav>`,
  );
  return P.join("\n");
}

function isDefaultSort(q: RankedQuery): boolean {
  return q.sort === DEFAULT_SORT && q.dir === SORTS[DEFAULT_SORT].first;
}

/* ------------------------------------------------------------------ posting */

export function postingPage(p: PageContext, r: RankingRecord): string {
  const { ctx } = p;
  const id = r.opportunityId;
  const now = ctx.clock.now();
  const pursuit = pursuitOf(ctx, id);
  const apps = ctx.store.applications(id);
  const gens = ctx.store.artifacts(id);
  const spent = spendFor(ctx, id);
  const overrides = ctx.store.overrides(id);
  const P: string[] = [];

  P.push(`<header class="posting-head grade-${esc(r.priority)}">
${gradeBlock(r)}
<div><p class="company">${esc(r.company)}</p><h1>${esc(r.title)}</h1>${facts(r, now)}
<p>${externalLink(r.detail.applicationUrl ?? r.detail.url, "Open the posting")} <span class="muted">Listed in ${r.detail.aliases} ${r.detail.aliases === 1 ? "place" : "places"}; posting ${esc(r.postingState)}.</span></p></div>
</header>`);

  // ---- main column
  const M: string[] = [];
  M.push(analystLine(r));
  if (r.detail.reasons.length) M.push(`<h2 class="section-title">Why it is not eligible</h2><ul class="reasons">${r.detail.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  if (r.detail.warnings.length) M.push(`<h2 class="section-title">Warnings</h2><ul>${r.detail.warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  M.push(signals(r, { plus: 12, minus: 12 }));
  M.push(`<h2 class="section-title">Why it ranks here</h2><p class="section-note">The deterministic explanation, exactly as the ranking computed it.</p><div class="explanation">${esc(r.detail.explanation)}</div>`);
  if (r.detail.compensationNote) M.push(`<p class="section-note">${esc(r.detail.compensationNote)}</p>`);

  // ---- side column
  const S: string[] = [];
  S.push(`<section class="panel"><h2>Scores</h2>${scoreMeters(r)}</section>`);

  const decide: string[] = [];
  if (pursuit.state !== "applied") {
    const moves: Array<[string, string, string]> = [
      ["shortlisted", "Shortlist", "primary"],
      ["preparing", "Mark preparing", ""],
      ["reviewed", "Mark reviewed", ""],
      ["skipped", "Skip", "quiet"],
    ];
    decide.push(`<div class="actions">${moves.filter(([to]) => to !== pursuit.state).map(([to, label, cls]) => pursueButton(p.csrf, p.here, id, to, label, cls)).join("")}</div>`);
    if (!apps.length) decide.push(`<p><a href="/o/${esc(id)}/submit">Record that you submitted it</a></p>`);
  }
  S.push(`<section class="panel"><h2>Your decision</h2><p>Currently ${stateTag(pursuit.state)}${pursuit.since ? ` since ${esc(shortDate(pursuit.since))}` : ""}.</p>${decide.join("")}
${pursuit.steps.length ? `<ol class="history">${pursuit.steps.map((s) => `<li${s.applied ? "" : ' class="not-applied"'}><time>${esc(shortDate(s.event.occurredAt))}, ${esc(s.event.actor)}</time>${esc(s.event.to)}${s.applied ? "" : ` (not applied: ${esc(s.reason ?? "")})`}${s.event.note ? ` <span class="muted">${esc(s.event.note)}</span>` : ""}</li>`).join("")}</ol>` : ""}</section>`);

  for (const a of apps) S.push(applicationPanel(p, a.id, a.submittedAt));

  if (gens.length) {
    S.push(
      `<section class="panel"><h2>Documents</h2><ul>${gens
        .map((g) => `<li><a href="/o/${esc(id)}/g/${esc(g.id)}">${g.kind === "pack" ? "Application pack" : "Resume"}, ${esc(shortDate(g.createdAt))}</a>${g.kind === "pack" ? (g.approvedAt ? ' <span class="approved">approved</span>' : ' <span class="muted">not approved</span>') : ""}</li>`)
        .join("")}</ul></section>`,
    );
  }
  S.push(
    `<section class="panel"><h2>From the command line</h2><p>Tailoring, preparing, filling and anything that spends money run from the CLI on the host: <code>jr tailor ${esc(id)}</code>, <code>jr prepare ${esc(id)}</code>, <code>jr fill ${esc(id)}</code>.</p><p class="muted">Spent on this posting so far: $${spent.usd.toFixed(4)} over ${spent.calls} ${spent.calls === 1 ? "call" : "calls"}${esc(basisNote(spent))}.</p>${
      overrides.length ? `<ul>${overrides.map((o) => `<li>Override ${esc(o.gate)} (${esc(o.detail ?? "")}), ${esc(shortDate(o.recordedAt))}</li>`).join("")}</ul>` : ""
    }</section>`,
  );

  P.push(`<div class="split"><div>${M.join("\n")}</div><aside>${S.join("\n")}</aside></div>`);
  return P.join("\n");
}

function scoreMeters(r: RankingRecord): string {
  // Three separate fields, never blended: the one the ranking used is marked.
  const rows: Array<[string, number | null, boolean]> = [
    ["Keyword", r.rawFit, r.confidence === "raw"],
    ["Projected", r.projFit, r.confidence === "projected"],
    ["Analyst", r.analystFit, r.confidence === "analyzed"],
  ];
  const roiRows: Array<[string, number | null, boolean]> = [
    ["Keyword", r.rawRoi, r.confidence === "raw"],
    ["Projected", r.projRoi, r.confidence === "projected"],
    ["Analyst", r.analystRoi, r.confidence === "analyzed"],
  ];
  const grid = (xs: Array<[string, number | null, boolean]>) =>
    `<div class="meters">${xs
      .map(([label, v, used]) => `<span class="label${used ? " used" : ""}">${label}</span>${bar(v)}<span class="val">${v === null ? "none" : Math.round(v)}</span>`)
      .join("")}</div>`;
  return `<p>Fit</p>${grid(rows)}<p>Return on effort</p>${grid(roiRows)}<p class="meter-caption">The bold row is the basis this posting is ranked on. Scores are kept separate; one never overwrites another.</p>`;
}

function applicationPanel(p: PageContext, applicationId: string, submittedAt: string): string {
  const f = applicationFold(p.ctx, applicationId);
  const steps = f.steps
    .map(
      (s) =>
        `<li${s.applied ? "" : ' class="not-applied"'}><time>${esc(shortDate(s.event.occurredAt))}, ${esc(s.event.actor)}</time>${esc(s.event.to)}${s.applied ? "" : ` (not applied: ${esc(s.reason ?? "")})`}${s.event.note ? ` <span class="muted">${esc(s.event.note)}</span>` : ""}</li>`,
    )
    .join("");
  return `<section class="panel"><h2>Application <code>${esc(applicationId)}</code></h2><p>${stateTag(f.state)}, submitted ${esc(shortDate(submittedAt))}.</p>${steps ? `<ol class="history">${steps}</ol>` : ""}${outcomeForm(p, applicationId)}</section>`;
}

/** Record what an employer did. The date defaults to today; nothing here infers it. */
export function outcomeForm(p: PageContext, applicationId: string): string {
  const today = localDay(p.ctx.clock.now());
  const controls = `<div class="record">
<div class="row"><div><label for="o-to-${esc(applicationId)}">What happened</label><select id="o-to-${esc(applicationId)}" name="to">${OUTCOME_STATES.map((s) => `<option value="${s}">${s}</option>`).join("")}</select></div>
<div><label for="o-on-${esc(applicationId)}">When</label><input type="date" id="o-on-${esc(applicationId)}" name="on" value="${today}" max="${today}"></div></div>
<div><label for="o-note-${esc(applicationId)}">Note (optional)</label><input type="text" id="o-note-${esc(applicationId)}" name="note" maxlength="500"></div>
<div><button class="primary">Record outcome</button></div>
</div>`;
  return `<details class="disclose"><summary>Record an outcome</summary>${postForm("/act/outcome", p.csrf, p.here, { app: applicationId }, controls)}</details>`;
}

/* ------------------------------------------------------------ submit (confirm) */

export function submitPage(p: PageContext, r: RankingRecord): string {
  const today = localDay(p.ctx.clock.now());
  const controls = `<h2>Record that you submitted this application</h2>
<p>Job Radar never submits anything. This records what you did yourself, so it can track what the employer does next.</p>
<div class="record"><div class="row"><div><label for="s-on">Submitted on</label><input type="date" id="s-on" name="on" value="${today}" max="${today}"></div></div>
<div><label for="s-note">Note (optional)</label><input type="text" id="s-note" name="note" maxlength="500"></div></div>
<label class="check"><input type="checkbox" name="confirm" value="yes" required> I submitted this application myself</label>
<div class="actions"><button class="primary">Record submission</button> <a href="/o/${esc(r.opportunityId)}">Cancel</a></div>`;
  return `<p class="company muted">${esc(r.company)}</p><h1 class="page-title">${esc(r.title)}</h1>
${postForm("/act/submit", p.csrf, `/o/${r.opportunityId}`, { id: r.opportunityId }, controls, "confirm")}`;
}

/* --------------------------------------------------------------- generation */

/** Files a reader can open, in the order they should read them. */
export function readableFiles(g: ArtifactRecord): { docs: string[]; others: string[] } {
  const names = Object.keys(g.manifest.files);
  const first = ["pack-review.md", "requirement-match.md"];
  const docs = names.filter((n) => n.endsWith(".md")).sort((a, b) => (first.indexOf(a) + 1 || 99) - (first.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const others = names.filter((n) => /\.(pdf|html)$/.test(n)).sort();
  return { docs, others };
}

export function generationPage(p: PageContext, r: RankingRecord, g: ArtifactRecord, read: (file: string) => string | null): string {
  const id = r.opportunityId;
  const kind = g.kind === "pack" ? "Application pack" : "Resume";
  const { docs, others } = readableFiles(g);
  const P: string[] = [];
  P.push(`<p class="company muted"><a href="/o/${esc(id)}">${esc(r.company)}, ${esc(r.title)}</a></p>`);
  P.push(`<h1 class="page-title">${kind}, generated ${esc(shortDate(g.createdAt))}</h1>`);
  const status =
    g.kind === "pack"
      ? g.approvedAt
        ? `<p><span class="approved">Approved ${esc(shortDate(g.approvedAt))}.</span> <code>jr fill</code> may type this pack's answers into the employer's form.</p>`
        : `<p>Not approved. <code>jr fill</code> will not use any of this pack's text until you approve it.</p>`
      : `<p class="muted">Selected from your evidence ledger and verified. Nothing here has been sent.</p>`;
  P.push(status);
  P.push(
    `<p class="section-note">${g.manifest.rejectedSentences} ${g.manifest.rejectedSentences === 1 ? "sentence" : "sentences"} removed by verification, ${g.manifest.repairs} ${g.manifest.repairs === 1 ? "repair" : "repairs"}. Generation <code>${esc(g.id)}</code>.</p>`,
  );
  if (others.length) {
    P.push(`<ul class="files">${others.map((f) => `<li><a href="/o/${esc(id)}/g/${esc(g.id)}/f/${encodeURIComponent(f)}">Open ${esc(f)}</a></li>`).join("")}</ul>`);
  }
  for (const f of docs) {
    const text = read(f);
    P.push(`<article class="doc"><p class="doc-name">${esc(f)}</p>${text === null ? `<p class="muted">This file is missing from disk.</p>` : markdown(text)}</article>`);
  }
  if (g.manifest.answers.length) {
    P.push(`<article class="doc"><p class="doc-name">Form answers fill may use</p>${g.manifest.answers.map((a) => `<h3>${esc(a.question)}</h3><p>${esc(a.answer)}</p>`).join("")}</article>`);
  }
  if (g.kind === "pack" && !g.approvedAt) {
    const controls = `<h2>Approve this pack</h2>
<p>Approving lets <code>jr fill</code> type this generation's cover letter and answers into the employer's form. It still never submits.</p>
<div class="record"><div><label for="a-note">Note (optional)</label><input type="text" id="a-note" name="note" maxlength="500"></div></div>
<label class="check"><input type="checkbox" name="read" value="yes" required> I have read this pack, including what it says not to claim</label>
<div class="actions"><button class="primary">Approve this pack</button></div>`;
    P.push(postForm("/act/approve", p.csrf, `/o/${id}/g/${g.id}`, { id, gen: g.id }, controls, "confirm"));
  }
  return P.join("\n");
}

/* ------------------------------------------------------------- applications */

export function appsPage(p: PageContext): string {
  const { ctx } = p;
  const now = ctx.clock.now();
  const views = applicationViews(ctx).sort((a, b) => b.since.localeCompare(a.since));
  const open = views.filter((a) => !CLOSED_APPLICATION_STATES.includes(a.state));
  const closed = views.filter((a) => CLOSED_APPLICATION_STATES.includes(a.state));
  const P: string[] = [`<h1 class="page-title">Applications</h1>`];
  if (!views.length) {
    P.push(`<p class="section-note">No applications recorded yet. When you submit one, open its posting and choose “Record that you submitted it”.</p>`);
    return P.join("\n");
  }
  const table = (rows: typeof views) =>
    `<div class="table-wrap"><table><tr><th>Application</th><th>State</th><th>Since</th><th>Furthest</th><th>Next</th><th></th></tr>${rows
      .map((a) => {
        const days = Math.floor((now.getTime() - Date.parse(a.since)) / 86_400_000);
        return `<tr><td><a class="row-link" href="/o/${esc(a.opportunityId)}">${esc(a.title)}</a><span class="sub">${esc(a.company)}, submitted ${esc(shortDate(a.submittedAt))}</span></td><td>${stateTag(a.state)}</td><td>${esc(shortDate(a.since))}</td><td>${esc(a.furthest)}</td><td>${esc(nextAction(a.state, days))}</td><td>${outcomeForm(p, a.id)}</td></tr>`;
      })
      .join("")}</table></div>`;
  P.push(`<h2 class="section-title">Still open</h2>`);
  P.push(open.length ? table(open) : `<p class="section-note">Every application has a final outcome.</p>`);
  if (closed.length) P.push(`<h2 class="section-title">Closed</h2><p class="section-note">Rejected, withdrawn or ghosted. A later outcome still counts if one arrives.</p>${table(closed)}`);
  return P.join("\n");
}

/* ------------------------------------------------------------------- system */

export function systemPage(p: PageContext, b: Briefing): string {
  const { ctx } = p;
  const s = spendSummary(ctx);
  const P: string[] = [`<h1 class="page-title">System</h1>`];
  P.push(`<div class="stat-row">
<div><b>${b.counts.opportunities.toLocaleString("en-US")}</b>tracked</div>
<div><b>${b.counts.eligible.toLocaleString("en-US")}</b>eligible</div>
<div><b>${b.counts.open.toLocaleString("en-US")}</b>open</div>
<div><b>${b.counts.closed.toLocaleString("en-US")}</b>closed</div>
<div><b>${b.counts.assessed}</b>assessed</div>
</div>`);

  P.push(`<h2 class="section-title">Health</h2>`);
  P.push(b.health.length ? `<ul class="health">${b.health.map((h) => `<li class="${h.level}">${codeText(h.text)}</li>`).join("")}</ul>` : `<p class="section-note">Every observer is current.</p>`);
  if (b.calibration) P.push(`<p class="section-note">${esc(b.calibration)}</p>`);

  P.push(`<h2 class="section-title">Model spend</h2><p class="section-note">From the ledger of paid calls. A call with no receipt counts at its reserved worst case.</p>`);
  const budget = (label: string, used: number, cap: number, note: string) => {
    const pct = cap > 0 ? (used / cap) * 100 : 0;
    return `<span>${label}</span>${bar(pct, pct >= 80 ? "over" : "used")}<span>$${used.toFixed(2)} of $${cap.toFixed(2)}${esc(note)}</span>`;
  };
  P.push(`<div class="budget">${budget("Today", s.day.committed, s.budgets.perDay, basisNote(s.day))}${budget("This month", s.month.committed, s.budgets.perMonth, basisNote(s.month))}</div>`);
  if (s.byPurpose.length) {
    P.push(
      `<div class="table-wrap narrow"><table><tr><th>Purpose (30 days)</th><th class="num">Calls</th><th class="num">USD</th></tr>${s.byPurpose
        .map((x) => `<tr><td>${esc(x.purpose)}</td><td class="num">${x.calls}</td><td class="num">$${x.usd.toFixed(4)}</td></tr>`)
        .join("")}</table></div>`,
    );
  }

  P.push(`<h2 class="section-title">Funnel</h2>`);
  if (b.funnel.sampleWarning) P.push(`<p class="section-note">${esc(b.funnel.sampleWarning)}</p>`);
  P.push(
    `<div class="table-wrap narrow"><table><tr><th>Stage</th><th class="num">Reached</th></tr>${Object.entries(b.funnel.counts)
      .map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n.toLocaleString("en-US")}</td></tr>`)
      .join("")}</table></div>`,
  );
  if (b.funnel.conversions.length) {
    P.push(`<div class="table-wrap narrow"><table><tr><th>Conversion</th><th>Rate</th></tr>${b.funnel.conversions.map((c) => `<tr><td>${esc(c.from)} to ${esc(c.to)}</td><td>${esc(formatRate(c.rate, c.n))}</td></tr>`).join("")}</table></div>`);
  }
  if (b.funnel.hypotheses.length) P.push(`<ul>${b.funnel.hypotheses.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>`);

  const sweeps = ctx.store.latestSweeps();
  const failed = sweeps.filter((x) => x.status === "failed");
  P.push(`<h2 class="section-title">Boards</h2><p class="section-note">${sweeps.length} boards in the latest sweeps, ${failed.length} failed. A failed board leaves its postings as they were.</p>`);
  if (failed.length) {
    P.push(
      `<div class="table-wrap"><table><tr><th>Board</th><th>When</th><th>Error</th></tr>${failed
        .map((x) => `<tr><td>${esc(x.boardId)}</td><td>${esc(shortDate(x.startedAt))}</td><td>${esc(x.error ?? "")}</td></tr>`)
        .join("")}</table></div>`,
    );
  }
  const coverage = mailCoverageSpan(ctx);
  P.push(`<h2 class="section-title">Mail</h2><p class="section-note">${coverage ? `Application mail read from ${esc(shortDate(coverage.from))} to ${esc(shortDate(coverage.to))}.` : "Application mail has never been read completely, so the funnel is unobserved rather than silent."}</p>`);

  const runs = ctx.store.recentRuns(new Date(ctx.clock.now().getTime() - 7 * 86_400_000).toISOString(), 40);
  P.push(`<h2 class="section-title">Recent runs</h2>`);
  P.push(
    runs.length
      ? `<div class="table-wrap"><table><tr><th>Command</th><th>Started</th><th>Outcome</th><th>Error</th></tr>${runs
          .map(
            (x) =>
              `<tr><td>${esc(x.command)}</td><td>${esc(x.startedAt.slice(0, 16).replace("T", " "))}</td><td>${stateTag(x.outcome)}</td><td>${esc(x.error ?? "")}</td></tr>`,
          )
          .join("")}</table></div>`
      : `<p class="section-note">Nothing has run in the last week.</p>`,
  );
  if (b.watchlist.length) {
    P.push(`<h2 class="section-title">Watchlist</h2><p class="section-note">Companies with no public feed. Research them by hand.</p><ul>${b.watchlist.map((w) => `<li>${esc(w.company)}${w.why ? `: ${esc(w.why)}` : ""}</li>`).join("")}</ul>`);
  }
  return P.join("\n");
}

export function messagePage(title: string, text: string): string {
  return `<h1 class="page-title">${esc(title)}</h1><p class="section-note">${esc(text)}</p><p><a href="/">Back to today</a></p>`;
}
