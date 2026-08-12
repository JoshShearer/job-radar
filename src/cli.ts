#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadProfile, loadSources, paths, PROJECT_ROOT } from "./config/load.js";
import { loadEnvFile } from "./config/env.js";
import { closeDb, openDb } from "./db/index.js";
import { JobRepo } from "./db/repo.js";
import { runIngest } from "./pipeline/ingest.js";
import { runScoring } from "./pipeline/rescore.js";
import { runAnalysis, DEFAULT_EFFORT, DEFAULT_MODEL } from "./analysis/analyzer.js";
import { buildDailyReport, writeReport } from "./report/daily.js";
import { buildFunnel, renderFunnel } from "./stats/funnel.js";
import { listBoardEndpoints } from "./sources/registry.js";
import { PoliteFetcher } from "./lib/http.js";
import { log, setVerbose } from "./lib/log.js";
import { isStatus, STATUSES, INTERVIEW_STAGES } from "./model/status.js";
import { formatSalary } from "./lib/salary.js";

// Must run before any command reads process.env for credentials or overrides.
loadEnvFile();

const program = new Command();

program
  .name("job-radar")
  .description("Local-first job intelligence and search automation")
  .version("0.1.0")
  .option("-v, --verbose", "verbose logging", false)
  .hook("preAction", (thisCommand) => {
    setVerbose(Boolean(thisCommand.opts().verbose));
  });

function withRepo<T>(command: string, fn: (repo: JobRepo) => T | Promise<T>): Promise<T> {
  const db = openDb();
  const repo = new JobRepo(db);
  const runId = repo.startRun(command);
  return Promise.resolve(fn(repo))
    .then((result) => {
      repo.finishRun(runId, result ?? {}, true);
      return result;
    })
    .catch((err) => {
      repo.finishRun(runId, { error: String(err) }, false);
      throw err;
    })
    .finally(() => closeDb());
}

// ---- ingest ---------------------------------------------------------------

program
  .command("ingest")
  .description("Fetch jobs from configured sources, normalize, dedupe, and store")
  .option("-s, --source <names...>", "restrict to specific sources (greenhouse, lever, ashby, remoteok)")
  .action(async (opts: { source?: string[] }) => {
    const profile = loadProfile();
    const sources = loadSources();
    await withRepo("ingest", async (repo) => {
      const summary = await runIngest(repo, profile, sources, { onlySources: opts.source });
      console.log("");
      console.log("INGEST SUMMARY");
      console.log(summary.stats.summary());
      console.log("");
      console.log(
        `${summary.inserted} new, ${summary.updated} updated, ${summary.duplicatesInBatch} duplicates collapsed, ` +
          `${summary.descriptionChanges} descriptions changed, ${summary.salaryChanges} salaries changed.`,
      );
      if (summary.sourceFailures > 0) {
        console.log(`${summary.sourceFailures} source(s) failed - see above. The run continued regardless.`);
      }
      return summary;
    });
  });

// ---- score ----------------------------------------------------------------

program
  .command("score")
  .description("Re-run hard filters and deterministic scoring over the whole index")
  .action(async () => {
    const profile = loadProfile();
    await withRepo("score", (repo) => {
      const summary = runScoring(repo, profile);
      console.log("");
      console.log(
        `Scored ${summary.scored} | passed ${summary.passed} | rejected ${summary.rejected} | top fit ${summary.topScore}`,
      );
      console.log(
        `Priority: A=${summary.byPriority.A} B=${summary.byPriority.B} C=${summary.byPriority.C} D=${summary.byPriority.D}`,
      );
      return summary;
    });
  });

// ---- analyze --------------------------------------------------------------

