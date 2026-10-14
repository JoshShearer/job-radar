#!/usr/bin/env node
import { Command } from "commander";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { stringify } from "yaml";
import { compose, type Runtime } from "./compose.js";
import { withRun } from "../app/run.js";
import { sweep } from "../app/sweep.js";
import { evaluate } from "../app/evaluate.js";
import { assess } from "../app/assess.js";
import { benchmarkTriage } from "../app/benchmark.js";
import type { BenchmarkMode } from "../domain/evaluation/benchmark.js";
import { applicationFold, applicationViews, isApplicationState, isPursuitState, pursuitOf, recordOutcome, recordSubmission, resolveApplication, resolveOpportunity, transitionPursuit, voidEvent } from "../app/pursuit.js";
import { approve, preparePack, tailor } from "../app/materials.js";
import { fill } from "../app/fill.js";
import { scanMail } from "../app/mail.js";
import { buildBriefing } from "../app/briefing.js";
import { spendFor, spendSummary } from "../app/spend.js";
import { importEvidence, lint, matchPosting } from "../app/evidence.js";
import { importLegacy } from "../app/legacy-import.js";
import { candidateBrief } from "../app/assessment-requests.js";
import { briefingHtml, briefingMarkdown } from "./reports/render.js";
import { matchReportMarkdown } from "../domain/materials/render.js";
import { PRIORITY_LABELS } from "../domain/evaluation/priority.js";
import { formatRate } from "../domain/pursuit/funnel.js";
import { backupDatabase } from "../adapters/sqlite/db.js";
import { discoverCompany } from "../adapters/ats/discover.js";
import { FsSourcesWriter } from "../adapters/fs/sources-writer.js";
import { discover } from "../app/discover.js";
import { readLegacy } from "../adapters/legacy/reader.js";
import { convertLegacyConfig } from "../adapters/legacy/config.js";
import { CONFIG_FILES, ConfigError } from "../adapters/fs/config-loader.js";
import { writeFileAtomic } from "../adapters/fs/yaml-writers.js";
import { PACKAGE_ROOT } from "../adapters/fs/paths.js";
import { startServer } from "./web/server.js";
import { UserError, type UseCaseResult } from "../kernel/result.js";
import type { AppContext } from "../app/context.js";

// `jr top | head` closes the pipe early; that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const program = new Command();
program.name("jr").description("Job Radar: find the right roles, prepare honest material, never send anything.").version("1.0.0");

let runtime: Runtime | null = null;
function rt(): Runtime {
  return (runtime ??= compose());
}
function ctx(): AppContext {
  return rt().ctx;
}
const out = (s = "") => process.stdout.write(`${s}\n`);

/** Print a use case's notes and set the exit code from its outcome. */
function report<T>(r: UseCaseResult<T>): UseCaseResult<T> {
  for (const n of r.notes) out(n);
  if (r.outcome === "refused" || r.outcome === "failed") process.exitCode = 1;
  return r;
}

function num(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`${flag} expects a non-negative number, got "${v}"`);
  return n;
}

/* ------------------------------------------------------------------ setup */

program
  .command("init")
  .description("Create config/ from config.example/ (never overwrites) and check it")
  .action(() => {
    const paths = rt().paths;
    const example = resolve(PACKAGE_ROOT, "config.example");
    let created = 0;
    for (const rel of [...Object.values(CONFIG_FILES), "candidate/personal.yaml", "candidate/evidence.yaml"]) {
      const dest = resolve(paths.config, rel);
      const src = resolve(example, rel);
      if (existsSync(dest) || !existsSync(src)) continue;
      mkdirSync(resolve(dest, ".."), { recursive: true });
      cpSync(src, dest);
      out(`created ${dest}`);
      created++;
    }
    out(created ? "Edit config/candidate/*.yaml with your own facts before running anything that spends." : "Config already present.");
  });

program
  .command("check")
  .description("Validate every config file and the evidence ledger")
  .action(() => {
    const c = ctx().config();
    out(`config ok: ${Object.keys(c.strategy.lanes).length} lanes, ${c.strategy.signals.length} signals, ${countBoards(c)} boards`);
    if (ctx().hasEvidence()) {
      const l = lint(ctx());
      out(`evidence: ${l.claims} claims, ${l.usable} usable; ${l.issues.filter((i) => i.level === "error").length} error(s)`);
    } else out("evidence: none yet (`jr evidence import <file>`)");
    out(`personal: ${ctx().personal() ? "ok" : "missing (needed only for `fill`)"}`);
    out(`model: ${ctx().modelClient() ? "configured" : "no ANTHROPIC_API_KEY (assess/tailor/prepare unavailable)"}`);
    out(`mail: ${ctx().mailbox()?.name ?? "not configured"}`);
  });

