#!/usr/bin/env node
import { readApplicationHistory, describeHistory } from "./apply/history.js";
import { parseNonNegativeFlag, parseNumericFlag } from "./lib/options.js";
import { listBackups, pruneBackups } from "./lib/backup.js";
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { loadProfile, loadSources, paths, PROJECT_ROOT } from "./config/load.js";
import { loadEnvFile } from "./config/env.js";
import { applyDestructiveMigrations, closeDb, openDb } from "./db/index.js";
import { JobRepo } from "./db/repo.js";
import { runIngest } from "./pipeline/ingest.js";
import { runScoring } from "./pipeline/rescore.js";
import { runAnalysis, DEFAULT_EFFORT, DEFAULT_MODEL, PACK_MODEL } from "./analysis/analyzer.js";
import { buildDailyReport, writeReport } from "./report/daily.js";
import { writeHtmlReport } from "./report/html.js";
import { buildDashboard, writeDashboard } from "./report/dashboard.js";
import { loadPack, packDir, prepareApplication, renderPack, writePack } from "./analysis/prepare.js";
import type { ApplicationPack } from "./analysis/application.js";
import { loadPersonal, personalPath } from "./config/personal.js";
import { autofillApplication, renderOutcomes, snapshotFields } from "./apply/autofill.js";
import { capturableAnswers, saveAnswers, type FieldSnapshot } from "./apply/learn.js";
import { chooseResume } from "./apply/resume-file.js";
import { describeVerdict, endorsementOf } from "./analysis/endorsement.js";
import { loadResume, resumeExists, resumePath, saveResume } from "./resume/load.js";
import { allBullets, lintResume, type Resume } from "./resume/schema.js";
import {
  coverLetterName,
  renderCoverLetterHtml,
  renderCoverLetterMarkdown,
  resumeName,
} from "./resume/documents.js";
import { scaffoldResume } from "./resume/init.js";
import { importResume } from "./resume/import.js";
import { matchResumeToJob } from "./resume/requirements.js";
import { enforceProvenance, tailorResume, TailorSchema } from "./resume/tailor.js";
import { decideReuse, hashFile, readStamps, writeStamp } from "./apply/reuse.js";
import { describeSpend, estimateCostUsd } from "./lib/cost.js";
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
import { startDashboardWatcher, WATCHED_DIRS } from "./report/watch.js";
import { PoliteFetcher } from "./lib/http.js";
import { log, setVerbose } from "./lib/log.js";
import {
  advanceStatus,
  isStatus,
  nextAction,
  GHOSTED_AFTER_DAYS,
  STALE_AFTER_DAYS,
  STATUSES,
  INTERVIEW_STAGES,
} from "./model/status.js";
import { statusAfterAutofill } from "./apply/record.js";
import { isStale, newestBySource, closedPostingMarker, formatAge, isEvergreen, postingAgeDays } from "./model/freshness.js";
import type { EnrichedJob } from "./model/job.js";
import { resolveJob } from "./db/resolve.js";
import { confirmYesNo } from "./lib/prompt.js";
import { formatSalary } from "./lib/salary.js";
import { benchmarkTriage, routingGate, MIN_ROUTING_SAMPLE, type BenchmarkMode } from "./analysis/benchmark.js";
import { scanInbox } from "./inbox/scan.js";
import { GmailSource, EmlDirectorySource } from "./inbox/source.js";
import { ghostable } from "./inbox/ghost.js";
import { scoreSources } from "./stats/sources.js";
import { resolveAnalyzeOptions } from "./analysis/budget.js";

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

/**
 * `JOB_RADAR_NO_RUN_LOG=1` renders without recording a run.
 *
 * Set by the dashboard watcher on the process it spawns. Without it the
 * rebuild writes a row to `runs`, which grows the database file, which the
 * watcher sees as a data change, which triggers another rebuild - forever. It
 * had already written 732 of the 882 rows in that table before anyone noticed.
 *
 * A watcher-triggered render is not a pipeline run in any case: it reads, it
 * writes a page, and it changes nothing worth auditing.
 */
const SKIP_RUN_LOG = process.env.JOB_RADAR_NO_RUN_LOG === "1";

