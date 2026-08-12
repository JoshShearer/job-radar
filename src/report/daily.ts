import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CareerProfile, SourcesConfig } from "../config/schema.js";
import type { EnrichedJob } from "../model/job.js";
import type { JobRepo } from "../db/repo.js";
import { PRIORITY_LABELS, type Priority } from "../model/status.js";
import { formatSalary } from "../lib/salary.js";
import { paths } from "../config/load.js";

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
  L.push("```");
  L.push("");

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
  L.push("npm run cli -- status <job-id> SKIP   # get it out of the slate");
  L.push("npm run cli -- stats                  # funnel conversion + bottleneck");
  L.push("```");
  L.push("");
  L.push("Every application, message, and compensation number still goes through you. Nothing here is sent automatically.");
  L.push("");

  // Attribution required by the Remote OK API terms. See sources/remoteok.ts.
  if (sources.sources.remoteok.enabled) {
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
  L.push(`| **Posted** | ${job.datePosted ? job.datePosted.slice(0, 10) : "not stated"} |`);
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
