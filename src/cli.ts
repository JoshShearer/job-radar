#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { loadPack, packDir, prepareApplication, renderPack, writePack } from "./analysis/prepare.js";
import { loadPersonal } from "./config/personal.js";
import { autofillApplication, findResume, renderOutcomes } from "./apply/autofill.js";
import { loadResume, resumeExists, resumePath, saveResume } from "./resume/load.js";
import { allBullets, lintResume } from "./resume/schema.js";
import { scaffoldResume } from "./resume/init.js";
import { importResume } from "./resume/import.js";
import { matchResumeToJob } from "./resume/requirements.js";
import { enforceProvenance, tailorResume, TailorSchema } from "./resume/tailor.js";
import {
  composeResume,
  renderMatchReport,
  renderResumeHtml,
  renderResumeMarkdown,
  writeResumePdf,
} from "./resume/render.js";
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
      const { dir, md, html } = writePack(job, markdown, pack);

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
      log.info(`To fill the real form in a browser: job-radar autofill ${job.id}`);

      if (opts.open) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        const child = spawn(cmd, [html], { detached: true, stdio: "ignore" });
        child.on("error", () => console.log(`Open it yourself: file://${html}`));
        child.unref();
      }

      return { ok: true, dir };
    });
  });

// ---- resume ---------------------------------------------------------------

const resumeCmd = program
  .command("resume")
  .description("Master resume: the source of truth every tailored resume selects from");

resumeCmd
  .command("init")
  .description("Scaffold config/resume.yaml from what this repo already knows")
  .option("--force", "overwrite an existing master resume", false)
  .action((opts: { force: boolean }) => {
    const file = resumePath();
    if (resumeExists(file) && !opts.force) {
      console.error(`${file} already exists. Use --force to overwrite it (this destroys your history).`);
      process.exitCode = 1;
      return;
    }
    const profile = loadProfile();
    let location = "";
    try {
      const p = loadPersonal();
      location = [p.identity.city, p.identity.state].filter(Boolean).join(", ");
    } catch {
      // personal.yaml is optional here; the location is a nicety.
    }
    saveResume(scaffoldResume(profile, location), file);
    log.info(`Wrote ${file}`);
    log.info("Seeded: skills from career-profile signals, and the projects you stated when specifying this system.");
    log.info("NOT seeded: employment history. Nothing here knows it.");
    log.info(`Next:  npm run cli -- resume lint`);
  });

resumeCmd
  .command("import <file>")
  .description("Structure an existing resume (txt/md) into the master format")
  .option("--force", "overwrite an existing master resume", false)
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", "reasoning effort (default high)")
  .action(async (file: string, opts: { force: boolean; model?: string; effort?: string }) => {
    const target = resumePath();
    if (resumeExists(target) && !opts.force) {
      console.error(`${target} already exists. Use --force to overwrite it.`);
      process.exitCode = 1;
      return;
    }
    if (!existsSync(file)) {
      console.error(`No such file: ${file}`);
      process.exitCode = 1;
      return;
    }
    const source = readFileSync(file, "utf8");
    if (source.trim().length < 100) {
      console.error("That file is nearly empty. Export your resume to text first.");
      process.exitCode = 1;
      return;
    }

    log.info(`Structuring ${file} (${source.length} chars)`);
    const { resume, uncertain, usage } = await importResume(source, {
      model: opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
      effort: opts.effort ?? "high",
    });
    saveResume(resume, target);

    log.info(`Wrote ${target}`);
    log.info(`  ${resume.experience.length} roles, ${resume.projects.length} projects, ${resume.skills.length} skills`);
    log.info(`  tokens: ${usage.input} in / ${usage.output} out`);
    if (uncertain.length) {
      console.log("");
      console.log("The importer was unsure about these. Check them in the file:");
      for (const u of uncertain) console.log(`  - ${u}`);
    }
    console.log("");
    log.info("Nothing was added that was not in your source. Bullets it could not verify are `verified: false`.");
    log.info(`Next:  npm run cli -- resume lint`);
  });

resumeCmd
  .command("lint")
  .description("Check the master resume for problems that would corrupt a tailored resume")
  .action(() => {
    const resume = loadResume();
    const issues = lintResume(resume);
    const errors = issues.filter((i) => i.level === "error");
    const warnings = issues.filter((i) => i.level === "warning");

    const bullets = allBullets(resume);
    const usable = bullets.filter((b) => b.bullet.verified && b.bullet.skills.length > 0);
    console.log("");
    console.log(`Roles     : ${resume.experience.length}`);
    console.log(`Projects  : ${resume.projects.length}`);
    console.log(`Skills    : ${resume.skills.length}`);
    console.log(`Bullets   : ${bullets.length} total, ${usable.length} usable (verified and skill-tagged)`);
    console.log("");

    for (const e of errors) console.log(`ERROR   ${e.where}: ${e.message}`);
    for (const w of warnings) console.log(`warning ${w.where}: ${w.message}`);
    console.log("");

    if (errors.length) {
      console.log(`${errors.length} error(s). Tailoring is unsafe until these are fixed.`);
      process.exitCode = 1;
    } else if (usable.length < 8) {
      console.log(`Only ${usable.length} usable bullets. Tailoring works but has little to choose from.`);
    } else {
      console.log("Ready to tailor.");
    }
  });