function withRepo<T>(command: string, fn: (repo: JobRepo, db: ReturnType<typeof openDb>) => T | Promise<T>): Promise<T> {
  const db = openDb();
  const repo = new JobRepo(db);
  const runId = SKIP_RUN_LOG ? null : repo.startRun(command);
  return Promise.resolve(fn(repo, db))
    .then((result) => {
      if (runId !== null) repo.finishRun(runId, result ?? {}, true);
      return result;
    })
    .catch((err) => {
      if (runId !== null) repo.finishRun(runId, { error: String(err) }, false);
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
  .option("-m, --min-fit <n>", "only consider jobs at or above this deterministic score (default: no floor, rank order)")
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", `reasoning effort: low|medium|high|xhigh|max (default ${DEFAULT_EFFORT})`)
  .option("--max-spend <usd>", "stop the pass before estimated spend crosses this (default from config)")
  .option("--include-evergreen", "also analyze postings past evergreen_days (they are not recommended)", false)
  .option("--two-stage", "cheap verdict first, dossier only for jobs that earn one", false)
  .option("--dry-run", "show what would be analyzed without calling the API", false)
  .action(async (opts: { limit: string; minFit?: string; model?: string; effort?: string; maxSpend?: string; includeEvergreen: boolean; twoStage: boolean; dryRun: boolean }) => {
    const profile = loadProfile();
    await withRepo("analyze", async (repo) => {
      const summary = await runAnalysis(
        repo,
        profile,
        resolveAnalyzeOptions(opts, profile, {
          model: process.env.JOB_RADAR_MODEL,
          effort: process.env.JOB_RADAR_EFFORT,
        }),
      );
      console.log("");
      console.log(
        `Considered ${summary.considered} | analyzed ${summary.analyzed} | from cache ${summary.fromCache} | failed ${summary.failed}`,
      );
      const kinds = Object.entries(summary.failureKinds);
      if (kinds.length) {
        // Aggregate, because "3 failures" never said whether it was one bug
        // three times or three different postings.
        console.log(`Failures by kind: ${kinds.map(([k, n]) => `${k} ${n}`).join(", ")}.`);
        console.log(`  \`job-radar failures\` shows the reasons, which are now stored per job.`);
      }
      if (summary.dossiers || summary.triageOnly) {
        console.log(
          `Two-tier: ${summary.dossiers} dossier(s), ${summary.triageOnly} triage-only. ` +
            `The triage form is about a quarter of the output bytes of a dossier.`,
        );
      }
      if (summary.parkedAfterFailure) {
        console.log(
          `${summary.parkedAfterFailure} job(s) reached the attempt limit and will not be offered again ` +
            `until their posting changes.`,
        );
      }
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
  .option("--stale-ok", "prepare even if the posting looks closed", false)
  .option("--force", "regenerate the pack even if one for this posting already exists", false)
  .option("--override", "prepare even though the analyst did not endorse applying", false)
  .option("--full", "also generate outreach drafts, interview prep and a negotiation strategy", false)
  .action(
    async (
      jobId: string,
      opts: {
        model?: string;
        effort?: string;
        open: boolean;
        staleOk: boolean;
        force: boolean;
        override: boolean;
        full: boolean;
      },
    ) => {
    const profile = loadProfile();
    await withRepo("apply", async (repo) => {
      const job = repo.get(jobId);
      if (!job) {
        console.error(`No job matches "${jobId}". Use \`job-radar top\` to list ids.`);
        process.exitCode = 1;
        return { ok: false };
      }

      if (refuseIfClosed(repo, job, opts.staleOk, "apply")) {
        process.exitCode = 1;
        return { ok: false, refused: "closed", jobId: job.id };
      }

      if (refuseIfUnendorsed(job, opts.override, "apply")) {
        process.exitCode = 1;
        return { ok: false, refused: "unendorsed", jobId: job.id, verdict: job.analysis?.recommendation ?? null };
      }
      // Recorded, not just printed. An override is a deliberate disagreement
      // with the analyst, and the run log is where that is auditable later.
      const overrodeVerdict = overrideRecord(job, opts.override);

      log.info(`Preparing application material for ${job.company} - ${job.title}`);

      // Same reasoning as `resume tailor`: a re-run of the chain must not pay
      // for the pack again, and the cover note is the part that would silently
      // change underneath a letter already read. See src/apply/reuse.ts.
      const saved = loadPack(job);
      const reuse = decideReuse({
        artifactExists: saved !== null,
        stamp: readStamps(packDir(job)).pack,
        descriptionHash: job.descriptionHash,
        resumeHash: hashFile(resumePath()),
        force: opts.force,
        wantFull: opts.full,
      });

      let pack: ApplicationPack;
      let usage: Awaited<ReturnType<typeof prepareApplication>>["usage"] | null = null;
      if (reuse.reuse && saved) {
        log.info(reuse.why);
        pack = saved;
      } else {
        if (!reuse.reuse && saved) log.info(reuse.why);
        const fresh = await prepareApplication(job, profile, {
          // Effort stays high: this output is read closely by a human and acted
          // on. The saving comes from the model tier and from not generating
          // later-stage sections, not from thinking less about the ones kept.
          model: opts.model ?? process.env.JOB_RADAR_MODEL ?? PACK_MODEL,
          effort: opts.effort ?? "high",
          full: opts.full,
        });
        pack = fresh.pack;
        usage = fresh.usage;
        writeStamp(packDir(job), "pack", {
          descriptionHash: job.descriptionHash,
          resumeHash: hashFile(resumePath()),
          generatedAt: new Date().toISOString(),
          full: opts.full === true,
        });
      }

      const markdown = renderPack(job, pack, profile);
      const { dir, md, html } = writePack(job, markdown, pack);

      // APPLY, not APPLIED. Recording an application that has not been
      // submitted would corrupt the funnel metrics with a phantom data point,
      // and the funnel is the thing that tells him what to fix. APPLY is the
      // intent half of that pair, and `stagesReached` maps it to QUALIFIED
      // exactly as SAVED was, so the APPLIED count does not move here.
      //
      // Conditional, because this used to be an unconditional write: preparing
      // a fresh pack for a role already at SCREEN dragged it back down the
      // funnel. advanceStatus refuses every backwards move.
      const nextStatus = advanceStatus(job.status, "APPLY");
      if (nextStatus) {
        repo.setStatus(job.id, nextStatus, "Application pack prepared; not yet submitted");
      }

      console.log("");
      console.log(markdown);
      console.log("");
      // The cover note was already written, specific to this posting, and then
      // buried as one section of a long markdown pack - no header, no contact
      // details, no PDF, nothing a form could accept. Render it as a real
      // document. Nothing is rewritten here: the renderer lays out the text it
      // was given, which came from the prompt that forbids inventing anything.
      let coverPdf: string | null = null;
      if (pack.coverNote?.trim()) {
        const who = candidateName();
        const contactLine = buildContactLine();
        const base = coverLetterName(who, job.company, "");
        writeFileSync(
          resolve(dir, `${base}md`),
          renderCoverLetterMarkdown(who, job.company, job.title, pack.coverNote, contactLine),
          "utf8",
        );
        const coverHtml = renderCoverLetterHtml(who, job.company, job.title, pack.coverNote, contactLine);
        writeFileSync(resolve(dir, `${base}html`), coverHtml, "utf8");
        coverPdf = resolve(dir, coverLetterName(who, job.company));
        await writeResumePdf(coverHtml, coverPdf);
      }

      log.info(`Pack written to ${dir}`);
      log.info(`  markdown : ${md}`);
      log.info(`  html     : ${html}`);
      if (coverPdf) log.info(`  cover    : ${basename(coverPdf)}  <- autofill attaches this`);
      const packModel = opts.model ?? process.env.JOB_RADAR_MODEL ?? PACK_MODEL;
      log.info(
        usage
          ? `  spend    : ${describeSpend(usage, packModel)}`
          : `  spend    : $0.00 - reused the saved pack. \`--force\` to regenerate.`,
      );
      log.info(
        nextStatus
          ? `Status ${job.status} -> ${nextStatus}. After you actually submit: job-radar status ${job.id} APPLIED`
          : `Status left at ${job.status} - this job is already past "marked to apply", so nothing was changed.`,
      );
      log.info(`To fill the real form in a browser: job-radar autofill ${job.id}`);

      if (opts.open) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        const child = spawn(cmd, [html], { detached: true, stdio: "ignore" });
        child.on("error", () => console.log(`Open it yourself: file://${html}`));
        child.unref();
      }

      return {
        ok: true,
        dir,
        reused: !usage,
        ...overrodeVerdict,
        ...(usage ? { ...usage, estimatedCostUsd: estimateCostUsd(usage, packModel) } : { estimatedCostUsd: 0 }),
      };
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
  .option("--stale-ok", "prepare even if the posting looks closed", false)
  .option("--force", "re-select bullets even if a plan for this posting already exists", false)
  .option("--override", "prepare even though the analyst did not endorse applying", false)
  .action(
    async (
      jobId: string,
      opts: { model?: string; effort?: string; pdf: boolean; staleOk: boolean; force: boolean; override: boolean },
    ) => {
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

      if (refuseIfClosed(repo, job, opts.staleOk, "resume tailor")) {
        process.exitCode = 1;
        return { ok: false, refused: "closed", jobId: job.id };
      }

      if (refuseIfUnendorsed(job, opts.override, "resume tailor")) {
        process.exitCode = 1;
        return { ok: false, refused: "unendorsed", jobId: job.id, verdict: job.analysis?.recommendation ?? null };
      }
      // See `apply`: the deliberate disagreement belongs in the run log.
      const overrodeVerdict = overrideRecord(job, opts.override);

      const bullets = allBullets(resume).map((b) => ({ bullet: b.bullet, sourceLabel: b.sourceLabel }));
      const match = matchResumeToJob(resume, job.descriptionClean, bullets);
      log.info(`Requirement coverage: ${match.requiredCoverage}% required, ${match.preferredCoverage}% preferred`);

      // Re-running the chain must not silently pay again, and must not silently
      // hand back a DIFFERENT resume for the same posting - which selection
      // would, being a model decision. See src/apply/reuse.ts.
      const planFile = resolve(packDir(job), "resume-plan.json");
      const resumeHash = hashFile(resumePath());
      const savedPlan = existsSync(planFile)
        ? TailorSchema.safeParse(JSON.parse(readFileSync(planFile, "utf8")))
        : null;
      const reuse = decideReuse({
        artifactExists: savedPlan?.success === true,
        stamp: readStamps(packDir(job)).resumePlan,
        descriptionHash: job.descriptionHash,
        resumeHash,
        force: opts.force,
      });

      let plan: Awaited<ReturnType<typeof tailorResume>>["plan"];
      let violations: Awaited<ReturnType<typeof tailorResume>>["violations"];
      let reverted: Awaited<ReturnType<typeof tailorResume>>["reverted"];
      let usage: Awaited<ReturnType<typeof tailorResume>>["usage"] | null = null;

      if (reuse.reuse && savedPlan?.success) {
        log.info(reuse.why);
        plan = savedPlan.data;
        // Provenance is re-checked on every reuse, never assumed to still hold:
        // the master resume may have moved under a citation that was valid when
        // the plan was made.
        ({ violations, reverted } = enforceProvenance(resume, plan));
      } else {
        if (!reuse.reuse && savedPlan?.success) log.info(reuse.why);
        const fresh = await tailorResume(resume, job, match, {
          model: opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL,
          effort: opts.effort ?? "high",
        });
        ({ plan, violations, reverted, usage } = fresh);
      }

      const composed = composeResume(resume, plan);
      const contact = buildContactLine();
      const md = renderResumeMarkdown(resume, composed, contact);
      const html = renderResumeHtml(resume, composed, contact);

      const dir = packDir(job);
      mkdirSync(dir, { recursive: true });
      // Named for the person and the company. The filename is what a recruiter
      // reads in the attachment list, and "resume.pdf" reads as a mass
      // application. Derived, never stored, so every command computes the same
      // name from the same two inputs.
      const base = resumeName(resume.basics.name, job.company, "");
      writeFileSync(resolve(dir, `${base}md`), md, "utf8");
      writeFileSync(resolve(dir, `${base}html`), html, "utf8");
      writeFileSync(resolve(dir, "resume-match.md"), renderMatchReport(job, match), "utf8");
      // Persisted so layout can be iterated on with `resume render`, which
      // costs nothing. Without it, fixing a margin means paying for the whole
      // selection again and risking a different resume.
      if (usage) {
        writeFileSync(resolve(dir, "resume-plan.json"), JSON.stringify(plan, null, 2), "utf8");
        writeStamp(dir, "resumePlan", {
          descriptionHash: job.descriptionHash,
          resumeHash,
          generatedAt: new Date().toISOString(),
        });
      }

      let pdf: string | null = null;
      if (opts.pdf) {
        pdf = resolve(dir, resumeName(resume.basics.name, job.company));
        await writeResumePdf(html, pdf);
      }

      console.log("");
      console.log(md);
      console.log("");
      log.info(`Positioning: ${plan.positioning}`);
      console.log("");
      log.info(`Written to ${dir}`);
      if (pdf) log.info(`  ${basename(pdf)}  <- autofill attaches this automatically`);
      const tailorModel = opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL;
      log.info(
        usage
          ? `  spend : ${describeSpend(usage, tailorModel)}`
          : `  spend : $0.00 - reused the saved plan. \`--force\` to re-select.`,
      );

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

      // Recorded so `stats` can total real spend later. This used to return
      // {ok, dir} and nothing else, which is how 30 runs of the most expensive
      // command in the tool cost money without leaving a trace.
      return {
        ok: true,
        dir,
        reused: !usage,
        ...overrodeVerdict,
        ...(usage ? { ...usage, estimatedCostUsd: estimateCostUsd(usage, tailorModel) } : { estimatedCostUsd: 0 }),
      };
    });
  });

resumeCmd
  .command("render <jobId>")
  .description("Re-render the tailored resume, and the cover letter, from what is already saved. No API call.")
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
      const base = resumeName(resume.basics.name, job.company, "");
      writeFileSync(resolve(dir, `${base}md`), renderResumeMarkdown(resume, composed, contact), "utf8");
      const html = renderResumeHtml(resume, composed, contact);
      writeFileSync(resolve(dir, `${base}html`), html, "utf8");
      await writeResumePdf(html, resolve(dir, resumeName(resume.basics.name, job.company)));

      log.info(`Re-rendered ${dir}/${resumeName(resume.basics.name, job.company, "")}{md,html,pdf}`);

      // The cover note is already on disk in pack.json. Rendering it here costs
      // nothing and means an application prepared before cover letters were
      // documents does not have to be paid for twice.
      const saved = loadPack(job);
      if (saved?.coverNote?.trim()) {
        const who = candidateName();
        const base = coverLetterName(who, job.company, "");
        writeFileSync(
          resolve(dir, `${base}md`),
          renderCoverLetterMarkdown(who, job.company, job.title, saved.coverNote, contact),
          "utf8",
        );
        const coverHtml = renderCoverLetterHtml(who, job.company, job.title, saved.coverNote, contact);
        writeFileSync(resolve(dir, `${base}html`), coverHtml, "utf8");
        await writeResumePdf(coverHtml, resolve(dir, coverLetterName(who, job.company)));
        log.info(`Re-rendered ${coverLetterName(who, job.company)}`);
      } else {
        log.info("No saved cover note for this job - run `apply` to write one.");
      }
      if (violations.length) {
        console.log("Provenance re-check caught changes since the plan was made:");
        for (const v of violations) console.log(`  [${v.kind}] ${v.bulletId}: ${v.detail}`);
        if (reverted.length) console.log(`  ${reverted.length} rewrite(s) reverted.`);
      }
      return { ok: true };
    });
  });

/**
 * Stop before spending on a posting the board has stopped listing.
 *
 * This is an inference, not proof - a provider can drop a posting for a minute
 * - so it gates only the two commands that cost money, and `--stale-ok`
 * overrides it. Everywhere else a stale posting is flagged, never hidden.
 */
function refuseIfClosed(repo: JobRepo, job: EnrichedJob, override: boolean, command: string): boolean {
  if (override) return false;
  const newest = newestBySource(repo.allSightings());
  if (!isStale({ id: job.id, source: job.source, lastSeen: job.lastSeen }, newest)) return false;

  console.error(
    `${job.company} - ${job.title} looks closed.\n` +
      `Its board was swept more recently (${newest.get(job.source)?.slice(0, 16)}) than this posting was last seen ` +
      `on it (${job.lastSeen?.slice(0, 16)}), which usually means it was taken down.\n\n` +
      `Nothing was spent. Re-check with \`npm run cli -- ingest\`, or if you know it is still live:\n` +
      `  npm run cli -- ${command} ${job.id} --stale-ok`,
  );
  return true;
}

/**
 * Stop before preparing an application the analyst said not to make.
 *
 * Shaped deliberately like `refuseIfClosed`: gate only the two commands that
 * spend, print what is known, name the override, and never hide the posting
 * anywhere else. The difference is what is being disagreed with - a closed
 * posting is a fact about the board, an unendorsed verdict is a judgement, and
 * the person applying may well be right where the model is wrong.
 *
 * `unanalyzed` deliberately does NOT refuse. There is no verdict to disagree
 * with, and the only way to satisfy such a gate would be to spend on an
 * analysis - turning a warning into a bill. It warns and proceeds.
 *
 * Returns true when the caller should stop.
 */
function refuseIfUnendorsed(job: EnrichedJob, override: boolean, command: string): boolean {
  const e = endorsementOf(job);

  if (e.tier === "unanalyzed") {
    log.warn(`This job has not been analyzed. Run \`analyze\` first for a much better package.`);
    return false;
  }

  if (e.tier === "endorsed") {
    log.info(`Analyst verdict: ${describeVerdict(e)}`);
    return false;
  }

  if (override) {
    log.warn(
      `Overriding the analyst: verdict is ${describeVerdict(e)}, preparing anyway.` +
        (e.reason ? `\n  Its reasoning: ${e.reason}` : ""),
    );
    return false;
  }

  console.error(
    `${job.company} - ${job.title} is not endorsed: the analyst said ${describeVerdict(e)}.\n` +
      (e.reason ? `Its reasoning: ${e.reason}\n` : "It recorded no reasoning.\n") +
      `\nNothing was spent. If you disagree - and you may well be right:\n` +
      `  npm run cli -- ${command} ${job.id} --override`,
  );
  return true;
}

/**
 * The run-stats fragment recording that a human overrode the analyst.
 *
 * Empty when there was nothing to override, so an ordinary endorsed run does
 * not carry a misleading `overrodeVerdict: null` that a later query would have
 * to special-case.
 */
function overrideRecord(job: EnrichedJob, override: boolean): { overrodeVerdict?: string } {
  if (!override) return {};
  const e = endorsementOf(job);
  return e.tier === "unendorsed" && e.verdict ? { overrodeVerdict: e.verdict } : {};
}

/**
 * The candidate's name for a document header and filename.
 *
 * The master resume is the source of truth for how the name is written on a
 * document; personal.yaml is the fallback for someone who has not imported a
 * resume yet.
 */
function candidateName(): string {
  try {
    if (resumeExists()) return loadResume().basics.name;
  } catch {
    // Fall through to personal.yaml.
  }
  try {
    const p = loadPersonal();
    return `${p.identity.first_name} ${p.identity.last_name}`.trim();
  } catch {
    return "Candidate";
  }
}

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

      // Prefer the resume tailored to this posting over any generic one. The
      // choice is made once, here, and handed over whole: `autofill` reports
      // which file it attached and what it passed over, and it cannot label a
      // generic resume "tailored" from a bare path.
      // The tailored file is named for the person and the company. The legacy
      // `resume.pdf` is still accepted so packs generated before that change
      // keep working.
      const who = candidateName();
      const namedResume = resolve(dir, resumeName(who, job.company));
      const legacyResume = resolve(dir, "resume.pdf");
      const tailored = existsSync(namedResume) ? namedResume : legacyResume;
      const resume = chooseResume(existsSync(tailored) ? tailored : undefined);
      if (!resume) {
        log.warn(`No resume to attach. Generate one: npm run cli -- resume tailor ${job.id}`);
      } else if (resume.source === "tailored") {
        log.info("Attaching the resume tailored to this posting.");
      } else {
        log.info(`Attaching the newest resume in resumes/: ${basename(resume.path)}`);
      }

      // Employment-history fields are answered from the master resume, so there
      // is one source of truth for where you work. Autofill still runs without
      // it - those fields are reported instead of guessed.
      let masterResume: Resume | undefined;
      try {
        masterResume = loadResume();
      } catch {
        log.warn("No master resume, so current employer/title will be left for you.");
      }

      // A cover letter is a document now, not a paragraph to copy out of a
      // markdown file, so a form that asks for one can be given it.
      const namedCover = resolve(dir, coverLetterName(who, job.company));
      const coverLetter = existsSync(namedCover) ? namedCover : undefined;
      if (coverLetter) log.info(`Attaching the cover letter: ${basename(namedCover)}`);

      const result = await autofillApplication(job, personal, pack, {
        screenshotDir: opts.screenshot ? dir : undefined,
        headless: opts.headless,
        ...(resume ? { resume } : {}),
        ...(masterResume ? { masterResume } : {}),
        ...(coverLetter ? { coverLetter } : {}),
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
        log.info("Close the browser window when you are done (or press Ctrl+C here).");

        // Keep reading the form back while it is open, so anything typed by
        // hand can be offered to personal.yaml and reused on the next
        // application. Polling rather than reading once at the end: submitting
        // navigates the page away, and the last good read before that is
        // exactly the one worth keeping.
        let snapshot: FieldSnapshot[] = [];
        const watcher = setInterval(() => {
          void snapshotFields(result.page)
            .then((s) => {
              if (s.length) snapshot = s;
            })
            .catch(() => {
              /* navigating, or already gone - keep the last good read */
            });
        }, 2000);

        // Hold the process open so the browser stays up for review. The context
        // is never closed by us on the happy path - the human closes the window.
        const interrupted = await new Promise<boolean>((done) => {
          const onSigint = () => done(true);
          result.context.on("close", () => {
            // Without this removal the handler outlives the wait, and because
            // any SIGINT listener suppresses Node's default exit, Ctrl+C at the
            // prompt below would be swallowed and the process would not die.
            process.removeListener("SIGINT", onSigint);
            done(false);
          });
          process.once("SIGINT", onSigint);
        });

        // Asked AFTER the browser closes, because that is when the human knows
        // the answer. Asking while the form is still open would be asking them
        // to predict themselves, and a predicted APPLIED is the phantom data
        // point the funnel must not contain.
        //
        // This records; it does not submit, and it does not look at the page to
        // work out what happened. Whether the form went through is a fact the
        // human owns, and inferring it from a URL or a success-looking screen
        // would be guessing at it.
        clearInterval(watcher);

        // Offer to keep what they answered by hand. Demographic questions and
        // attestations are filtered out inside `capturableAnswers` - storing
        // one would make the tool answer it automatically next time, which is
        // the refusal turned inside out.
        const learnable = capturableAnswers(snapshot, result.outcomes, personal.answers);
        if (learnable.length) {
          console.log("");
          console.log(`You answered ${learnable.length} question(s) by hand:`);
          for (const a of learnable) {
            console.log(`  Q: ${a.match}`);
            console.log(`  A: ${a.answer.length > 100 ? `${a.answer.slice(0, 99)}...` : a.answer}`);
          }
          const save = await confirmYesNo("Save these to personal.yaml so they fill themselves next time?");
          if (save) {
            const backup = saveAnswers(personalPath(), learnable);
            log.info(`Saved ${learnable.length} answer(s). Backup: ${backup}`);
          } else {
            log.info("Not saved.");
          }
        }

        if (!interrupted) {
          console.log("");
          console.log("The form is filled and NOT submitted. Nothing was sent.");
          const confirmed = await confirmYesNo("If you submitted it yourself, record that here?");
          const recorded = statusAfterAutofill(job.status, confirmed);
          if (recorded) {
            repo.setStatus(job.id, recorded);
            log.info(`Recorded: ${job.status} -> ${recorded}`);
          } else if (confirmed) {
            log.info(
              `Status left at ${job.status} - it is already past APPLIED, or parked. ` +
                `Change it yourself if that is wrong: job-radar status ${job.id} <status>`,
            );
          } else {
            log.info(`Nothing recorded. When you do submit: job-radar status ${job.id} APPLIED`);
          }
        }
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

      // GHOSTED sweep. It belongs in the daily pass rather than in `inbox`
      // because it is not driven by an email arriving - it is driven by one
      // never arriving, which only elapsed time can tell you.
      const ghosts = ghostable(repo.ghostCandidates(), {
        afterDays: profile.inbox.ghost_after_days,
        from: profile.inbox.ghost_from,
      });
      for (const g of ghosts) {
        repo.setStatus(g.id, "GHOSTED", `no response in ${profile.inbox.ghost_after_days} days`);
      }
      if (ghosts.length) {
        log.info(
          `Ghosted ${ghosts.length} application(s) silent for over ${profile.inbox.ghost_after_days} days: ` +
            ghosts.map((g) => g.company).join(", "),
        );
      }

      let scoreSummary = runScoring(repo, profile, db);

      if (opts.analyze) {
        // The same resolver the `analyze` command uses, and that is the fix
        // rather than a tidy-up: this call site used to omit maxSpendUsd
        // entirely, so `shouldStopForBudget` saw undefined and the daily pass
        // ran with NO CEILING - unattended, on a timer, which is the one place
        // nobody is watching.
        const analysis = await runAnalysis(
          repo,
          profile,
          resolveAnalyzeOptions({ limit: opts.analyzeLimit }, profile, {
            model: process.env.JOB_RADAR_MODEL,
            effort: process.env.JOB_RADAR_EFFORT,
          }, 8),
        );
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
      // The cumulative view is regenerated in the same pass, so the landing
      // page can never be older than the briefing sitting next to it.
      const dashFile = writeDashboard(buildDashboard({ repo, sources: sourcesConfig }));

      console.log("");
      console.log(markdown);
      console.log("");
      log.info(`Report written (${jobCount} actionable roles):`);
      log.info(`  markdown  : ${file}`);
      log.info(`  briefing  : ${htmlFile}`);
      log.info(`  dashboard : ${dashFile}`);
      log.info(`  open it   : npm run cli -- open`);
      return { jobCount, file, htmlFile, dashFile };
    });
  });

// ---- spend ----------------------------------------------------------------

program
  .command("spend")
  .description("What this tool has cost, by command and by day. Reads the run log; no network.")
  .option("-d, --days <n>", "how many days back", "30")
  .action(async (opts: { days: string }) => {
    await withRepo("spend", (repo) => {
      const days = Number(opts.days) || 30;
      const rows = repo.spendByCommand(days);
      const total = rows.reduce((sum, r) => sum + r.usd, 0);

      if (!rows.length) {
        console.log("No recorded spend. Note that runs before this command existed recorded none.");
        return { total: 0 };
      }

      console.log("");
      console.log(`${"COMMAND".padEnd(16)} ${"RUNS".padStart(5)} ${"PAID".padStart(5)} ${"USD".padStart(9)}`);
      console.log("-".repeat(40));
      for (const r of rows) {
        console.log(
          `${r.command.padEnd(16)} ${String(r.runs).padStart(5)} ${String(r.paid).padStart(5)} ${`$${r.usd.toFixed(2)}`.padStart(9)}`,
        );
      }
      console.log("-".repeat(40));
      console.log(`${"TOTAL".padEnd(16)} ${"".padStart(5)} ${"".padStart(5)} ${`$${total.toFixed(2)}`.padStart(9)}`);
      console.log("");
      console.log(`Last ${days} days. "PAID" counts runs that actually called a model;`);
      console.log(`the rest reused what was already on disk and cost nothing.`);
      // The run log is not the bill. Cost logging for resume-tailor and apply
      // only began 2026-08-19 (70 earlier paid runs recorded $0), and API use
      // outside this tool never reaches the log at all. Presenting these
      // figures as the whole bill is how a $17 day went unexplained.
      console.log(`Figures are lower bounds: tailor/apply cost logging began 2026-08-19,`);
      console.log(`and API use outside this tool is not recorded here.`);
      return { total };
    });
  });

// ---- inbox ------------------------------------------------------------------

program
  .command("inbox")
  .description("Read application mail and update job status (read-only on the mailbox)")
  .option("-l, --limit <n>", "max messages to read")
  .option("--apply", "write the status changes; without this it only reports", false)
  .option("--all", "ignore the last-scanned watermark and re-read everything", false)
  .option("--eml <dir>", "read .eml files from a directory instead of Gmail")
  .action(async (opts: { limit?: string; apply: boolean; all: boolean; eml?: string }) => {
    const profile = loadProfile();
    const emlDir = opts.eml ?? profile.inbox.eml_dir;
    const source = emlDir ? new EmlDirectorySource(emlDir) : GmailSource.fromEnv(profile.inbox.gmail_query);

    if (!source) {
      console.log("");
      console.log("No mail source configured.");
      console.log("  Gmail: set JOB_RADAR_GMAIL_CLIENT_ID, JOB_RADAR_GMAIL_CLIENT_SECRET and");
      console.log("         JOB_RADAR_GMAIL_REFRESH_TOKEN (scope: gmail.readonly).");
      console.log("  Or:    point `inbox.eml_dir` at a directory of .eml files, or pass --eml <dir>.");
      return;
    }

    await withRepo("inbox", async (repo) => {
      const summary = await scanInbox(repo, source, {
        limit: opts.limit ? Number(opts.limit) : profile.inbox.scan_limit,
        apply: opts.apply,
        since: opts.all ? null : undefined,
      });

      console.log("");
      console.log(
        `Read ${summary.fetched} message(s) from ${source.name} | ` +
          `already seen ${summary.alreadySeen} | no signal ${summary.ignored}`,
      );
      console.log(
        `Matched ${summary.matched} | status changes ${summary.transitioned} | ` +
          `ambiguous ${summary.ambiguous} | unmatched ${summary.unmatched}`,
      );

      for (const c of summary.changes) {
        console.log(`  ${c.company} - ${c.title}: ${c.from} -> ${c.to}  (${c.messageId})`);
      }

      if (summary.ambiguous || summary.unmatched) {
        console.log("");
        console.log(
          `${summary.ambiguous + summary.unmatched} message(s) went to review rather than being guessed at. ` +
            `\`job-radar inbox-review\` lists them.`,
        );
      }
      if (!opts.apply && (summary.transitioned || summary.ambiguous || summary.unmatched)) {
        console.log("");
        console.log("Nothing was written. Re-run with --apply to record these.");
      }
      return { fetched: summary.fetched, transitioned: summary.transitioned };
    });
  });

program
  .command("inbox-review")
  .description("Application mail that could not be resolved to exactly one job")
  .option("-l, --limit <n>", "how many to show", "30")
  .action(async (opts: { limit: string }) => {
    await withRepo("inbox-review", (repo) => {
      const rows = repo.emailsNeedingReview(Number(opts.limit) || 30);
      if (rows.length === 0) {
        console.log("Nothing awaiting review.");
        return { count: 0 };
      }
      console.log("");
      for (const r of rows) {
        console.log(`${r.receivedAt.slice(0, 10)}  [${r.resolution}] ${r.kinds}`);
        console.log(`  from   : ${r.from}`);
        console.log(`  subject: ${r.subject}`);
        if (r.note) console.log(`  why    : ${r.note}`);
        console.log("");
      }
      console.log(`${rows.length} message(s). Resolve with \`job-radar status <job-id> <STATUS>\`.`);
      return { count: rows.length };
    });
  });

// ---- benchmark-triage -------------------------------------------------------

program
  .command("benchmark-triage")
  .description("Check the cheap triage verdict against existing full verdicts (COSTS MONEY)")
  .option("-l, --limit <n>", "how many analyzed jobs to re-run", "25")
  .option("--model <id>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--effort <level>", `reasoning effort (default ${DEFAULT_EFFORT})`)
  .option("--yes", "actually make the calls; without this it only estimates", false)
  .option(
    "--mode <mode>",
    "verdict (can triage REPLACE the dossier?) or routing (can it decide WHO GETS one?)",
    "verdict",
  )
  .action(async (opts: { limit: string; model?: string; effort?: string; yes: boolean; mode: string }) => {
    const profile = loadProfile();
    const limit = Number(opts.limit) || 25;
    const model = opts.model ?? process.env.JOB_RADAR_MODEL ?? DEFAULT_MODEL;
    if (opts.mode !== "verdict" && opts.mode !== "routing") {
      console.error(`--mode must be "verdict" or "routing", not "${opts.mode}".`);
      process.exitCode = 1;
      return;
    }
    const mode = opts.mode as BenchmarkMode;
    await withRepo("benchmark-triage", async (repo) => {
      const policy = {
        recommendations: profile.analysis_detail.dossier_for,
        minFit: profile.analysis_detail.dossier_min_fit,
      };
      const sample =
        mode === "routing" ? repo.analyzedSample(limit, { split: "dossier", policy }) : repo.analyzedSample(limit);
      if (!opts.yes) {
        // This spends real money, so it says so and stops. The estimate is
        // rough on purpose - it is a guard against a surprise, not an invoice.
        console.log("");
        console.log(`Would re-run ${sample.length} already-analyzed job(s) through the triage form.`);
        console.log(`Mode: ${mode}. Model: ${model}. Rough estimate: $${(sample.length * 0.02).toFixed(2)}.`);
        if (mode === "routing") {
          console.log(`Sample is partitioned by \`deservesDossier\` itself, so the gate cannot`);
          console.log(`disagree with the function it gates. Needs >=${MIN_ROUTING_SAMPLE} baselines to be conclusive.`);
        } else {
          console.log(`Sample skews toward apply/network verdicts on purpose - a uniform sample`);
          console.log(`would be mostly skips and would say nothing about the decision that matters.`);
        }
        console.log("");
        console.log("Re-run with --yes to actually make the calls.");
        return { estimated: sample.length, mode };
      }

      const result = await benchmarkTriage(repo, profile, {
        limit,
        model,
        effort: opts.effort ?? process.env.JOB_RADAR_EFFORT ?? DEFAULT_EFFORT,
        mode,
      });

      const pct = (result.agreementRate * 100).toFixed(1);
      console.log("");
      console.log(`Compared ${result.compared} job(s), ${result.failed} failed.`);
      console.log(`Apply-vs-not agreement: ${result.agreeOnApply}/${result.compared} = ${pct}%`);
      console.log(`Mean absolute fit delta: ${result.meanAbsFitDelta.toFixed(1)} points`);
      console.log(`Spent about $${result.estimatedCostUsd.toFixed(4)}.`);

      if (result.missedApplies.length) {
        console.log("");
        console.log(`Missed applies (${result.missedApplies.length}) - the expensive kind of miss:`);
        for (const r of result.missedApplies) {
          console.log(`  ${r.company} - ${r.title}: ${r.baselineRecommendation} -> ${r.triageRecommendation}`);
        }
      }
      if (result.spuriousApplies.length) {
        console.log("");
        console.log(`Invented applies (${result.spuriousApplies.length}) - wastes time rather than hiding a role:`);
        for (const r of result.spuriousApplies) {
          console.log(`  ${r.company} - ${r.title}: ${r.baselineRecommendation} -> ${r.triageRecommendation}`);
        }
      }

      // Both questions are reported on every run - the calls have been paid for
      // either way - but only the mode's own number is the gate.
      const routingPct = (result.routingAgreementRate * 100).toFixed(1);
      console.log("");
      console.log(`Routing agreement: ${result.compared - result.missedDossiers.length - result.extraDossiers.length}/${result.compared} = ${routingPct}%`);
      console.log(`  missed dossiers: ${result.missedDossiers.length} (blocking)`);
      console.log(`  extra dossiers : ${result.extraDossiers.length} (a cost line, ~$0.046 each)`);
      for (const r of result.missedDossiers) {
        console.log(`  MISSED: ${r.company} - ${r.title}: ${r.baselineRecommendation} -> ${r.triageRecommendation}`);
      }

      console.log("");
      const BAR = 0.92;
      if (mode === "verdict") {
        if (result.agreementRate >= BAR) {
          console.log(`PASS: ${pct}% is at or above the ${(BAR * 100).toFixed(0)}% bar.`);
          console.log(`Set analysis_detail.two_stage: true in config/career-profile.yaml.`);
        } else {
          console.log(`FAIL: ${pct}% is below the ${(BAR * 100).toFixed(0)}% bar.`);
          console.log(`Leave analysis_detail.two_stage: false. The dossier's forced strengths and`);
          console.log(`risks fields are likely doing real reasoning work, not just producing prose.`);
          console.log(`That answers "can triage REPLACE the dossier?". The code only uses triage`);
          console.log(`as a ROUTER - re-run with --mode routing to measure what it actually does.`);
        }
      } else {
        const gate = routingGate(result);
        console.log(`${gate.verdict}: ${gate.reason}`);
        console.log(
          `Measured against dossier_for=[${result.policy.recommendations.join(", ")}], dossier_min_fit=${result.policy.minFit}.`,
        );
        if (gate.verdict === "PASS") {
          console.log(`Set analysis_detail.two_stage: true in config/career-profile.yaml.`);
        } else if (gate.verdict === "INCONCLUSIVE") {
          console.log(`Re-run with --limit ${MIN_ROUTING_SAMPLE} or more. Do NOT read 0 misses on a small`);
          console.log(`sample as a pass - that is an unmeasured change wearing a measurement's clothes.`);
        }
      }
      return {
        mode,
        compared: result.compared,
        agreementRate: result.agreementRate,
        routingAgreementRate: result.routingAgreementRate,
        missedDossiers: result.missedDossiers.length,
        extraDossiers: result.extraDossiers.length,
      };
    });
  });

// ---- failures ---------------------------------------------------------------

program
  .command("failures")
  .description("Jobs whose analysis failed, with the reason and attempt count")
  .option("-l, --limit <n>", "how many to show", "30")
  .action(async (opts: { limit: string }) => {
    const profile = loadProfile();
    await withRepo("failures", (repo) => {
      const rows = repo.analysisFailures(Number(opts.limit) || 30);
      if (rows.length === 0) {
        console.log("No recorded analysis failures.");
        return { count: 0 };
      }
      const budget = profile.scoring.analysis_max_attempts;
      console.log("");
      console.log(`${"ID".padEnd(13)} ${"N".padStart(2)} ${"KIND".padEnd(13)} ${"WHEN".padEnd(11)} COMPANY / REASON`);
      console.log("-".repeat(120));
      for (const r of rows) {
        const parked = r.failures >= budget ? " [PARKED]" : "";
        console.log(
          `${r.id.padEnd(13)} ${String(r.failures).padStart(2)} ${(r.kind ?? "-").padEnd(13)} ` +
            `${(r.failedAt ?? "").slice(0, 10).padEnd(11)} ${r.company}${parked}`,
        );
        console.log(`${" ".repeat(14)}${(r.reason ?? "").slice(0, 100)}`);
      }
      const byKind = new Map<string, number>();
      for (const r of rows) byKind.set(r.kind ?? "unknown", (byKind.get(r.kind ?? "unknown") ?? 0) + 1);
      console.log("");
      console.log(`By kind: ${[...byKind].map(([k, n]) => `${k} ${n}`).join(", ")}.`);
      console.log(
        `A job at ${budget} attempts is not offered for paid analysis again until its posting changes.`,
      );
      return { count: rows.length };
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
  .option("--include-evergreen", `include postings older than ${"evergreen_days"} (default: hidden)`, false)
  .action(async (opts: { limit: string; all: boolean; lane?: string; minFit?: string; includeEvergreen: boolean }) => {
    const profile = loadProfile();
    await withRepo("top", (repo) => {
      const minFit = opts.minFit ? Number(opts.minFit) : profile.scoring.report_threshold;
      const evergreenDays = opts.includeEvergreen ? null : profile.scoring.evergreen_days;
      let jobs = repo.top({
        minFit,
        limit: Number(opts.limit) * 3 || 45,
        includeReviewed: opts.all,
        evergreenDays,
      });
      if (opts.lane) jobs = jobs.filter((j) => j.lane === opts.lane);
      jobs = jobs.slice(0, Number(opts.limit) || 15);

      if (jobs.length === 0) {
        console.log("No jobs match. Try --all, a lower --min-fit, or run `ingest` first.");
        return { count: 0 };
      }

      // A posting the board has stopped listing costs two model calls to
      // prepare and then opens a browser on a generic job list. Flag it here,
      // before anything is spent on it.
      const newest = newestBySource(repo.allSightings());
      const stale = new Set(jobs.filter((j) => isStale({ id: j.id, source: j.source, lastSeen: j.lastSeen }, newest)).map((j) => j.id));

      // Work already done, read from disk rather than from `status`. `autofill`
      // will not write APPLIED without an explicit human yes, so a job whose
      // form was filled days ago still reads APPLY here - and this listing kept
      // offering those back as fresh. Four of them went out on one list under a
      // heading claiming they were companies never applied to.
      const worked = new Map<string, string>();
      for (const j of jobs) {
        const line = describeHistory(readApplicationHistory(packDir(j)));
        if (line) worked.set(j.id, line);
      }

      console.log("");
      console.log(
        `${"ID".padEnd(13)} ${"ROI".padStart(3)} ${"FIT".padStart(3)} ${"P".padStart(1)} ${"AGE".padStart(4)} ${"COMP".padEnd(7)} ${"COMPANY".padEnd(20)} TITLE`,
      );
      console.log("-".repeat(120));
      for (const j of jobs) {
        const done = worked.get(j.id);
        const evergreen = isEvergreen(j.datePosted, profile.scoring.evergreen_days);
        // The pipeline's own verdict, not a re-derivation: these are the
        // postings whose location names an arrangement and no place, and which
        // used to be thrown away as "outside acceptable metros".
        const locUnknown = j.negativeSignals.some((n) => n.includes("Location unknown - review"));
        const mark =
          (stale.has(j.id) ? " [CLOSED?]" : "") +
          (evergreen ? " [EVERGREEN]" : "") +
          (locUnknown ? " [LOCATION?]" : "") +
          (done ? ` [${done}]` : "");
        console.log(
          `${j.id.padEnd(13)} ${String(j.applicationRoi ?? "-").padStart(3)} ${String(j.fitScore ?? "-").padStart(3)} ` +
            `${(j.priority ?? "-").padStart(1)} ${formatAge(postingAgeDays(j.datePosted)).padStart(4)} ` +
            `${(j.compensationBand ?? "-").padEnd(7)} ` +
            `${truncate(j.company, 20).padEnd(20)} ${truncate(j.title, 52 - mark.length)}${mark}`,
        );
      }
      console.log("");
      console.log(`${jobs.length} shown. \`job-radar show <id>\` for detail.`);
      if (stale.size) {
        console.log(
          `${stale.size} marked [CLOSED?]: the board was swept more recently than the posting was last seen on it. ` +
            `\`ingest\` to re-check.`,
        );
      }
      if (!opts.includeEvergreen) {
        // Never hide silently. A recommendation list that quietly drops rows
        // is indistinguishable from an empty index, which is the misreading
        // that cost an afternoon of adding job boards.
        const hidden = repo.top({ minFit, limit: 500, includeReviewed: opts.all, evergreenDays: null }).filter((j) =>
          isEvergreen(j.datePosted, profile.scoring.evergreen_days),
        ).length;
        if (hidden) {
          console.log(
            `${hidden} posting(s) older than ${profile.scoring.evergreen_days} days hidden. ` +
              `They are almost certainly always-on requisitions; \`--include-evergreen\` shows them.`,
          );
        }
      }
      const needLoc = jobs.filter((j) =>
        j.negativeSignals.some((n) => n.includes("Location unknown - review")),
      ).length;
      if (needLoc) {
        console.log(
          `${needLoc} marked [LOCATION?]: the posting names a work arrangement but no place. ` +
            `Unknown is not wrong - check where it actually is before applying.`,
        );
      }
      const filled = [...worked.values()].filter((v) => v.startsWith("FORM ALREADY")).length;
      if (filled) {
        console.log(
          `${filled} marked [FORM ALREADY FILLED]: a browser was driven at that employer's form on that date. ` +
            `That is not proof you submitted - \`status <id> APPLIED\` if you did.`,
        );
      }
      return { count: jobs.length };
    });
  });

// ---- show -----------------------------------------------------------------

program
  .command("show <job>")
  .description("Full detail for one job (id, unique id prefix, or unambiguous company name)")
  .action(async (jobId: string) => {
    await withRepo("show", (repo) => {
      const resolved = resolveJob(repo, jobId, { byCompany: true });
      if (!resolved.job) {
        console.error(resolved.message);
        process.exitCode = 1;
        return { found: false };
      }
      const job = resolved.job;

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
        console.log(
          a.interviewProbability === null || a.competitionEstimate === null
            ? `Interview probability not assessed (triage only)`
            : `Interview probability ${a.interviewProbability}% | competition ${a.competitionEstimate}`,
        );
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
  .command("status <job> <status>")
  .description(
    `Set a job's status by id, id prefix, or unambiguous company name. One of: ${STATUSES.join(", ")}`,
  )
  .option("-n, --note <text>", "attach a note")
  .action(async (jobId: string, status: string, opts: { note?: string }) => {
    const upper = status.toUpperCase();
    if (!isStatus(upper)) {
      console.error(`Invalid status "${status}". Valid: ${STATUSES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    await withRepo("status", (repo) => {
      // A company name is allowed here: this is the command a human runs the
      // moment they hear back, and copying an id from another window is the
      // friction that keeps outcomes out of the database. An ambiguous name is
      // refused with the candidates listed, never resolved by picking one.
      const resolved = resolveJob(repo, jobId, { byCompany: true });
      if (!resolved.job) {
        console.error(resolved.message);
        process.exitCode = 1;
        return { ok: false };
      }
      const job = resolved.job;
      repo.setStatus(job.id, upper, opts.note);
      console.log(`${job.company} - ${job.title}: ${job.status} -> ${upper}`);

      // Regenerate the briefing immediately. Without this the report on disk
      // still shows the job in the slate as if nothing happened, and there is
      // no way to tell a stale page from a live one by looking at it. This is
      // a pure database read, so it costs nothing and touches no network.
      try {
        const sourcesConfig = loadSources();
        const { markdown } = buildDailyReport({ repo, profile: loadProfile(), sources: sourcesConfig });
        writeReport(markdown);
        const html = writeHtmlReport(markdown);
        // The dashboard too. A status change is precisely the event the
        // cumulative view exists to show, so leaving the landing page on the
        // pre-change numbers would be the worst moment for it to be stale.
        const dash = writeDashboard(buildDashboard({ repo, sources: sourcesConfig }));
        console.log(`Briefing updated: ${html}`);
        console.log(`Dashboard updated: ${dash}`);
      } catch (err) {
        // A stale report is not worth failing a status change over.
        log.warn(`Status saved, but the briefing could not be regenerated: ${(err as Error).message}`);
      }
      return { ok: true };
    });
  });

// ---- dashboard ------------------------------------------------------------

program
  .command("dashboard")
  .description("Rebuild the cumulative dashboard from the database (no network, no cost)")
  .option("--open", "open it after writing", false)
  .action(async (opts: { open: boolean }) => {
    const sourcesConfig = loadSources();
    await withRepo("dashboard", (repo) => {
      const file = writeDashboard(buildDashboard({ repo, sources: sourcesConfig }));
      log.info(`Dashboard written: ${file}`);
      if (opts.open) {
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        const child = spawn(cmd, [file], { detached: true, stdio: "ignore" });
        child.on("error", () => console.log(`Open it yourself: file://${file}`));
        child.unref();
      }
      return { file };
    });
  });

// ---- inflight -------------------------------------------------------------

program
  .command("inflight")
  .description("Everything live and waiting, with the command to move each one along")
  .option("--stale", "only the ones that have gone quiet", false)
  .action(async (opts: { stale: boolean }) => {
    await withRepo("inflight", (repo) => {
      const now = Date.now();
      const days = (iso: string | null) =>
        iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86400000)) : 0;

      let jobs = repo.inFlight();
      if (opts.stale) jobs = jobs.filter((j) => days(j.statusChangedAt) >= (STALE_AFTER_DAYS[j.status] ?? 7));

      if (jobs.length === 0) {
        console.log(
          opts.stale
            ? "Nothing has gone quiet. Every live role is inside its normal response window."
            : "Nothing in flight. Prepare one with `job-radar apply <job-id>`.",
        );
        return { count: 0 };
      }

      console.log("");
      console.log(`${"ID".padEnd(13)} ${"STATUS".padEnd(10)} ${"AGE".padStart(4)}  ${"COMPANY".padEnd(20)} TITLE`);
      console.log("-".repeat(110));
      for (const j of jobs) {
        const age = days(j.statusChangedAt);
        const stale = age >= (STALE_AFTER_DAYS[j.status] ?? 7);
        console.log(
          `${j.id.padEnd(13)} ${j.status.padEnd(10)} ${`${age}d`.padStart(4)}${stale ? " !" : "  "} ` +
            `${truncate(j.company, 20).padEnd(20)} ${truncate(j.title, 46)}`,
        );
        console.log(`${" ".repeat(14)}${nextAction(j.status, age)}`);
      }

      console.log("");
      console.log("Move one along - the company name works in place of the id when it is unambiguous:");
      console.log("  npm run cli -- status <company-or-id> SCREEN     # they replied");
      console.log("  npm run cli -- status <company-or-id> REJECTED   # they passed");
      console.log("  npm run cli -- status <company-or-id> GHOSTED    # nothing, and it has been a while");
      console.log("");
      console.log(
        `A "no" is worth as much to the funnel as a win. ` +
          `Anything quiet for ${GHOSTED_AFTER_DAYS}+ days is worth closing out.`,
      );
      return { count: jobs.length };
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
  .description("Open the dashboard in your browser")
  .option("--briefing", "open today's slate instead of the dashboard", false)
  .option("--md", "print the path to the briefing Markdown instead of opening anything", false)
  .action((opts: { briefing: boolean; md: boolean }) => {
    const dir = paths.reports();
    const dashboard = resolve(dir, "latest.html");
    const briefing = resolve(dir, "latest-briefing.html");
    const md = resolve(dir, "latest.md");

    // --md means the briefing Markdown, because there is no dashboard
    // Markdown - the dashboard is a rendered view, not a document. Saying so
    // beats letting the two flags look interchangeable.
    if (opts.md) {
      if (!existsSync(md)) {
        console.error(`No briefing Markdown in ${dir}. Run \`npm run radar\` first.`);
        process.exitCode = 1;
        return;
      }
      console.log(md);
      return;
    }

    const wanted = opts.briefing ? briefing : dashboard;
    const label = opts.briefing ? "briefing" : "dashboard";
    if (!existsSync(wanted)) {
      // Deliberately not falling back to the other file. They answer different
      // questions, and silently opening the one that exists would answer a
      // question that was not asked.
      console.error(`No ${label} in ${dir}. Run \`npm run radar\` first.`);
      process.exitCode = 1;
      return;
    }
    const html = wanted;

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
  .option("--watch", "rebuild the dashboard when the report sources change", false)
  .option(
    "--reload-seconds <n>",
    "with --watch, how often the browser re-requests the page (0 to disable)",
    "2",
  )
  .action(async (opts: { port: string; open: boolean; watch: boolean; reloadSeconds: string }) => {
    const dir = paths.reports();
    if (!existsSync(resolve(dir, "latest.html"))) {
      console.log(`No dashboard in ${dir} yet - the root will show the archive instead. Run \`npm run radar\`.`);
    }

    const reloadSeconds = opts.watch ? Math.max(0, Number(opts.reloadSeconds) || 0) : 0;
    const { port } = await startReportServer({
      dir,
      port: Number(opts.port) || 4321,
      refreshSeconds: reloadSeconds,
    });
    const url = `http://127.0.0.1:${port}/`;

    const watcher = opts.watch ? startDashboardWatcher() : null;

    console.log("");
    console.log(`  Job Radar dashboard  ${url}`);
    console.log(`  today's briefing     ${url}latest-briefing.html`);
    console.log(`  past briefings       ${url}archive`);
    console.log(`  serving              ${dir}`);
    console.log(`  bound to             127.0.0.1 only (not reachable from your network)`);
    if (watcher) {
      console.log(`  watching             ${WATCHED_DIRS.join(", ")}`);
      console.log(`  plus the database    ${paths.db()}`);
      console.log(
        `  auto-refresh         ${reloadSeconds ? `every ${reloadSeconds}s` : "off (--reload-seconds 0)"}`,
      );
      // Said out loud because it is the one thing about this mode that will
      // otherwise look broken: edit daily.ts, save, and the briefing does not
      // change. `daily` re-scores the whole index, which is far too slow to run
      // on every save.
      console.log(`  note                 rebuilds the dashboard only; the briefing needs \`daily\``);
    }
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
        watcher?.close();
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
  .description("Per-source scorecard, then a health check of every configured endpoint")
  .option("--no-check", "skip the live endpoint check and print only the scorecard")
  .action(async (opts: { check: boolean }) => {
    const profile = loadProfile();
    // Scorecard first: it comes from the database, costs nothing, and answers
    // the question people actually open this command for. The live check that
    // follows walks a hundred boards and takes a while.
    await withRepo("sources", (repo) => {
      const scored = scoreSources(repo.sourceScorecard(), {
        minAnalyzedForVerdict: profile.source_policy.min_analyzed_for_verdict,
        retireBelowApplyRate: profile.source_policy.retire_below_apply_rate,
        watchBelowSelectionRate: profile.source_policy.watch_below_selection_rate,
        minPassedForSelectionVerdict: profile.source_policy.min_passed_for_selection_verdict,
      });
      console.log("");
      console.log("SOURCE SCORECARD");
      console.log("-".repeat(104));
      console.log(
        `${"source".padEnd(11)} ${"in".padStart(6)} ${"passed".padStart(7)} ${"pass%".padStart(6)} ` +
          `${"analyzed".padStart(8)} ${"sel%".padStart(6)} ${"applies".padStart(7)} ${"apply%".padStart(7)}  VERDICT`,
      );
      for (const r of scored) {
        console.log(
          `${r.source.padEnd(11)} ${String(r.ingested).padStart(6)} ${String(r.passed).padStart(7)} ` +
            `${(r.passRate * 100).toFixed(0).padStart(5)}% ${String(r.analyzed).padStart(8)} ` +
            `${(r.selectionRate * 100).toFixed(1).padStart(5)}% ${String(r.applies).padStart(7)} ` +
            `${(r.applyRate * 100).toFixed(1).padStart(6)}%  ${r.verdict.toUpperCase()}`,
        );
        console.log(`${" ".repeat(12)}${r.why}`);
      }
      console.log("");
      console.log(
        `sel% is the share of a source's FILTER-PASSING jobs that ever ranked high enough to`,
      );
      console.log(
        `analyse. A source that passes everything and is never selected inflates the pool.`,
      );
      const retire = scored.filter((r) => r.verdict === "retire");
      if (retire.length) {
        console.log("");
        console.log(
          `Retire ${retire.map((r) => r.source).join(", ")}: set enabled: false in config/sources.yaml.`,
        );
      }
      return { sources: scored.length };
    });

    if (!opts.check) return;
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

// ---- migrate ----------------------------------------------------------------

program
  .command("migrate")
  .description("Back up, then physically drop dead columns and reclaim the space (DESTRUCTIVE)")
  .option("-o, --out <dir>", "backup directory", resolve(PROJECT_ROOT, "data", "backups"))
  .option("--skip-backup", "do not back up first - only if you have one already", false)
  .action((opts: { out: string; skipBackup: boolean }) => {
    const src = paths.db();
    const before = statSync(src).size;

    // BACK UP FIRST, AND PROVE IT. A truncated backup - a full disk during the
    // copy, most likely - is worse than no backup, because it looks like one.
    // So the size is compared before anything destructive runs.
    if (!opts.skipBackup) {
      mkdirSync(opts.out, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = resolve(opts.out, `job-radar-${stamp}.sqlite`);
      const pre = openDb();
      pre.pragma("wal_checkpoint(TRUNCATE)");
      closeDb();
      copyFileSync(src, dest);
      const copied = statSync(dest).size;
      if (copied !== statSync(src).size) {
        console.error(`Backup is ${copied} bytes but the database is ${statSync(src).size}. Refusing to migrate.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Backed up to ${dest} (${(copied / 1_048_576).toFixed(0)} MB)`);
    } else {
      console.log("Skipping backup, as asked.");
    }

    const db = openDb();
    const dropped = applyDestructiveMigrations(db);
    if (dropped.length === 0) {
      console.log("Nothing to drop - already migrated.");
    } else {
      for (const d of dropped) console.log(`Dropped ${d}`);
    }

    // VACUUM rewrites the file to reclaim the freed pages. Dropping a column
    // alone frees nothing on disk. It cannot run inside a transaction, which
    // is one of the reasons this is a command and not part of `openDb()`.
    console.log("Vacuuming...");
    db.exec("VACUUM");
    closeDb();

    const after = statSync(src).size;
    console.log(
      `${(before / 1_048_576).toFixed(0)} MB -> ${(after / 1_048_576).toFixed(0)} MB ` +
        `(reclaimed ${((before - after) / 1_048_576).toFixed(0)} MB)`,
    );
  });

// ---- backup ---------------------------------------------------------------

program
  .command("backup")
  .description("Copy the SQLite database to a timestamped file, pruning old ones")
  .option("-o, --out <dir>", "output directory", resolve(PROJECT_ROOT, "data", "backups"))
  .option("-k, --keep <n>", "how many backups to retain", "14")
  .action((opts: { out: string; keep: string }) => {
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

    // Prune, and this is not housekeeping - it is the difference between a
    // backup schedule and a disk-filling bug. The database is 238MB, so a
    // daily copy with no retention is 7GB a month, on the same disk as the
    // thing being protected.
    const keep = Math.max(1, Number(opts.keep) || 14);
    const pruned = pruneBackups(opts.out, keep);
    if (pruned.length) {
      console.log(`Pruned ${pruned.length} old backup(s), keeping the newest ${keep}.`);
    }
    const remaining = listBackups(opts.out);
    const bytes = remaining.reduce((a, f) => a + statSync(resolve(opts.out, f)).size, 0);
    console.log(`${remaining.length} backup(s), ${(bytes / 1_073_741_824).toFixed(2)} GB total.`);
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