program
  .command("analyze")
  .description("Run structured Claude analysis on the highest-value unanalyzed jobs")
  .option("-l, --limit <n>", "max jobs to analyze this pass", "10")
  .option("-m, --min-fit <n>", "minimum deterministic fit score to be eligible")
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", `reasoning effort: low|medium|high|xhigh|max (default ${DEFAULT_EFFORT})`)
  .option("--dry-run", "show what would be analyzed without calling the API", false)
  .action(async (opts: { limit: string; minFit?: string; model?: string; effort?: string; dryRun: boolean }) => {
    const profile = loadProfile();
    await withRepo("analyze", async (repo) => {
      const summary = await runAnalysis(repo, profile, {
        limit: Number(opts.limit) || 10,
        minFit: opts.minFit ? Number(opts.minFit) : profile.scoring.analysis_threshold,
        model: opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
        effort: opts.effort ?? process.env.JOB_RADAR_EFFORT ?? DEFAULT_EFFORT,
        dryRun: opts.dryRun,
      });
      console.log("");
      console.log(
        `Considered ${summary.considered} | analyzed ${summary.analyzed} | from cache ${summary.fromCache} | failed ${summary.failed}`,
      );
      if (summary.analyzed > 0) {
        const cacheTotal = summary.cacheReadTokens + summary.cacheCreationTokens;
        const hitRate = cacheTotal > 0 ? Math.round((summary.cacheReadTokens / cacheTotal) * 100) : 0;
        console.log(
          `Tokens: ${summary.inputTokens} uncached in / ${summary.cacheCreationTokens} cache-write / ` +
            `${summary.cacheReadTokens} cache-read / ${summary.outputTokens} out`,
        );
        console.log(
          `Prompt cache hit rate: ${hitRate}%   Estimated cost: $${summary.estimatedCostUsd.toFixed(4)} ` +
            `($${(summary.estimatedCostUsd / summary.analyzed).toFixed(4)}/job)`,
        );
      }
      return summary;
    });
  });

// ---- daily ----------------------------------------------------------------

program
  .command("daily")
  .description("Full pass: ingest, score, optionally analyze, then write the daily briefing")
  .option("--no-ingest", "skip fetching; report on what is already stored")
  .option("--analyze", "also run the LLM analysis stage (costs money)", false)
  .option("-l, --analyze-limit <n>", "max jobs to analyze when --analyze is set", "8")
  .action(async (opts: { ingest: boolean; analyze: boolean; analyzeLimit: string }) => {
    const profile = loadProfile();
    const sourcesConfig = loadSources();

    await withRepo("daily", async (repo) => {
      let ingestSummary = null;
      if (opts.ingest) {
        ingestSummary = await runIngest(repo, profile, sourcesConfig);
      } else {
        log.info("Skipping ingest (--no-ingest)");
      }

      const scoreSummary = runScoring(repo, profile);

      if (opts.analyze) {
        const analysis = await runAnalysis(repo, profile, {
          limit: Number(opts.analyzeLimit) || 8,
          minFit: profile.scoring.analysis_threshold,
          model: process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
          effort: process.env.JOB_RADAR_EFFORT ?? DEFAULT_EFFORT,
          dryRun: false,
        });
        log.info(
          `Analysis: ${analysis.analyzed} new, ${analysis.fromCache} cached, ~$${analysis.estimatedCostUsd.toFixed(3)}`,
        );
      }

      const { markdown, jobCount } = buildDailyReport({
        repo,
        profile,
        sources: sourcesConfig,
        ingest: ingestSummary,
        scoring: scoreSummary,
      });
      const file = writeReport(markdown);

      console.log("");
      console.log(markdown);
      console.log("");
      log.info(`Report written to ${file} (${jobCount} actionable roles)`);
      return { jobCount, file };
    });
  });

// ---- top ------------------------------------------------------------------

