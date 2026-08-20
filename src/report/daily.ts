import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CareerProfile, SourcesConfig } from "../config/schema.js";
import type { EnrichedJob } from "../model/job.js";
import type { JobRepo } from "../db/repo.js";
import {
  GHOSTED_AFTER_DAYS,
  PRIORITY_LABELS,
  nextAction,
  STALE_AFTER_DAYS,
  type Priority,
} from "../model/status.js";
import { formatSalary } from "../lib/salary.js";
import { paths } from "../config/load.js";
import { formatAge, postingAgeDays } from "../model/freshness.js";

export interface ReportInput {
  repo: JobRepo;
  profile: CareerProfile;
  sources: SourcesConfig;
  ingest?: { fetched: number; uniqueInBatch: number; inserted: number; sourceFailures: number } | null;
  scoring?: { scored: number; passed: number; rejected: number } | null;
}

/**
 * The daily briefing.
 *
 * Design constraint from the brief: do not dump 100 jobs. The report is capped
 * and ordered by Application ROI, because the scarce resource is attention,
 * not listings.
 */
function daysSince(iso: string | null, now: Date): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86400000));
}

/**
 * The pipeline view: everything submitted, waiting, or scheduled.
 *
 * Without this an application vanishes from the briefing the moment it is
 * submitted, which reads as the tool forgetting about it - the opposite of
 * what a job search needs from a daily report.
 */
function renderInFlight(jobs: EnrichedJob[], now: Date): string[] {
  const L: string[] = [];
  L.push("## In flight");
  L.push("");

  if (jobs.length === 0) {
    L.push("_Nothing submitted or in progress. Everything below is still just a candidate._");
    L.push("");
    return L;
  }

  const needsAttention = jobs.filter(
    (j) => daysSince(j.statusChangedAt, now) >= (STALE_AFTER_DAYS[j.status] ?? 7),
  );

  L.push(
    `${jobs.length} role${jobs.length === 1 ? "" : "s"} live` +
      (needsAttention.length ? `, **${needsAttention.length} needing attention**` : ""),
  );
  L.push("");
  L.push("| Status | Role | Days | What now |");
  L.push("|---|---|---|---|");
  for (const j of jobs) {
    const days = daysSince(j.statusChangedAt, now);
    const stale = days >= (STALE_AFTER_DAYS[j.status] ?? 7);
    const flag = stale ? "**" : "";
    L.push(
      `| ${flag}${j.status}${flag} | ${j.company} - ${j.title} | ${days}d | ${nextAction(j.status, days)} |`,
    );
  }
  L.push("");
  L.push("_Move these along: `npm run cli -- status <job-id> SCREEN` (or REJECTED / GHOSTED). " +
    "Recording a rejection matters as much as recording a win - the funnel can only diagnose " +
    "targeting versus closing if the failures are in it too._");
  L.push("");

  L.push(...renderOutcomeAsks(needsAttention, now));
  return L;
}

/**
 * The explicit ask, for roles that have gone quiet.
 *
 * The table above reports state. This asks a question, because state is not
 * what is missing - an outcome is. Nothing here decides anything: a status past
 * GHOSTED_AFTER_DAYS is called out as *probably* dead and still requires the
 * human to say so. Whether an employer stopped replying is a fact about them,
 * and a clock is not evidence of it.
 */
function renderOutcomeAsks(stale: EnrichedJob[], now: Date): string[] {
  if (stale.length === 0) return [];

  const L: string[] = [];
  L.push("### Needs an outcome");
  L.push("");
  L.push(
    `${stale.length} role${stale.length === 1 ? " has" : "s have"} gone quiet. ` +
      "Every rate on `stats` is computed from these answers, so an unrecorded outcome is not a " +
      "neutral gap - it is a number the funnel gets wrong.",
  );
  L.push("");
  L.push("| Role | Status | Quiet for | Record it |");
  L.push("|---|---|---|---|");
  for (const j of stale) {
    const days = daysSince(j.statusChangedAt, now);
    const likelyGhosted = days >= GHOSTED_AFTER_DAYS;
    const outcomes = likelyGhosted ? "GHOSTED / REJECTED / SCREEN" : "SCREEN / REJECTED / GHOSTED";
    // The threshold is interpolated rather than spelled out, so moving
    // GHOSTED_AFTER_DAYS cannot leave the briefing quoting a number that is no
    // longer the one being applied.
    const note = likelyGhosted ? ` - no reply in ${GHOSTED_AFTER_DAYS}+ days, probably ghosted` : "";
    L.push(
      `| ${j.company} - ${j.title} | ${j.status} | ${days}d | ` +
        `\`npm run cli -- status ${j.id} <${outcomes}>\`${note} |`,
    );
  }
  L.push("");
  L.push(
    "_`npm run cli -- inflight` lists these with the same commands, " +
      "and accepts a company name in place of the id._",
  );
  L.push("");
  return L;
}