function countBoards(c: ReturnType<AppContext["config"]>): number {
  const s = c.sources.sources;
  return s.greenhouse.boards.length + s.lever.boards.length + s.ashby.boards.length + s.workable.boards.length + s.smartrecruiters.boards.length + (s.remoteok.enabled ? 1 : 0);
}

/* --------------------------------------------------------------- pipeline */

program
  .command("sweep")
  .description("Fetch every configured board (public endpoints only, rate-limited)")
  .option("-s, --source <providers...>", "only these providers")
  .action(async (o: { source?: string[] }) => {
    const r = report(await withRun(ctx(), "sweep", (runId) => sweep(ctx(), runId, o.source ? { providers: o.source } : {})));
    const v = r.value;
    out(`boards ${v.boardsComplete}/${v.boardsAttempted} complete, ${v.postingsSeen} postings, ${v.newOpportunities} new, ${v.changedPayloads} changed`);
  });

program
  .command("evaluate")
  .description("Re-score everything and rebuild the ranking (free, deterministic)")
  .action(async () => {
    const r = report(await withRun(ctx(), "evaluate", (runId) => evaluate(ctx(), runId)));
    printEvaluation(r.value);
  });

function printEvaluation(v: ReturnType<typeof evaluate>["value"]): void {
  out(`${v.opportunities} postings, ${v.eligible} eligible, ${v.assessed} assessed, ${v.projected} projected, ${v.staleAssessments} stale`);
  out(`priority: ${["A", "B", "C", "D"].map((p) => `${p}=${v.byPriority[p] ?? 0}`).join(" ")}  postings: ${Object.entries(v.byPostingState).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  out(v.calibration);
}

program
  .command("assess")
  .description("Buy model assessments for the best-ranked postings (costs money; budgets enforced per call)")
  .option("-l, --limit <n>", "postings this pass", "10")
  .option("--slate", "cover the whole eligible slate (implies two-stage)", false)
  .option("--two-stage", "triage first, dossier only when earned")
  .option("--single-stage", "dossier for every posting")
  .option("--include-evergreen", "also very old postings", false)
  .option("--min-fit <n>", "one-off floor on the raw keyword fit")
  .option("--max-spend <usd>", "per-run ceiling for this pass")
  .option("--dry-run", "show what would be bought", false)
  .action(async (o: { limit: string; slate: boolean; twoStage?: boolean; singleStage?: boolean; includeEvergreen: boolean; minFit?: string; maxSpend?: string; dryRun: boolean }) => {
    const minFit = num(o.minFit, "--min-fit");
    const maxSpend = num(o.maxSpend, "--max-spend");
    const r = report(
      await withRun(ctx(), "assess", (runId) =>
        assess(ctx(), runId, {
          limit: num(o.limit, "--limit") ?? 10,
          slate: o.slate,
          ...(o.twoStage ? { twoStage: true } : o.singleStage ? { twoStage: false } : {}),
          includeEvergreen: o.includeEvergreen,
          ...(minFit !== undefined ? { minFit } : {}),
          ...(maxSpend !== undefined ? { maxSpendUsd: maxSpend } : {}),
          dryRun: o.dryRun,
        }),
      ),
    );
    const v = r.value;
    for (const w of v.wouldBuy) out(`  would assess: ${w}`);
    out(`selected ${v.selected} of ${v.eligible}; bought ${v.bought}, from cache ${v.fromCache}, dossiers ${v.dossiers}, triage-only ${v.triageOnly}, failed ${v.failed}; spent ~$${v.spentUsd.toFixed(4)}`);
  });

program
  .command("benchmark-triage")
  .description("Compare the cheap triage verdict with current dossiers (costs money only with --yes)")
  .option("-l, --limit <n>", "baselines to compare", "25")
  .option("--mode <mode>", "verdict (can triage REPLACE the dossier?) or routing (can it decide WHO GETS one?)", "routing")
  .option("--yes", "make the calls; without it, only report the sample", false)
  .option("--max-spend <usd>", "per-run ceiling for this pass")
  .action(async (o: { limit: string; mode: string; yes: boolean; maxSpend?: string }) => {
    if (o.mode !== "verdict" && o.mode !== "routing") throw new UserError(`--mode must be "verdict" or "routing", not "${o.mode}".`);
    const maxSpend = num(o.maxSpend, "--max-spend");
    const r = report(
      await withRun(ctx(), "benchmark-triage", (runId) =>
        benchmarkTriage(ctx(), runId, {
          limit: num(o.limit, "--limit") ?? 25,
          mode: o.mode as BenchmarkMode,
          yes: o.yes,
          ...(maxSpend !== undefined ? { maxSpendUsd: maxSpend } : {}),
        }),
      ),
    );
    const v = r.value;
    if (!v.summary) return;
    const s = v.summary;
    out(`Compared ${s.compared} (${v.fromCache} free from cache), ${v.failed} failed; spent ~$${v.spentUsd.toFixed(4)}.`);
    out(`Apply-vs-not agreement: ${s.agreeOnApply}/${s.compared} = ${(s.agreementRate * 100).toFixed(1)}%; mean |fit delta| ${s.meanAbsFitDelta.toFixed(1)}`);
    for (const x of s.missedApplies) out(`  missed apply: ${x.company} - ${x.title}: ${x.baselineRecommendation} -> ${x.triageRecommendation}`);
    for (const x of s.spuriousApplies) out(`  invented apply: ${x.company} - ${x.title}: ${x.baselineRecommendation} -> ${x.triageRecommendation}`);
    out(`Routing (${s.routingCompared} independent baselines): ${s.missedDossiers.length} missed dossier(s), ${s.extraDossiers.length} extra.`);
    for (const x of s.missedDossiers) out(`  MISSED: ${x.company} - ${x.title}: ${x.baselineRecommendation} -> ${x.triageRecommendation} (fit ${x.triageFit})`);
    out(`${v.gate!.verdict} (${v.mode}): ${v.gate!.reason}`);
  });

program
  .command("daily")
  .description("The scheduled pass: sweep, evaluate, optional mail and assessment, briefing")
  .option("--no-sweep", "use stored postings")
  .option("--mail", "scan application mail too", false)
  .option("--assess", "also buy assessments (costs money)", false)
  .option("--assess-limit <n>", "postings to assess", "8")
  .action(async (o: { sweep: boolean; mail: boolean; assess: boolean; assessLimit: string }) => {
    const c = ctx();
    const result = await withRun(c, "daily", async (runId) => {
      const notes: string[] = [];
      let worst: "ok" | "degraded" | "failed" = "ok";
      const note = (label: string, r: UseCaseResult<unknown>) => {
        if (r.outcome === "failed") worst = "failed";
        else if (r.outcome !== "ok" && worst === "ok") worst = "degraded";
        for (const n of r.notes) notes.push(`${label}: ${n}`);
      };
      if (o.sweep) note("sweep", await sweep(c, runId));
      if (o.mail) note("mail", await scanMail(c, runId));
      note("evaluate", evaluate(c, runId));
      if (o.assess) note("assess", await assess(c, runId, { limit: num(o.assessLimit, "--assess-limit") ?? 8 }));
      const b = buildBriefing(c);
      const day = b.generatedAt.slice(0, 10);
      const md = briefingMarkdown(b);
      c.writeReport(`${day}.md`, md);
      c.writeReport("latest.md", md);
      const html = briefingHtml(b);
      c.writeReport(`${day}.html`, html);
      const file = c.writeReport("latest.html", html);
      out(md);
      notes.push(`Briefing: ${file}`);
      return { outcome: worst, value: { slate: b.slate.length }, notes };
    });
    report(result);
  });

program
  .command("report")
  .description("Write the briefing from stored data (no network, no cost)")
  .action(() => {
    const b = buildBriefing(ctx());
    const md = briefingMarkdown(b);
    ctx().writeReport("latest.md", md);
    out(md);
    out(`\n${ctx().writeReport("latest.html", briefingHtml(b))}`);
  });

/* ------------------------------------------------------------------ views */

program
  .command("top")
  .description("The ranked list")
  .option("-l, --limit <n>", "rows", "25")
  .option("--all", "include postings you have already acted on", false)
  .option("--lane <lane>", "one lane only")
  .option("--include-evergreen", "include very old postings", false)
  .option("--closed", "include postings no longer listed (missing or closed)", false)
  .action((o: { limit: string; all: boolean; lane?: string; includeEvergreen: boolean; closed: boolean }) => {
    const rows = ctx().store.ranking({
      eligible: true,
      ...(o.all ? {} : { pursuitStates: ["new", "reviewed"] }),
      ...(o.closed ? {} : { postingStates: ["open", "unknown"] }),
      ...(o.includeEvergreen ? {} : { includeEvergreen: false }),
      ...(o.lane ? { lane: o.lane } : {}),
      limit: num(o.limit, "--limit") ?? 25,
    });
    const now = ctx().clock.now();
    for (const r of rows) {
      const age = r.datePosted ? `${Math.round((now.getTime() - Date.parse(r.datePosted)) / 86_400_000)}d` : "?";
      out(
        `${r.opportunityId}  ${r.priority}  fit ${String(Math.round(r.fit)).padStart(3)} roi ${String(Math.round(r.roi)).padStart(3)}  ${r.confidence.padEnd(9)} ${r.postingState.padEnd(7)} ${age.padStart(5)}  ${r.company} - ${r.title}`,
      );
    }
    if (!rows.length) out("Nothing ranked yet. Run `jr sweep` then `jr evaluate`.");
  });

program
  .command("show <id>")
  .description("Everything known about one posting (id, unique prefix, or company)")
  .action((q: string) => {
    const c = ctx();
    const id = resolveOpportunity(c, q);
    const r = c.store.rankingFor(id);
    if (!r) throw new UserError(`${id} has not been evaluated yet. Run \`jr evaluate\`.`);
    out(`${r.company} - ${r.title}  [${id}]`);
    out(`${r.location} (${r.remoteStatus}) | posting ${r.postingState} | pursuit ${pursuitOf(c, id).state}`);
    out(`Priority ${r.priority} (${PRIORITY_LABELS[r.priority]}): fit ${Math.round(r.fit)} roi ${Math.round(r.roi)} [${r.confidence}]`);
    out(`  keyword fit ${Math.round(r.rawFit)} / roi ${Math.round(r.rawRoi)}${r.projFit !== null ? `; projected ${r.projFit} / ${r.projRoi}` : ""}${r.analystFit !== null ? `; analyst ${r.analystFit} / ${r.analystRoi} -> ${r.analystRec} (${r.analystTier})` : ""}`);
    if (r.staleAssessment) out("  An earlier assessment exists but its inputs changed; it does not count.");
    if (r.detail.analystSummary) out(`\nAnalyst: ${r.detail.analystSummary}`);
    if (r.detail.reasons.length) out(`\nRejected:\n${r.detail.reasons.map((x) => `  - ${x}`).join("\n")}`);
    if (r.detail.warnings.length) out(`\nWarnings:\n${r.detail.warnings.map((x) => `  - ${x}`).join("\n")}`);
    out(`\n${r.detail.explanation}`);
    out(`\n${r.detail.applicationUrl ?? r.detail.url}  (${r.detail.aliases} source${r.detail.aliases === 1 ? "" : "s"})`);
    const apps = c.store.applications(id);
    for (const a of apps) out(`Application ${a.id}: ${applicationFold(c, a.id).state} (submitted ${a.submittedAt.slice(0, 10)})`);
    for (const g of c.store.artifacts(id)) out(`Generation ${g.kind} ${g.id}${g.approvedAt ? " (approved)" : ""}: ${g.dir}`);
    for (const ov of c.store.overrides(id)) out(`Override ${ov.gate} (${ov.detail}) at ${ov.recordedAt.slice(0, 16)}`);
    const s = spendFor(c, id);
    if (s.calls) out(`Spent on this posting: $${s.usd.toFixed(4)} over ${s.calls} call(s)`);
  });