program
  .command("top")
  .description("List the highest-ROI opportunities")
  .option("-l, --limit <n>", "how many to show", "15")
  .option("--all", "include already-reviewed jobs, not just NEW", false)
  .option("--lane <lane>", "filter to one lane")
  .option("--min-fit <n>", "minimum fit score")
  .action(async (opts: { limit: string; all: boolean; lane?: string; minFit?: string }) => {
    const profile = loadProfile();
    await withRepo("top", (repo) => {
      const minFit = opts.minFit ? Number(opts.minFit) : profile.scoring.report_threshold;
      let jobs = repo.top({ minFit, limit: Number(opts.limit) * 3 || 45, includeReviewed: opts.all });
      if (opts.lane) jobs = jobs.filter((j) => j.lane === opts.lane);
      jobs = jobs.slice(0, Number(opts.limit) || 15);

      if (jobs.length === 0) {
        console.log("No jobs match. Try --all, a lower --min-fit, or run `ingest` first.");
        return { count: 0 };
      }

      console.log("");
      console.log(
        `${"ID".padEnd(13)} ${"ROI".padStart(3)} ${"FIT".padStart(3)} ${"P".padStart(1)} ${"COMP".padEnd(7)} ${"COMPANY".padEnd(20)} TITLE`,
      );
      console.log("-".repeat(120));
      for (const j of jobs) {
        console.log(
          `${j.id.padEnd(13)} ${String(j.applicationRoi ?? "-").padStart(3)} ${String(j.fitScore ?? "-").padStart(3)} ` +
            `${(j.priority ?? "-").padStart(1)} ${(j.compensationBand ?? "-").padEnd(7)} ` +
            `${truncate(j.company, 20).padEnd(20)} ${truncate(j.title, 52)}`,
        );
      }
      console.log("");
      console.log(`${jobs.length} shown. \`job-radar show <id>\` for detail.`);
      return { count: jobs.length };
    });
  });

// ---- show -----------------------------------------------------------------

program
  .command("show <jobId>")
  .description("Full detail for one job (id or unique prefix)")
  .action(async (jobId: string) => {
    await withRepo("show", (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}". Use \`job-radar top\` to list ids.`);
        process.exitCode = 1;
        return { found: false };
      }

      console.log("");
      console.log(`${job.title}`);
      console.log(`${job.company}  |  ${job.location} (${job.remoteStatus})  |  ${job.employmentType}`);
      console.log("=".repeat(96));
      console.log(`ID          : ${job.id}`);
      console.log(`Status      : ${job.status}`);
      console.log(`Priority    : ${job.priority ?? "-"}`);
      console.log(`Source      : ${job.source}${job.ats ? ` (${job.ats})` : ""}`);
      console.log(`Posted      : ${job.datePosted ?? "not stated"}`);
      console.log(`First seen  : ${job.firstSeen}`);
      console.log(`Last seen   : ${job.lastSeen}`);
      console.log(
        `Salary      : ${formatSalary({
          min: job.salaryMin,
          max: job.salaryMax,
          currency: job.salaryCurrency,
          period: job.salaryPeriod,
          confidence: job.salaryMin != null ? "published" : "none",
          raw: null,
        })}  [${job.compensationBand ?? "UNKNOWN"}]`,
      );
      console.log(`URL         : ${job.sourceUrl}`);
      console.log(`Apply       : ${job.applicationUrl ?? job.sourceUrl}`);
      console.log("");
      console.log("DETERMINISTIC SCORING");
      console.log("-".repeat(96));
      console.log(job.scoreExplanation ?? "(not scored yet - run `job-radar score`)");

      if (job.analysis) {
        const a = job.analysis;
        console.log("");
        console.log("CLAUDE ANALYSIS");
        console.log("-".repeat(96));
        console.log(`Fit ${a.fitScore} | ROI ${a.applicationRoi} | ${a.recommendation.replace(/_/g, " ")}`);
        console.log(`Interview probability ${a.interviewProbability}% | competition ${a.competitionEstimate}`);
        console.log("");
        console.log(a.reasoningSummary);
        console.log("");
        console.log(`Differentiation: ${a.differentiation}`);
        if (a.strengths.length) {
          console.log("");
          console.log("Strengths:");
          for (const s of a.strengths) console.log(`  + ${s}`);
        }
        if (a.risks.length) {
          console.log("");
          console.log("Risks:");
          for (const s of a.risks) console.log(`  - ${s}`);
        }
        if (a.missingRequirements.length) {
          console.log("");
          console.log("Missing requirements:");
          for (const s of a.missingRequirements) console.log(`  ? ${s}`);
        }
        console.log("");
        console.log(`Compensation: ${a.salaryClassification.toUpperCase()} - ${a.salaryReasoning}`);
        if (a.outreachTargets.length) {
          console.log(`Outreach targets (titles only): ${a.outreachTargets.join(", ")}`);
        }
      } else {
        console.log("");
        console.log("No Claude analysis yet. Run: job-radar analyze");
      }

      console.log("");
      console.log("DESCRIPTION (first 1200 chars)");
      console.log("-".repeat(96));
      console.log(job.descriptionClean.slice(0, 1200));
      console.log("");
      return { found: true };
    });
  });