export function buildDailyReport(input: ReportInput): { markdown: string; jobCount: number } {
  const { repo, profile, sources } = input;
  const now = new Date();
  const dateLabel = now
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    .toUpperCase();

  const counts = repo.counts();
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const newToday = repo.discoveredSince(cutoff);

  const candidates = repo.top({
    minFit: profile.scoring.report_threshold,
    limit: profile.report.max_total * 4,
    includeReviewed: false,
    // A posting open for six months is furniture, not an opening. The briefing
    // is the one surface that should never show one: it is read as "here is
    // today's work", and median posting age at apply was 55 days largely
    // because this list did not distinguish.
    evergreenDays: profile.scoring.evergreen_days,
  });

  const byPriority: Record<Priority, EnrichedJob[]> = { A: [], B: [], C: [], D: [] };
  for (const job of candidates) {
    const p = (job.priority ?? "D") as Priority;
    byPriority[p].push(job);
  }

  const slate: EnrichedJob[] = [
    ...byPriority.A.slice(0, profile.report.max_priority_a),
    ...byPriority.B.slice(0, profile.report.max_priority_b),
    ...byPriority.C.slice(0, profile.report.max_priority_c),
  ].slice(0, profile.report.max_total);

  const L: string[] = [];

  L.push(`# JOB RADAR - ${dateLabel}`);
  L.push("");
  L.push("```");
  if (input.ingest) {
    L.push(`Jobs discovered this run : ${input.ingest.fetched}`);
    L.push(`New after dedupe         : ${input.ingest.uniqueInBatch}`);
    L.push(`Never seen before        : ${input.ingest.inserted}`);
    if (input.ingest.sourceFailures) L.push(`Source failures          : ${input.ingest.sourceFailures}`);
  }
  L.push(`Total in index           : ${counts.total}`);
  L.push(`Discovered last 24h      : ${newToday}`);
  L.push(`Passed hard filters      : ${counts.passedFilters}`);
  L.push(`Fit score >= 80          : ${counts.score80}`);
  L.push(`Priority A               : ${counts.priorityA}`);
  L.push(`Priority B               : ${counts.priorityB}`);
  L.push(`LLM-analyzed             : ${counts.analyzed}`);
  L.push(`Generated                : ${now.toISOString()}`);
  L.push("```");
  L.push("");

  // In flight goes FIRST. The slate is a list of work not yet started; this is
  // work already committed to, and it is what actually needs chasing.
  L.push(...renderInFlight(repo.inFlight(), now));

  if (slate.length === 0) {
    L.push("## NOTHING ACTIONABLE TODAY");
    L.push("");
    L.push(
      `No unreviewed job cleared a fit score of ${profile.scoring.report_threshold}. That is a real result, not a bug - either the sources are quiet or the profile is tuned tight.`,
    );
    L.push("");
    L.push("Things worth trying, in order:");
    L.push("");
    L.push("1. `npm run cli -- sources` - confirm the boards are still live.");
    L.push("2. Add companies to `config/sources.yaml` in your lanes (marketplaces, content platforms, devtools, proptech).");
    L.push("3. Lower `scoring.report_threshold` in `config/career-profile.yaml` to see what is just below the line.");
    L.push("4. `npm run cli -- top --all --limit 20` - inspect the full ranking including already-reviewed jobs.");
  } else {
    const groups: [Priority, EnrichedJob[]][] = [
      ["A", slate.filter((j) => j.priority === "A")],
      ["B", slate.filter((j) => j.priority === "B")],
      ["C", slate.filter((j) => j.priority === "C")],
    ];

    let index = 0;
    for (const [priority, jobs] of groups) {
      if (jobs.length === 0) continue;
      L.push(`## PRIORITY ${priority} - ${PRIORITY_LABELS[priority]}`);
      L.push("");
      for (const job of jobs) {
        index++;
        L.push(...renderJob(job, index));
      }
    }
  }

  // Watchlist: companies with no public feed, surfaced as networking reminders.
  if (sources.watchlist.length) {
    L.push("## WATCHLIST - RESEARCH BY HAND");
    L.push("");
    L.push("No public feed for these. Nothing is scraped; they are here as a reminder to go look.");
    L.push("");
    for (const w of sources.watchlist) {
      L.push(`- **${w.company}** - ${w.why}`);
    }
    L.push("");
  }

  L.push("## NEXT ACTIONS");
  L.push("");
  L.push("```bash");
  L.push("npm run cli -- show <job-id>          # full analysis for one job");
  L.push("npm run cli -- status <job-id> APPLY  # mark it for application");
  L.push("npm run cli -- status <job-id> SKIPPED # get it out of the slate");
  L.push("npm run cli -- inflight               # everything live, with the command to move each one");
  L.push("npm run cli -- status <company> SCREEN # a company name works too, when it is unambiguous");
  L.push("npm run cli -- stats                  # funnel conversion + bottleneck");
  L.push("```");
  L.push("");
  L.push("Every application, message, and compensation number still goes through you. Nothing here is sent automatically.");
  L.push("");

  // Attribution required by the Remote OK API terms. See sources/remoteok.ts.
  //
  // Gated on whether a Remote OK posting is actually IN this report, not on
  // whether the source is currently enabled. Those came apart the moment the
  // source was disabled in JOB-37: 273 Remote OK postings stay in the index
  // and can still be recommended, so keying on `enabled` would have published
  // their listings with the attribution silently removed. Their terms are
  // about displaying the listings, not about fetching them.
  const showsRemoteOk =
    sources.sources.remoteok.enabled || slate.some((j) => j.source === "remoteok");
  if (showsRemoteOk) {
    L.push("---");
    L.push("");
    L.push(
      "Some listings in this report were sourced from [Remote OK](https://remoteok.com). Remote OK is the source for those postings.",
    );
    L.push("");
  }

  L.push(`_Generated ${now.toISOString()} by job-radar._`);

  return { markdown: L.join("\n"), jobCount: slate.length };
}