/* --------------------------------------------------------------- decisions */

program
  .command("pursue <id> <state>")
  .description("Move a posting along: reviewed | shortlisted | preparing | skipped")
  .option("--note <text>")
  .action(async (q: string, state: string, o: { note?: string }) => {
    if (!isPursuitState(state)) throw new UserError(`Unknown pursuit state "${state}".`);
    const c = ctx();
    const id = resolveOpportunity(c, q);
    const r = report(await withRun(c, "pursue", (runId) => transitionPursuit(c, runId, id, state, o.note ? { note: o.note } : {})));
    if (r.outcome === "ok") out(`${id}: ${r.value.from} -> ${r.value.to}`);
  });

program
  .command("submitted <id>")
  .description("Record that YOU submitted an application (the system never submits)")
  .option("--at <iso>", "when it was submitted (default now)")
  .option("--note <text>")
  .action(async (q: string, o: { at?: string; note?: string }) => {
    const c = ctx();
    const id = resolveOpportunity(c, q);
    const r = report(await withRun(c, "submitted", (runId) => recordSubmission(c, runId, id, { ...(o.at ? { submittedAt: iso(o.at) } : {}), ...(o.note ? { note: o.note } : {}) })));
    if (r.outcome === "ok") out(`Recorded application ${r.value.applicationId}.`);
  });