resumeCmd
  .command("match <jobId>")
  .description("Deterministic overlap between your resume and a posting's requirements. No API calls.")
  .action(async (jobId: string) => {
    const resume = loadResume();
    await withRepo("resume-match", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}".`);
        process.exitCode = 1;
        return { ok: false };
      }
      const bullets = allBullets(resume).map((b) => ({ bullet: b.bullet, sourceLabel: b.sourceLabel }));
      const report = matchResumeToJob(resume, job.descriptionClean, bullets);
      console.log("");
      console.log(renderMatchReport(job, report));
      return { ok: true, coverage: report.requiredCoverage };
    });
  });

resumeCmd
  .command("tailor <jobId>")
  .description("Generate a job-specific resume by selecting from the master. Never invents.")
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", "reasoning effort (default high)")
  .option("--no-pdf", "skip PDF generation")
  .action(async (jobId: string, opts: { model?: string; effort?: string; pdf: boolean }) => {
    const resume = loadResume();
    const errors = lintResume(resume).filter((i) => i.level === "error");
    if (errors.length) {
      console.error("The master resume has errors. Fix them first: npm run cli -- resume lint");
      for (const e of errors.slice(0, 5)) console.error(`  ${e.where}: ${e.message}`);
      process.exitCode = 1;
      return;
    }

    await withRepo("resume-tailor", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}".`);
        process.exitCode = 1;
        return { ok: false };
      }

      const bullets = allBullets(resume).map((b) => ({ bullet: b.bullet, sourceLabel: b.sourceLabel }));
      const match = matchResumeToJob(resume, job.descriptionClean, bullets);
      log.info(`Requirement coverage: ${match.requiredCoverage}% required, ${match.preferredCoverage}% preferred`);

      const { plan, violations, reverted, usage } = await tailorResume(resume, job, match, {
        model: opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
        effort: opts.effort ?? "high",
      });

      const composed = composeResume(resume, plan);
      const contact = buildContactLine();
      const md = renderResumeMarkdown(resume, composed, contact);
      const html = renderResumeHtml(resume, composed, contact);

      const dir = packDir(job);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "resume.md"), md, "utf8");
      writeFileSync(resolve(dir, "resume.html"), html, "utf8");
      writeFileSync(resolve(dir, "resume-match.md"), renderMatchReport(job, match), "utf8");
      // Persisted so layout can be iterated on with `resume render`, which
      // costs nothing. Without it, fixing a margin means paying for the whole
      // selection again and risking a different resume.
      writeFileSync(resolve(dir, "resume-plan.json"), JSON.stringify(plan, null, 2), "utf8");

      let pdf: string | null = null;
      if (opts.pdf) {
        pdf = resolve(dir, "resume.pdf");
        await writeResumePdf(html, pdf);
      }

      console.log("");
      console.log(md);
      console.log("");
      log.info(`Positioning: ${plan.positioning}`);
      console.log("");
      log.info(`Written to ${dir}`);
      if (pdf) log.info(`  resume.pdf  <- autofill attaches this automatically`);
      log.info(`  tokens: ${usage.input} in / ${usage.cacheRead} cached / ${usage.output} out`);

      if (violations.length) {
        console.log("");
        console.log("Provenance violations caught and repaired:");
        for (const v of violations) console.log(`  [${v.kind}] ${v.bulletId}: ${v.detail}`);
        if (reverted.length) {
          console.log(`  ${reverted.length} rewrite(s) reverted to your original wording.`);
        }
      }

      if (plan.gapsToExpect.length) {
        console.log("");
        console.log("Gaps this resume does not cover (expect these in a screen):");
        for (const g of plan.gapsToExpect) console.log(`  - ${g}`);
      }
      if (plan.doNotClaim.length) {
        console.log("");
        console.log("Do NOT claim anywhere in this application:");
        for (const d of plan.doNotClaim) console.log(`  - ${d}`);
      }

      return { ok: true, dir };
    });
  });

