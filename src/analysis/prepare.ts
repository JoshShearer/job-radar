import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CareerProfile } from "../config/schema.js";
import type { EnrichedJob } from "../model/job.js";
import { ApplicationPackSchema, APPLICATION_JSON_SCHEMA, type ApplicationPack } from "./application.js";
import { buildSystemPrompt } from "./prompt.js";
import { truncateWords } from "../lib/html.js";
import { formatSalary } from "../lib/salary.js";
import { PROJECT_ROOT } from "../config/load.js";
import { markdownToHtml } from "../report/html.js";
import { log } from "../lib/log.js";

export const APPLICATIONS_DIR = resolve(PROJECT_ROOT, "applications");

/**
 * PREPARE APPLICATION MATERIAL.
 *
 * Produces everything needed to submit, and submits nothing. No form is
 * filled, no message is sent, no request goes anywhere except to the model.
 * The output is files on disk for a human to read, edit, and act on.
 *
 * That boundary is the point of the whole system, not a limitation of it.
 */
export async function prepareApplication(
  job: EnrichedJob,
  profile: CareerProfile,
  opts: { model: string; effort: string },
): Promise<{ pack: ApplicationPack; usage: { input: number; cacheRead: number; output: number } }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });
  const analysis = job.analysis;

  const salary = formatSalary({
    min: job.salaryMin,
    max: job.salaryMax,
    currency: job.salaryCurrency,
    period: job.salaryPeriod,
    confidence: job.salaryMin != null ? "published" : "none",
    raw: null,
  });

  const priorAnalysis = analysis
    ? [
        `Fit ${analysis.fitScore} / ROI ${analysis.applicationRoi} / ${analysis.recommendation}`,
        `Differentiation: ${analysis.differentiation}`,
        `Strengths: ${analysis.strengths.join(" | ")}`,
        `Risks: ${analysis.risks.join(" | ")}`,
        `Missing: ${analysis.missingRequirements.join(" | ")}`,
        `Compensation: ${analysis.salaryReasoning}`,
      ].join("\n")
    : "No prior analysis - work from the posting alone.";

  const userPrompt = `You are preparing an application package. It will be read and edited by the candidate, then submitted BY HIM. Nothing you write is sent anywhere automatically.

# THE ROLE

Company: ${job.company}
Title: ${job.title}
Location: ${job.location} (${job.remoteStatus})
Published compensation: ${salary}
Posted: ${job.datePosted ?? "not stated"}
Application URL: ${job.applicationUrl ?? job.sourceUrl}

# PRIOR ANALYSIS OF THIS ROLE

${priorAnalysis}

# FULL POSTING

${truncateWords(job.descriptionClean, 9000)}

# WHAT TO PRODUCE

Build the package around the ONE frame that makes him the obvious candidate, not a list of everything he has done.

Hard constraints, which matter more than polish:
- Never state or imply experience he does not have. If the posting demands something he cannot evidence, it goes in doNotClaim, not into the cover note dressed up as a near-miss.
- Never invent a person's name. outreachMessages target role titles only.
- Never claim he has used the company's product, read their engineering blog, or inspected their site unless the posting itself establishes it.
- The cover note and outreach must reference something concrete and real from the posting. No "I'd love to connect", no fake familiarity, no flattery.
- openDecisions is for genuine tradeoffs only he can resolve - travel, level, location, contract terms. Be direct; do not soften a real problem.
- Compensation: he is told never to be given a bare "ask for exactly $X". Give target, anchor, walk-away, and whether to ask for their range first, with the reasoning.

Return only the structured object.`;

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 16000,
    system: [{ type: "text", text: buildSystemPrompt(profile), cache_control: { type: "ephemeral" } }],
    output_config: {
      effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max",
      format: { type: "json_schema", schema: APPLICATION_JSON_SCHEMA as unknown as Record<string, unknown> },
    },
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.stop_reason === "refusal") throw new Error("Model declined to prepare this application.");

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("No text block in response.");

  const parsed = ApplicationPackSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `Application pack failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  return {
    pack: parsed.data,
    usage: {
      input: response.usage.input_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      output: response.usage.output_tokens,
    },
  };
}

/** Render the pack as Markdown. */
export function renderPack(job: EnrichedJob, pack: ApplicationPack, profile: CareerProfile): string {
  const L: string[] = [];
  const c = pack.compensationStrategy;

  L.push(`# Application pack - ${job.title}, ${job.company}`);
  L.push("");
  L.push("```");
  L.push(`Job ID      : ${job.id}`);
  L.push(`Apply at    : ${job.applicationUrl ?? job.sourceUrl}`);
  L.push(`Compensation: ${job.compensationBand ?? "UNKNOWN"}`);
  L.push(`Status      : NOT SUBMITTED - this is preparation only`);
  L.push("```");
  L.push("");

  L.push("## Decide these first");
  L.push("");
  L.push("Nothing below is worth doing until these are settled.");
  L.push("");
  for (const d of pack.openDecisions.slice(0, 6)) L.push(`- [ ] ${d}`);
  L.push("");

  L.push("## The frame");
  L.push("");
  L.push(pack.positioningStatement);
  L.push("");

  L.push("## Resume");
  L.push("");
  L.push(`**Start from:** \`${pack.resumeVariant}\` - ${pack.resumeVariantReason}`);
  L.push("");
  L.push("**Suggested summary section:**");
  L.push("");
  L.push("> " + pack.summaryRewrite.split("\n").join("\n> "));
  L.push("");
  L.push("**Edits to make:**");
  L.push("");
  for (const e of pack.resumeEdits.slice(0, 6)) {
    L.push(`- **${e.change}**`);
    L.push(`  - ${e.why}`);
  }
  L.push("");
  if (pack.keywordsToAdd.length) {
    L.push(`**Honest keywords currently missing:** ${pack.keywordsToAdd.slice(0, 14).join(", ")}`);
    L.push("");
    L.push("_Only add these where they describe real work. Do not keyword-stuff._");
    L.push("");
  }

  L.push("## Do NOT claim");
  L.push("");
  L.push("These are in the posting and cannot be evidenced. Saying otherwise is the one unrecoverable mistake.");
  L.push("");
  for (const d of pack.doNotClaim.slice(0, 8)) L.push(`- ${d}`);
  L.push("");

  L.push("## Cover note");
  L.push("");
  L.push(pack.coverNote);
  L.push("");

  if (pack.formAnswers.length) {
    L.push("## Likely form questions");
    L.push("");
    for (const f of pack.formAnswers.slice(0, 6)) {
      L.push(`**${f.question}**`);
      L.push("");
      L.push(f.answer);
      L.push("");
    }
  }

  L.push("## Outreach");
  L.push("");
  L.push(
    "Titles only - find the actual people yourself. **Send nothing without reading it first.** " +
      "The analysis was explicit that a cold application here is weak on its own.",
  );
  L.push("");
  for (const o of pack.outreachMessages.slice(0, 3)) {
    L.push(`### ${o.targetTitle} (${o.channel})`);
    L.push("");
    L.push(o.message);
    L.push("");
  }

  L.push("## Compensation");
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| **Ask for their range first** | ${c.askForTheirRangeFirst ? "Yes" : "No"} |`);
  L.push(`| **Target** | ${c.targetNumber} |`);
  L.push(`| **Anchor** | ${c.anchorNumber} |`);
  L.push(`| **Walk away** | ${c.walkAway} |`);
  L.push("");
  L.push(c.reasoning);
  L.push("");
  L.push("**What to say:**");
  L.push("");
  L.push("> " + c.suggestedWording.split("\n").join("\n> "));
  L.push("");

  L.push("## Interview prep");
  L.push("");
  L.push("**Likely questions:**");
  L.push("");
  for (const q of pack.interviewPrep.likelyQuestions.slice(0, 10)) L.push(`- ${q}`);
  L.push("");
  L.push("**Stories to have ready:**");
  L.push("");
  for (const s of pack.interviewPrep.storiesToPrepare.slice(0, 7)) L.push(`- ${s}`);
  L.push("");
  L.push("**Ask them:**");
  L.push("");
  for (const q of pack.interviewPrep.questionsToAskThem.slice(0, 7)) L.push(`- ${q}`);
  L.push("");

  L.push("---");
  L.push("");
  L.push("## Submit checklist");
  L.push("");
  L.push("- [ ] Open decisions above are resolved");
  L.push("- [ ] Resume edited and exported to PDF");
  L.push("- [ ] Cover note read end to end and edited into your own voice");
  L.push("- [ ] Nothing in the application claims anything from the Do NOT claim list");
  L.push(`- [ ] Submitted at ${job.applicationUrl ?? job.sourceUrl}`);
  L.push(`- [ ] \`npm run cli -- status ${job.id} APPLIED\``);
  L.push("- [ ] Outreach sent (separately, after the application lands)");
  L.push("");
  L.push(
    `_Prepared ${new Date().toISOString()} for ${profile.identity.name}. ` +
      `Nothing here has been sent. You submit it._`,
  );

  return L.join("\n");
}