program
  .command("outcome <application> <state>")
  .description("Record what an employer did: contacted | screen | interview | final | offer | rejected | withdrawn | ghosted")
  .option("--at <iso>", "when it happened (default now)")
  .option("--note <text>")
  .action(async (q: string, state: string, o: { at?: string; note?: string }) => {
    if (!isApplicationState(state)) throw new UserError(`Unknown application state "${state}".`);
    const c = ctx();
    const app = resolveApplication(c, q);
    const r = report(await withRun(c, "outcome", (runId) => recordOutcome(c, runId, app.id, state, { ...(o.at ? { occurredAt: iso(o.at) } : {}), ...(o.note ? { note: o.note } : {}) })));
    if (r.outcome === "ok") out(`${app.id}: ${r.value.from} -> ${r.value.to}`);
  });

program
  .command("void <kind> <eventId>")
  .description("Exclude a mistaken event (kind: pursuit | application). The event is kept, just not counted.")
  .requiredOption("--reason <text>")
  .action(async (kind: string, eventId: string, o: { reason: string }) => {
    const table = kind === "pursuit" ? "pursuit_event" : kind === "application" ? "application_event" : null;
    if (!table) throw new UserError('kind must be "pursuit" or "application"');
    report(await withRun(ctx(), "void", () => voidEvent(ctx(), table, Number(eventId), o.reason)));
    out(`Voided ${kind} event ${eventId}.`);
  });