resumeCmd
  .command("render <jobId>")
  .description("Re-render an already-tailored resume from its saved plan. No API call.")
  .action(async (jobId: string) => {
    const resume = loadResume();
    await withRepo("resume-render", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}".`);
        process.exitCode = 1;
        return { ok: false };
      }
      const dir = packDir(job);
      const planFile = resolve(dir, "resume-plan.json");
      if (!existsSync(planFile)) {
        console.error(`No saved plan at ${planFile}. Run \`resume tailor ${job.id}\` first.`);
        process.exitCode = 1;
        return { ok: false };
      }

      const parsed = TailorSchema.safeParse(JSON.parse(readFileSync(planFile, "utf8")));
      if (!parsed.success) {
        console.error("Saved plan failed validation; re-run `resume tailor`.");
        process.exitCode = 1;
        return { ok: false };
      }

      // Re-check provenance on every render. The master resume may have been
      // edited since the plan was made, and a citation that was valid then
      // could name a bullet that has since changed or been removed.
      const plan = parsed.data;
      const { violations, reverted } = enforceProvenance(resume, plan);

      const composed = composeResume(resume, plan);
      const contact = buildContactLine();
      writeFileSync(resolve(dir, "resume.md"), renderResumeMarkdown(resume, composed, contact), "utf8");
      const html = renderResumeHtml(resume, composed, contact);
      writeFileSync(resolve(dir, "resume.html"), html, "utf8");
      await writeResumePdf(html, resolve(dir, "resume.pdf"));

      log.info(`Re-rendered ${dir}/resume.{md,html,pdf}`);
      if (violations.length) {
        console.log("Provenance re-check caught changes since the plan was made:");
        for (const v of violations) console.log(`  [${v.kind}] ${v.bulletId}: ${v.detail}`);
        if (reverted.length) console.log(`  ${reverted.length} rewrite(s) reverted.`);
      }
      return { ok: true };
    });
  });

/** Contact line for the resume header, from personal.yaml when available. */
function buildContactLine(): string[] {
  try {
    const p = loadPersonal();
    return [
      p.identity.email,
      p.identity.phone,
      [p.identity.city, p.identity.state].filter(Boolean).join(", "),
      p.links.linkedin,
      p.links.github,
      p.links.website,
    ].filter(Boolean);
  } catch {
    return [];
  }
}

// ---- autofill -------------------------------------------------------------

program
  .command("autofill <jobId>")
  .description("Open the application form in a browser and fill it. Never submits.")
  .option("--no-screenshot", "skip saving a screenshot of the filled form")
  .option("--headless", "dry run: verify what would be filled without opening a window", false)
  .action(async (jobId: string, opts: { screenshot: boolean; headless: boolean }) => {
    // Loaded before opening a browser so a missing/invalid config fails fast.
    const personal = loadPersonal();

    await withRepo("autofill", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}". Use \`job-radar top\` to list ids.`);
        process.exitCode = 1;
        return { ok: false };
      }

      const pack = loadPack(job);
      if (!pack) {
        log.warn(`No prepared pack for this job. Run \`job-radar apply ${job.id}\` first for drafted answers.`);
      }

      const dir = packDir(job);
      mkdirSync(dir, { recursive: true });

      // Prefer the resume tailored to this posting over any generic one.
      const tailored = resolve(dir, "resume.pdf");
      const resumeFile = existsSync(tailored) ? tailored : findResume();
      if (!resumeFile) {
        log.warn(`No resume to attach. Generate one: npm run cli -- resume tailor ${job.id}`);
      } else if (resumeFile === tailored) {
        log.info("Attaching the resume tailored to this posting.");
      }

      const result = await autofillApplication(job, personal, pack, {
        screenshotDir: opts.screenshot ? dir : undefined,
        headless: opts.headless,
        ...(resumeFile ? { resumeFile } : {}),
      });

      const report = renderOutcomes(job, result);
      writeFileSync(resolve(dir, "autofill-report.md"), report, "utf8");

      console.log("");
      console.log(report);
      console.log("");

      if (opts.headless) {
        // A dry run proves the classification against the live form. It cannot
        // be used to apply: the filled page is discarded when the browser exits.
        log.info("Dry run complete. Nothing was submitted and the filled form was discarded.");
        log.info(`To actually fill it in a real browser: job-radar autofill ${job.id}`);
        await result.context.close();
      } else {
        log.info("The browser is open and the form is filled. Nothing has been submitted.");
        log.info("Review every field, attach anything missing, then press the button yourself.");
        log.info(`Afterwards: job-radar status ${job.id} APPLIED`);
        log.info("Close the browser window when you are done (or press Ctrl+C here).");

        // Hold the process open so the browser stays up for review. The context
        // is never closed by us on the happy path - the human closes the window.
        await new Promise<void>((done) => {
          result.context.on("close", () => done());
          process.once("SIGINT", () => done());
        });
      }

      return { ok: true, filled: result.outcomes.filter((o) => o.status === "filled").length };
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

      // Regenerate the briefing immediately. Without this the report on disk
      // still shows the job in the slate as if nothing happened, and there is
      // no way to tell a stale page from a live one by looking at it. This is
      // a pure database read, so it costs nothing and touches no network.
      try {
        const { markdown } = buildDailyReport({ repo, profile: loadProfile(), sources: loadSources() });
        writeReport(markdown);
        const html = writeHtmlReport(markdown);
        console.log(`Briefing updated: ${html}`);
      } catch (err) {
        // A stale report is not worth failing a status change over.
        log.warn(`Status saved, but the briefing could not be regenerated: ${(err as Error).message}`);
      }
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