/** Directory holding the prepared material for one job. */
export function packDir(job: EnrichedJob): string {
  return resolve(APPLICATIONS_DIR, `${job.id}-${slug(job.company)}`);
}

/**
 * Write the pack to applications/<job-id>/ as Markdown + HTML, plus the raw
 * JSON. The JSON is what `autofill` reads to type drafted answers into the
 * real form, so it is written even though a human never opens it.
 */
export function writePack(
  job: EnrichedJob,
  markdown: string,
  pack?: ApplicationPack,
): { dir: string; md: string; html: string; json: string | null } {
  const dir = packDir(job);
  mkdirSync(dir, { recursive: true });

  const md = resolve(dir, "application-pack.md");
  const html = resolve(dir, "application-pack.html");
  writeFileSync(md, markdown, "utf8");
  writeFileSync(html, markdownToHtml(markdown, `${job.title} - ${job.company}`), "utf8");

  let json: string | null = null;
  if (pack) {
    json = resolve(dir, "pack.json");
    writeFileSync(json, JSON.stringify(pack, null, 2), "utf8");
  }

  log.debug(`wrote application pack to ${dir}`);
  return { dir, md, html, json };
}

/** Load a previously prepared pack, or null if this job has not been prepared. */
export function loadPack(job: EnrichedJob): ApplicationPack | null {
  const file = resolve(packDir(job), "pack.json");
  if (!existsSync(file)) return null;
  const parsed = ApplicationPackSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data : null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