program
  .command("apps")
  .description("Every application with its current state and event history")
  .option("--events", "show each application's events", false)
  .action((o: { events: boolean }) => {
    const c = ctx();
    for (const a of applicationViews(c)) {
      out(`${a.id}  ${a.state.padEnd(10)} since ${a.since.slice(0, 10)}  ${a.company} - ${a.title}`);
      if (o.events) {
        for (const s of applicationFold(c, a.id).steps) {
          out(`    #${s.event.id} ${s.event.occurredAt.slice(0, 16)} -> ${s.event.to} [${s.event.actor}]${s.applied ? "" : ` (not applied: ${s.reason})`}${s.event.note ? ` ${s.event.note}` : ""}`);
        }
      }
    }
  });

function iso(v: string): string {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UserError(`Not a date: "${v}"`);
  return new Date(t).toISOString();
}

/* ----------------------------------------------------------------- evidence */

const ev = program.command("evidence").description("The evidence ledger: the only source of claims about you");

ev.command("import <file>")
  .description("Structure an existing resume (txt/md) into the ledger; anything not in the source is marked unverified")
  .option("--force", "replace an existing ledger (a backup is kept)", false)
  .action(async (file: string, o: { force: boolean }) => {
    if (!existsSync(file)) throw new UserError(`No such file: ${file}`);
    const source = readFileSync(file, "utf8");
    const r = report(await withRun(ctx(), "evidence-import", (runId) => importEvidence(ctx(), runId, source, { force: o.force })));
    if (r.outcome === "ok") out(`Wrote ${r.value.claims} claims to ${ctx().paths.evidence}`);
    for (const u of r.value.uncertain) out(`  check: ${u}`);
  });

ev.command("lint")
  .description("Check the ledger for problems that would corrupt generated material")
  .action(() => {
    const l = lint(ctx());
    for (const i of l.issues) out(`${i.level === "error" ? "ERROR  " : "warning"} ${i.where}: ${i.message}`);
    out(`${l.claims} claims, ${l.usable} usable (verified and skill-tagged).`);
    if (l.issues.some((i) => i.level === "error")) process.exitCode = 1;
  });