// ---- status ---------------------------------------------------------------

program
  .command("status <jobId> <status>")
  .description(`Set a job's status. One of: ${STATUSES.join(", ")}`)
  .option("-n, --note <text>", "attach a note")
  .action(async (jobId: string, status: string, opts: { note?: string }) => {
    const upper = status.toUpperCase();
    if (!isStatus(upper)) {
      console.error(`Invalid status "${status}". Valid: ${STATUSES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    await withRepo("status", (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}".`);
        process.exitCode = 1;
        return { ok: false };
      }
      repo.setStatus(job.id, upper, opts.note);
      console.log(`${job.company} - ${job.title}: ${job.status} -> ${upper}`);
      return { ok: true };
    });
  });

// ---- stats ----------------------------------------------------------------

program
  .command("stats")
  .description("Funnel conversion rates and bottleneck diagnosis")
  .action(async () => {
    await withRepo("stats", (repo) => {
      const counts = repo.counts();
      const funnel = buildFunnel(repo);
      console.log("");
      console.log("INDEX");
      console.log("-----");
      console.log(`  total            ${String(counts.total).padStart(5)}`);
      console.log(`  passed filters   ${String(counts.passedFilters).padStart(5)}`);
      console.log(`  scored           ${String(counts.scored).padStart(5)}`);
      console.log(`  LLM analyzed     ${String(counts.analyzed).padStart(5)}`);
      console.log(`  fit >= 80        ${String(counts.score80).padStart(5)}`);
      console.log("");
      console.log(renderFunnel(funnel, repo.statusCounts()));
      return funnel;
    });
  });

// ---- sources --------------------------------------------------------------

program
  .command("sources")
  .description("Health-check every configured source endpoint")
  .action(async () => {
    const config = loadSources();
    const endpoints = listBoardEndpoints(config);
    const fetcher = new PoliteFetcher({
      delayMs: config.http.delay_ms,
      timeoutMs: config.http.timeout_ms,
      maxRetries: 0,
      userAgent: config.http.user_agent,
    });

    console.log(`Checking ${endpoints.length} endpoint(s)...`);
    console.log("");
    let ok = 0;
    let dead = 0;
    for (const ep of endpoints) {
      try {
        const data = await fetcher.getJson<unknown>(ep.url);
        const count = Array.isArray(data)
          ? data.length
          : Array.isArray((data as { jobs?: unknown[] }).jobs)
            ? (data as { jobs: unknown[] }).jobs.length
            : 0;
        if (count > 0) {
          console.log(`  OK    ${ep.label.padEnd(28)} ${count} jobs`);
          ok++;
        } else {
          console.log(`  EMPTY ${ep.label.padEnd(28)} responded but returned no jobs`);
          dead++;
        }
      } catch (err) {
        console.log(`  DEAD  ${ep.label.padEnd(28)} ${(err as Error).message}`);
        dead++;
      }
    }
    console.log("");
    console.log(`${ok} live, ${dead} dead or empty. Remove dead boards from config/sources.yaml.`);
  });

// ---- interview ------------------------------------------------------------

const interview = program.command("interview").description("Interview intelligence database");