function renderJob(job: EnrichedJob, index: number): string[] {
  const L: string[] = [];
  const a = job.analysis;
  const salary = formatSalary({
    min: job.salaryMin,
    max: job.salaryMax,
    currency: job.salaryCurrency,
    period: job.salaryPeriod,
    confidence: job.salaryMin != null ? "published" : "none",
    raw: null,
  });

  L.push(`### ${index}. ${job.title} - ${job.company}`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| **Job ID** | \`${job.id}\` |`);
  L.push(`| **Fit** | ${job.fitScore ?? "-"}${a ? ` (LLM: ${a.fitScore})` : ""} |`);
  L.push(`| **Application ROI** | ${job.applicationRoi ?? "-"}${a ? ` (LLM: ${a.applicationRoi})` : ""} |`);
  L.push(`| **Compensation** | ${job.compensationBand ?? "UNKNOWN"} - posted ${salary} |`);
  L.push(`| **Lane** | ${job.lane ?? "-"} |`);
  L.push(`| **Location** | ${job.location} (${job.remoteStatus}) |`);
  // Age, not just the date. "2026-06-04" needs mental arithmetic; "77d old"
  // is the number that should influence whether this is worth applying to
  // today, and it was absent from every briefing that recommended a posting
  // already four months old.
  const ageDays = postingAgeDays(job.datePosted);
  L.push(
    `| **Posted** | ${job.datePosted ? job.datePosted.slice(0, 10) : "not stated"}` +
      `${ageDays === null ? "" : ` (${formatAge(ageDays)} old)`} |`,
  );
  if (a) L.push(`| **Interview probability** | ${a.interviewProbability}% (competition: ${a.competitionEstimate}) |`);
  L.push(`| **Apply** | ${job.applicationUrl ?? job.sourceUrl} |`);
  L.push("");

  if (a) {
    L.push(`**Why it fits:** ${a.reasoningSummary}`);
    L.push("");
    if (a.differentiation && a.differentiation.toLowerCase() !== "none identified") {
      L.push(`**Differentiation:** ${a.differentiation}`);
      L.push("");
    }
    if (a.strengths.length) {
      L.push("Strengths:");
      L.push("");
      for (const s of a.strengths.slice(0, 5)) L.push(`- ${s}`);
      L.push("");
    }
    if (a.risks.length) {
      L.push("Concerns:");
      L.push("");
      for (const r of a.risks.slice(0, 4)) L.push(`- ${r}`);
      L.push("");
    }
    if (a.missingRequirements.length) {
      L.push("Missing requirements:");
      L.push("");
      for (const m of a.missingRequirements.slice(0, 4)) L.push(`- ${m}`);
      L.push("");
    }
    L.push(`**Compensation read:** ${a.salaryReasoning}`);
    L.push("");
    if (a.outreachTargets.length) {
      L.push(`**Worth contacting:** ${a.outreachTargets.join(", ")} (titles only - find the actual person yourself)`);
      L.push("");
    }
    L.push(`**Recommended action:** ${a.recommendation.replace(/_/g, " ").toUpperCase()}`);
  } else {
    // No LLM pass yet: show the deterministic reasoning so the entry is still
    // actionable rather than an opaque number.
    const pos = job.positiveSignals.slice(0, 6);
    const neg = job.negativeSignals.slice(0, 4);
    if (pos.length) {
      L.push("Why it scored (keyword engine, not yet LLM-analyzed):");
      L.push("");
      for (const s of pos) L.push(`- ${s}`);
      L.push("");
    }
    if (neg.length) {
      L.push("Concerns:");
      L.push("");
      for (const s of neg) L.push(`- ${s}`);
      L.push("");
    }
    L.push(`_Run \`npm run cli -- analyze\` for a full read on this one._`);
  }

  L.push("");
  return L;
}

/** Write the report to reports/YYYY-MM-DD.md and return the path. */
export function writeReport(markdown: string, dir = paths.reports()): string {
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(dir, `${date}.md`);
  writeFileSync(file, markdown, "utf8");
  const latest = resolve(dir, "latest.md");
  writeFileSync(latest, markdown, "utf8");
  return file;
}