ev.command("match <id>")
  .description("Deterministic requirement coverage for one posting (free)")
  .action((q: string) => {
    const m = matchPosting(ctx(), resolveOpportunity(ctx(), q));
    out(matchReportMarkdown(m.title, m.company, m.report));
  });

ev.command("brief")
  .description("Print the candidate brief every prompt is built from")
  .action(() => {
    out(candidateBrief(ctx()) ?? "No evidence ledger yet.");
  });

/* ---------------------------------------------------------------- materials */

program
  .command("tailor <id>")
  .description("Select a resume from the ledger for one posting (verified; never authored)")
  .option("--override", "proceed past a closed-posting or unendorsed gate (recorded)", false)
  .option("--force", "re-plan even if a plan exists for this posting", false)
  .action(async (q: string, o: { override: boolean; force: boolean }) => {
    const id = resolveOpportunity(ctx(), q);
    const r = report(await withRun(ctx(), "tailor", (runId) => tailor(ctx(), runId, id, o)));
    if (r.value.dir) out(`Generation ${r.value.generationId}: ${r.value.dir}${r.value.spentUsd ? ` ($${r.value.spentUsd.toFixed(4)})` : " ($0)"}`);
    else if (r.value.spentUsd) out(`No generation written; the failed attempt still cost $${r.value.spentUsd.toFixed(4)}.`);
  });

program
  .command("render <id>")
  .description("Re-compose the latest resume against the current ledger (free)")
  .action(async (q: string) => {
    const id = resolveOpportunity(ctx(), q);
    const r = report(await withRun(ctx(), "render", (runId) => tailor(ctx(), runId, id, { noCall: true })));
    if (r.value.dir) out(`Generation ${r.value.generationId}: ${r.value.dir}`);
    else if (r.value.spentUsd) out(`No generation written; the failed attempt still cost $${r.value.spentUsd.toFixed(4)}.`);
  });

program
  .command("prepare <id>")
  .description("Draft cover letter and form answers (every sentence verified; needs approval before use)")
  .option("--full", "also outreach drafts, negotiation and interview prep", false)
  .option("--override", "proceed past a closed-posting or unendorsed gate (recorded)", false)
  .option("--force", "regenerate even if a pack exists for this posting", false)
  .action(async (q: string, o: { full: boolean; override: boolean; force: boolean }) => {
    const id = resolveOpportunity(ctx(), q);
    const r = report(await withRun(ctx(), "prepare", (runId) => preparePack(ctx(), runId, id, o)));
    if (r.value.dir) out(`Generation ${r.value.generationId}: ${r.value.dir}/pack-review.md`);
    else if (r.value.spentUsd) out(`No generation written; the failed attempt still cost $${r.value.spentUsd.toFixed(4)}.`);
  });

program
  .command("approve <id>")
  .description("Approve the latest pack generation after reading it")
  .option("--generation <gid>")
  .option("--note <text>")
  .action(async (q: string, o: { generation?: string; note?: string }) => {
    const id = resolveOpportunity(ctx(), q);
    report(await withRun(ctx(), "approve", () => approve(ctx(), id, o.generation, o.note)));
  });

program
  .command("fill <id>")
  .description("Open the employer's form and fill it. NEVER submits.")
  .option("--headless", "dry run: report what would be filled, no window", false)
  .option("--override", "fill even though the posting looks closed", false)
  .action(async (q: string, o: { headless: boolean; override: boolean }) => {
    const id = resolveOpportunity(ctx(), q);
    const r = report(await withRun(ctx(), "fill", (runId) => fill(ctx(), runId, id, o)));
    out(`filled ${r.value.filled}, for you ${r.value.needsYou}. Report: ${r.value.report}`);
  });

/* --------------------------------------------------------------------- mail */

const mail = program.command("mail").description("Read application mail (read-only)");

mail
  .command("scan")
  .description("Record outcomes employers sent in writing")
  .option("--dry-run", "show what would change; write nothing", false)
  .action(async (o: { dryRun: boolean }) => {
    const r = report(await withRun(ctx(), "mail-scan", (runId) => scanMail(ctx(), runId, { dryRun: o.dryRun })));
    const v = r.value;
    out(`window ${v.window?.from.slice(0, 10)}..${v.window?.to.slice(0, 10)}: ${v.fetched} fetched over ${v.pages} page(s), ${v.applied} recorded, ${v.refused} refused, ${v.ambiguous} ambiguous, ${v.unmatched} unmatched, coverage ${v.coverage}`);
    for (const ch of v.changes) out(`  ${ch.company}: -> ${ch.to}`);
  });

