#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadProfile, loadSources, paths, PROJECT_ROOT } from "./config/load.js";
import { loadEnvFile } from "./config/env.js";
import { closeDb, openDb } from "./db/index.js";
import { JobRepo } from "./db/repo.js";
import { runIngest } from "./pipeline/ingest.js";
import { runScoring } from "./pipeline/rescore.js";
import { runAnalysis, DEFAULT_EFFORT, DEFAULT_MODEL } from "./analysis/analyzer.js";
import { buildDailyReport, writeReport } from "./report/daily.js";
import { writeHtmlReport } from "./report/html.js";
import { prepareApplication, renderPack, writePack } from "./analysis/prepare.js";
import { computeCalibration, describeCalibration, loadCalibration } from "./pipeline/calibration.js";
import { buildFunnel, renderFunnel } from "./stats/funnel.js";
import { listBoardEndpoints } from "./sources/registry.js";
import { discoverCompany, type DiscoveryHit } from "./sources/discover.js";
import { startReportServer } from "./report/serve.js";
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

function withRepo<T>(command: string, fn: (repo: JobRepo, db: ReturnType<typeof openDb>) => T | Promise<T>): Promise<T> {
  const db = openDb();
  const repo = new JobRepo(db);
  const runId = repo.startRun(command);
  return Promise.resolve(fn(repo, db))
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
    await withRepo("score", (repo, db) => {
      const summary = runScoring(repo, profile, db);
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

// ---- apply ----------------------------------------------------------------

program
  .command("apply <jobId>")
  .description("Prepare a full application package. Prepares only - never submits.")
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", "reasoning effort (default high - this one is worth the tokens)")
  .option("--open", "open the generated pack in your browser", false)
  .action(async (jobId: string, opts: { model?: string; effort?: string; open: boolean }) => {
    const profile = loadProfile();
    await withRepo("apply", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}". Use \`job-radar top\` to list ids.`);
        process.exitCode = 1;
        return { ok: false };
      }

      log.info(`Preparing application material for ${job.company} - ${job.title}`);
      if (!job.analysis) {
        log.warn("This job has not been analyzed yet. Run `analyze` first for a much better package.");
      }

      const { pack, usage } = await prepareApplication(job, profile, {
        // Defaults higher than the analysis stage: this output is read closely
        // by a human and acted on, so it is worth more thinking than a triage
        // pass over hundreds of postings.
        model: opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
        effort: opts.effort ?? "high",
      });

      const markdown = renderPack(job, pack, profile);
      const { dir, md, html } = writePack(job, markdown);

      // SAVED, not APPLIED. Recording an application that has not been
      // submitted would corrupt the funnel metrics with a phantom data point,
      // and the funnel is the thing that tells him what to fix.
      repo.setStatus(job.id, "SAVED", "Application pack prepared; not yet submitted");

      console.log("");
      console.log(markdown);
      console.log("");
      log.info(`Pack written to ${dir}`);
      log.info(`  markdown : ${md}`);
      log.info(`  html     : ${html}`);
      log.info(
        `  tokens   : ${usage.input} in / ${usage.cacheRead} cached / ${usage.output} out`,
      );
      log.info(`Status set to SAVED. After you actually submit: job-radar status ${job.id} APPLIED`);

      if (opts.open) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        const child = spawn(cmd, [html], { detached: true, stdio: "ignore" });
        child.on("error", () => console.log(`Open it yourself: file://${html}`));
        child.unref();
      }

      return { ok: true, dir };
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

    await withRepo("daily", async (repo, db) => {
      let ingestSummary = null;
      if (opts.ingest) {
        ingestSummary = await runIngest(repo, profile, sourcesConfig);
      } else {
        log.info("Skipping ingest (--no-ingest)");
      }

      let scoreSummary = runScoring(repo, profile, db);

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
        // New analyses change the calibration and can flip priorities, so the
        // report must be built from re-scored data, not from the pre-analysis
        // pass above.
        scoreSummary = runScoring(repo, profile, db);
      }

      const { markdown, jobCount } = buildDailyReport({
        repo,
        profile,
        sources: sourcesConfig,
        ingest: ingestSummary,
        scoring: scoreSummary,
      });
      const file = writeReport(markdown);
      const htmlFile = writeHtmlReport(markdown);

      console.log("");
      console.log(markdown);
      console.log("");
      log.info(`Report written (${jobCount} actionable roles):`);
      log.info(`  markdown : ${file}`);
      log.info(`  html     : ${htmlFile}`);
      log.info(`  open it  : npm run cli -- open`);
      return { jobCount, file, htmlFile };
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

// ---- open -----------------------------------------------------------------

program
  .command("open")
  .description("Open the latest HTML briefing in your browser")
  .option("--md", "print the Markdown path instead of opening the browser", false)
  .action((opts: { md: boolean }) => {
    const dir = paths.reports();
    const html = resolve(dir, "latest.html");
    const md = resolve(dir, "latest.md");

    if (!existsSync(html) && !existsSync(md)) {
      console.error(`No report found in ${dir}. Run \`npm run radar\` first.`);
      process.exitCode = 1;
      return;
    }
    if (opts.md || !existsSync(html)) {
      console.log(md);
      return;
    }

    // Platform-appropriate opener. Never shell-interpolate the path.
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [html], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      console.log(`Could not launch ${cmd}. Open this file manually:`);
      console.log(`  file://${html}`);
    });
    child.unref();
    console.log(`Opening file://${html}`);
  });

// ---- serve ----------------------------------------------------------------

program
  .command("serve")
  .description("Serve the briefing archive locally (read-only, 127.0.0.1 only)")
  .option("-p, --port <n>", "port to listen on", "4321")
  .option("--open", "open a browser once the server is up", false)
  .action(async (opts: { port: string; open: boolean }) => {
    const dir = paths.reports();
    if (!existsSync(resolve(dir, "latest.html"))) {
      console.log(`No briefing in ${dir} yet - serving an empty index. Run \`npm run radar\` to generate one.`);
    }

    const { port } = await startReportServer({ dir, port: Number(opts.port) || 4321 });
    const url = `http://127.0.0.1:${port}/`;

    console.log("");
    console.log(`  Job Radar briefings  ${url}`);
    console.log(`  serving              ${dir}`);
    console.log(`  bound to             127.0.0.1 only (not reachable from your network)`);
    console.log("");
    console.log("  Ctrl-C to stop.");

    if (opts.open) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
      child.on("error", () => console.log(`  (could not launch ${cmd} - open ${url} yourself)`));
      child.unref();
    }

    // Hold the process open until interrupted.
    await new Promise<void>((resolvePromise) => {
      process.on("SIGINT", () => {
        console.log("\nstopped");
        resolvePromise();
      });
    });
  });

// ---- calibrate ------------------------------------------------------------

program
  .command("calibrate")
  .description("Show how far the keyword engine drifts from the analysis, measured on your own data")
  .action(async () => {
    await withRepo("calibrate", (_repo, db) => {
      const fresh = computeCalibration(db);
      const stored = loadCalibration(db);
      console.log("");
      console.log(describeCalibration(fresh));
      console.log("");
      console.log(`  sample size    ${fresh.sampleSize}`);
      console.log(`  fit ratio      ${fresh.fitRatio.toFixed(3)}   (applied to unanalyzed jobs)`);
      console.log(`  roi ratio      ${fresh.roiRatio.toFixed(3)}`);
      console.log(`  mean fit bias  ${fresh.fitBias >= 0 ? "+" : ""}${fresh.fitBias.toFixed(1)} points`);
      console.log(`  mean roi bias  ${fresh.roiBias >= 0 ? "+" : ""}${fresh.roiBias.toFixed(1)} points`);
      console.log(`  applied        ${fresh.usable ? "yes" : "no - below the sample floor"}`);
      if (stored) console.log(`  last stored    ${stored.computedAt}`);
      console.log("");
      console.log("Run `score` to re-measure and re-project every unanalyzed job.");
      return fresh;
    });
  });

// ---- discover -------------------------------------------------------------

program
  .command("discover <companies...>")
  .description("Find a company's public ATS board and print a sources.yaml line to paste")
  .option("--all-tokens", "keep probing after the first hit (companies with several boards)", false)
  .action(async (companies: string[], opts: { allTokens: boolean }) => {
    const config = loadSources();
    const fetcher = new PoliteFetcher({
      delayMs: config.http.delay_ms,
      timeoutMs: config.http.timeout_ms,
      maxRetries: 0, // a 404 just means "not this ATS" - retrying it is waste
      userAgent: config.http.user_agent,
    });

    // Companies already configured, so we can say so instead of suggesting a
    // duplicate entry.
    const existing = new Set<string>();
    for (const group of [config.sources.greenhouse, config.sources.lever, config.sources.ashby]) {
      for (const b of group.boards) existing.add(b.token.toLowerCase());
    }

    const found: DiscoveryHit[] = [];
    const missing: string[] = [];

    for (const company of companies) {
      const result = await discoverCompany(company, fetcher, { allTokens: opts.allTokens });
      if (result.hits.length === 0) {
        missing.push(company);
        console.log(`  --    ${company.padEnd(24)} no public board (tried: ${result.tokensTried.join(", ")})`);
        continue;
      }
      for (const hit of result.hits) {
        const dupe = existing.has(hit.token.toLowerCase());
        console.log(
          `  ${dupe ? "HAVE" : "NEW "}  ${company.padEnd(24)} ${hit.ats}:${hit.token} (${hit.jobCount} jobs)`,
        );
        if (!dupe) found.push(hit);
      }
    }

    console.log("");
    if (found.length === 0) {
      console.log("Nothing new to add.");
    } else {
      console.log(`Add these to config/sources.yaml under the matching ATS, then run \`ingest\`:`);
      for (const ats of ["greenhouse", "lever", "ashby"] as const) {
        const lines = found.filter((h) => h.ats === ats);
        if (lines.length === 0) continue;
        console.log("");
        console.log(`  # -- ${ats} --`);
        for (const h of lines) console.log(h.configLine);
      }
    }
    if (missing.length) {
      console.log("");
      console.log(
        `No public ATS endpoint for: ${missing.join(", ")}. ` +
          `Add them to \`watchlist\` in config/sources.yaml and approach a human instead.`,
      );
    }
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