interview
  .command("add")
  .description("Log an interview stage")
  .requiredOption("--company <name>")
  .requiredOption("--role <title>")
  .requiredOption("--stage <stage>", `one of: ${INTERVIEW_STAGES.join(", ")}`)
  .option("--job <jobId>", "link to a job in the index")
  .option("--date <yyyy-mm-dd>", "date it happened (default today)")
  .option("--interviewer <name>")
  .option("--questions <q...>", "questions asked")
  .option("--technical <topic...>", "technical topics covered")
  .option("--behavioral <topic...>", "behavioral topics covered")
  .option("--quality <1-5>", "your self-rating of how you did")
  .option("--uncertain <text>", "areas you felt shaky on")
  .option("--comp-requested <n>", "the number you gave them")
  .option("--comp-min <n>", "the bottom of the range they stated")
  .option("--comp-max <n>", "the top of the range they stated")
  .option("--signals <text>", "signals you picked up")
  .option("--result <text>", "outcome, if known")
  .option("--notes <text>")
  .action(async (opts: Record<string, string | string[] | undefined>) => {
    const stage = String(opts.stage);
    if (!(INTERVIEW_STAGES as readonly string[]).includes(stage)) {
      console.error(`Invalid stage "${stage}". Valid: ${INTERVIEW_STAGES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    await withRepo("interview.add", (repo) => {
      let jobId: string | null = null;
      if (opts.job) {
        const job = repo.get(String(opts.job));
        if (!job) {
          console.error(`No job matches "${String(opts.job)}" - logging without a link.`);
        } else {
          jobId = job.id;
        }
      }
      const num = (v: unknown) => (v == null ? null : Number(v));
      const id = repo.addInterview({
        jobId,
        company: String(opts.company),
        role: String(opts.role),
        stage,
        occurredOn: String(opts.date ?? new Date().toISOString().slice(0, 10)),
        interviewer: opts.interviewer ? String(opts.interviewer) : null,
        questions: toArray(opts.questions),
        technicalTopics: toArray(opts.technical),
        behavioralTopics: toArray(opts.behavioral),
        answerQuality: num(opts.quality),
        uncertaintyAreas: opts.uncertain ? String(opts.uncertain) : null,
        compDiscussed: Boolean(opts.compRequested ?? opts.compMin ?? opts.compMax),
        compIRequested: num(opts.compRequested),
        compTheyStatedMin: num(opts.compMin),
        compTheyStatedMax: num(opts.compMax),
        signals: opts.signals ? String(opts.signals) : null,
        result: opts.result ? String(opts.result) : null,
        notes: opts.notes ? String(opts.notes) : null,
      });
      console.log(`Logged interview #${id}: ${String(opts.company)} - ${stage}`);
      return { id };
    });
  });

interview
  .command("list")
  .description("List logged interviews")
  .option("--company <name>", "filter by company")
  .action(async (opts: { company?: string }) => {
    await withRepo("interview.list", (repo) => {
      const rows = repo.listInterviews(opts.company);
      if (rows.length === 0) {
        console.log("No interviews logged yet. Use `job-radar interview add`.");
        return { count: 0 };
      }
      console.log("");
      for (const r of rows) {
        console.log(`${String(r.occurred_on)}  ${String(r.company)} - ${String(r.role)}  [${String(r.stage)}]`);
        if (r.result) console.log(`    result: ${String(r.result)}`);
        if (r.comp_i_requested) console.log(`    asked for: $${String(r.comp_i_requested)}`);
        if (r.comp_they_stated_min || r.comp_they_stated_max)
          console.log(`    their range: $${String(r.comp_they_stated_min)} - $${String(r.comp_they_stated_max)}`);
        if (r.uncertainty_areas) console.log(`    shaky on: ${String(r.uncertainty_areas)}`);
      }
      console.log("");
      console.log(`${rows.length} entries.`);
      return { count: rows.length };
    });
  });

// ---- backup ---------------------------------------------------------------

program
  .command("backup")
  .description("Copy the SQLite database to a timestamped file")
  .option("-o, --out <dir>", "output directory", resolve(PROJECT_ROOT, "data", "backups"))
  .action((opts: { out: string }) => {
    const src = paths.db();
    mkdirSync(opts.out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = resolve(opts.out, `job-radar-${stamp}.sqlite`);
    // Checkpoint WAL into the main file first so the copy is complete.
    const db = openDb();
    db.pragma("wal_checkpoint(TRUNCATE)");
    closeDb();
    copyFileSync(src, dest);
    console.log(`Backed up to ${dest}`);
  });

// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

program.parseAsync(process.argv).catch((err) => {
  log.error((err as Error).message);
  if (process.env.JOB_RADAR_DEBUG) console.error(err);
  process.exit(1);
});