mail
  .command("review")
  .description("Mail that was not acted on: ambiguous, unmatched, refused")
  .action(() => {
    for (const m of ctx().store.mailMessages({ resolutions: ["ambiguous", "unmatched", "refused"], limit: 50 })) {
      out(`${m.receivedAt.slice(0, 10)} [${m.resolution}] ${m.from}: ${m.subject}\n    ${m.note ?? ""}`);
    }
  });

/* ------------------------------------------------------------------- ledger */

program
  .command("stats")
  .description("Funnel conversion with sample sizes; no diagnosis on noise")
  .action(() => {
    const b = buildBriefing(ctx());
    for (const [k, n] of Object.entries(b.funnel.counts)) out(`${k.padEnd(11)} ${n}`);
    for (const c of b.funnel.conversions) out(`${c.from} -> ${c.to}: ${formatRate(c.rate, c.n)}`);
    if (b.funnel.sampleWarning) out(b.funnel.sampleWarning);
    for (const h of b.funnel.hypotheses) out(`- ${h}`);
  });

program
  .command("spend")
  .description("What the tool has cost, from the one ledger of paid calls")
  .option("-d, --days <n>", "window", "30")
  .action((o: { days: string }) => {
    const s = spendSummary(ctx(), num(o.days, "--days") ?? 30);
    out(`today  $${s.day.committed.toFixed(4)} of $${s.budgets.perDay.toFixed(2)} (${s.day.calls} calls, ${s.day.failed} failed, ${s.day.unknownUsage} without receipt)`);
    out(`month  $${s.month.committed.toFixed(4)} of $${s.budgets.perMonth.toFixed(2)} (${s.month.calls} calls)`);
    for (const p of s.byPurpose) out(`  ${p.purpose.padEnd(16)} ${String(p.calls).padStart(5)} calls  $${p.usd.toFixed(4)}`);
  });

program
  .command("failures")
  .description("Recent assessment failures and why")
  .action(() => {
    for (const f of ctx().store.recentFailures(30)) out(`${f.at.slice(0, 16)} ${f.opportunityId} [${f.kind}${f.counts ? "" : ", not counted"}] ${f.reason}`);
  });

/* ------------------------------------------------------------------ sources */

program
  .command("sources")
  .description("Health-check every configured board (one request each)")
  .action(async () => {
    const c = ctx();
    const t = c.transport();
    let dead = 0;
    for (const a of c.adapters()) {
      for (const b of a.boards()) {
        const status = await t.status(a.endpoint(b));
        if (status !== 200) dead++;
        out(`${status === 200 ? "ok  " : "DEAD"} ${String(status).padStart(3)} ${b.boardId}`);
      }
    }
    if (dead) process.exitCode = 1;
  });

program
  .command("discover <companies...>")
  .description("Find a company's public ATS board and print the sources.yaml line (--add writes it in)")
  .option("--add", "add each new board to config/sources.yaml under its ATS, keeping the file's comments and layout", false)
  .action(async (companies: string[], o: { add: boolean }) => {
    const c = ctx();
    const t = c.transport();
    report(
      await withRun(c, "discover", () =>
        discover(c, companies, { probe: (name) => discoverCompany(name, t), writer: o.add ? new FsSourcesWriter(c.paths.config) : null }),
      ),
    );
  });

/* --------------------------------------------------------------- operations */

program
  .command("serve")
  .description("Local web UI on 127.0.0.1 only")
  .option("-p, --port <n>", "port", "4180")
  .action(async (o: { port: string }) => {
    const s = await startServer(ctx(), { port: num(o.port, "--port") ?? 4180 });
    out(`Job Radar at ${s.url} (127.0.0.1 only). Ctrl+C to stop.`);
  });

program
  .command("backup")
  .description("Consistent database snapshot plus the irreplaceable local files")
  .option("--keep <n>", "keep this many backups", "14")
  .option("--out <dir>", "backup root")
  .option("--with-artifacts", "also copy generated documents", false)
  .action(async (o: { keep: string; out?: string; withArtifacts: boolean }) => {
    const r = rt();
    const root = o.out ? resolve(o.out) : r.paths.backups;
    const stamp = r.ctx.clock.now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = resolve(root, `jr-${stamp}`);
    const { bytes } = await backupDatabase(r.db, resolve(dir, "jr.sqlite"));
    if (existsSync(r.paths.config)) cpSync(r.paths.config, resolve(dir, "config"), { recursive: true });
    if (o.withArtifacts && existsSync(r.paths.artifacts)) cpSync(r.paths.artifacts, resolve(dir, "artifacts"), { recursive: true });
    out(`Backed up to ${dir} (database ${(bytes / 1e6).toFixed(1)} MB, integrity checked)`);
    const keep = num(o.keep, "--keep") ?? 14;
    const all = readdirSync(root).filter((f) => f.startsWith("jr-") && statSync(resolve(root, f)).isDirectory()).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) {
      rmSync(resolve(root, old), { recursive: true, force: true });
      out(`pruned ${old}`);
    }
  });

program
  .command("import-legacy")
  .description("Bring over a previous Job Radar: database, and optionally its config, resume and personal files")
  .requiredOption("--db <file>", "old data/job-radar.sqlite")
  .option("--old-root <dir>", "old repo root, to convert career-profile.yaml, sources.yaml, resume.yaml, personal.yaml")
  .action(async (o: { db: string; oldRoot?: string }) => {
    const paths = rt().paths;
    if (o.oldRoot) {
      const root = resolve(o.oldRoot);
      const converted = convertLegacyConfig(resolve(root, "config/career-profile.yaml"), resolve(root, "config/sources.yaml"));
      for (const [key, rel] of Object.entries(CONFIG_FILES)) {
        const dest = resolve(paths.config, rel);
        if (existsSync(dest)) {
          out(`kept existing ${dest}`);
          continue;
        }
        writeFileAtomic(dest, stringify(converted[key as keyof typeof converted], { lineWidth: 0 }));
        out(`wrote ${dest}`);
      }
      for (const [from, to] of [
        ["config/resume.yaml", paths.evidence],
        ["config/personal.yaml", paths.personal],
      ] as const) {
        const src = resolve(root, from);
        if (existsSync(src) && !existsSync(to)) {
          mkdirSync(resolve(to, ".."), { recursive: true });
          cpSync(src, to);
          out(`copied ${basename(src)} -> ${to}`);
        }
      }
    }
    const data = readLegacy(resolve(o.db));
    const r = report(await withRun(ctx(), "import-legacy", () => importLegacy(ctx(), data)));
    out(JSON.stringify(r.value, null, 2));
  });

const interview = program.command("interview").description("Interview log");
interview
  .command("add <application>")
  .requiredOption("--stage <stage>")
  .option("--on <date>", "when (default today)")
  .option("--questions <q...>")
  .option("--topics <t...>")
  .option("--rating <1-5>")
  .option("--comp", "compensation was discussed", false)
  .option("--notes <text>")
  .action((q: string, o: { stage: string; on?: string; questions?: string[]; topics?: string[]; rating?: string; comp: boolean; notes?: string }) => {
    const c = ctx();
    const app = resolveApplication(c, q);
    const view = applicationViews(c).find((a) => a.id === app.id);
    const id = c.store.addInterview({
      applicationId: app.id,
      company: view?.company ?? "",
      role: view?.title ?? "",
      stage: o.stage,
      occurredOn: (o.on ? iso(o.on) : c.clock.now().toISOString()).slice(0, 10),
      questions: o.questions ?? [],
      topics: o.topics ?? [],
      selfRating: o.rating ? Number(o.rating) : null,
      compDiscussed: o.comp,
      notes: o.notes ?? null,
      recordedAt: c.clock.now().toISOString(),
    });
    out(`Logged interview #${id}.`);
  });
interview
  .command("list [company]")
  .action((company?: string) => {
    for (const i of ctx().store.interviews(company)) out(`${i.occurredOn} ${i.company} - ${i.role} [${i.stage}] ${i.questions.length} question(s)`);
  });

/* -------------------------------------------------------------------- main */

program
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof UserError || err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    // `serve` keeps the process (and the database) open until Ctrl+C.
    if (runtime && program.args[0] !== "serve") runtime.close();
  });
