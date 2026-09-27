import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { EnrichedJob } from "../model/job.js";
import { truncateWords } from "../lib/html.js";
import type { Resume } from "./schema.js";
import { allBullets } from "./schema.js";
import type { MatchReport } from "./requirements.js";
import type { Violation } from "./provenance.js";
import { enforceProvenance } from "./render.js";
import type { TokenUsage } from "../lib/cost.js";
import type { JobRepo } from "../db/repo.js";
import { callModelWithReceipt } from "../db/receipts.js";

/**
 * Tailoring: choose which of the candidate's real bullets to show, in what
 * order, and phrase them in the posting's vocabulary.
 *
 * The model selects and rephrases. It never authors. Everything it returns is
 * checked against the master resume before it reaches a page, and any rewrite
 * that fails falls back to the original wording - degrading to the truth is
 * always available, so there is never a reason to ship an unchecked claim.
 */

export const TailorSchema = z.object({
  positioning: z.string(),
  headline: z.string(),
  summary: z.string(),
  skillGroups: z.array(z.object({ label: z.string(), skills: z.array(z.string()) })),
  roles: z.array(
    z.object({
      roleId: z.string(),
      bulletIds: z.array(z.string()),
      rewrites: z.array(z.object({ bulletId: z.string(), text: z.string() })),
    }),
  ),
  projectIds: z.array(z.string()),
  omitted: z.array(z.object({ id: z.string(), why: z.string() })),
  gapsToExpect: z.array(z.string()),
  doNotClaim: z.array(z.string()),
});

export type TailorPlan = z.infer<typeof TailorSchema>;

const TAILOR_JSON_SCHEMA = {
  type: "object",
  properties: {
    positioning: { type: "string", description: "One or two sentences: the frame this resume argues." },
    headline: { type: "string", description: "The title line. Must be defensible, not aspirational." },
    summary: { type: "string", description: "3-4 lines. Only claims evidenced by selected bullets." },
    skillGroups: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, skills: { type: "array", items: { type: "string" } } },
        required: ["label", "skills"],
        additionalProperties: false,
      },
      description: "Skills grouped for this role, most relevant group first. Names must come from the master list.",
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          roleId: { type: "string" },
          bulletIds: { type: "array", items: { type: "string" } },
          rewrites: {
            type: "array",
            items: {
              type: "object",
              properties: { bulletId: { type: "string" }, text: { type: "string" } },
              required: ["bulletId", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["roleId", "bulletIds", "rewrites"],
        additionalProperties: false,
      },
    },
    projectIds: { type: "array", items: { type: "string" } },
    omitted: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, why: { type: "string" } },
        required: ["id", "why"],
        additionalProperties: false,
      },
    },
    gapsToExpect: { type: "array", items: { type: "string" } },
    doNotClaim: { type: "array", items: { type: "string" } },
  },
  required: [
    "positioning", "headline", "summary", "skillGroups", "roles",
    "projectIds", "omitted", "gapsToExpect", "doNotClaim",
  ],
  additionalProperties: false,
} as const;

export interface TailorResult {
  plan: TailorPlan;
  violations: Violation[];
  /** Rewrites that failed provenance and were reverted to the master wording. */
  reverted: string[];
  usage: TokenUsage;
  /** The call was billed but reported no usage. Counted, never thrown on. */
  usageMissing: boolean;
}

export async function tailorResume(
  resume: Resume,
  job: EnrichedJob,
  match: MatchReport,
  opts: { model: string; effort: string },
  repo: JobRepo,
  runId: number | null,
): Promise<TailorResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const client = new Anthropic({ apiKey });

  const inventory = allBullets(resume)
    .filter((b) => b.bullet.verified)
    .map((b) => `  ${b.bullet.id} [${b.sourceLabel}] (${b.bullet.skills.join(", ") || "untagged"}): ${b.bullet.text}`)
    .join("\n");

  const roles = resume.experience
    .map((r) => `  ${r.id}: ${r.title}, ${r.company} (${r.start} to ${r.end ?? "present"})`)
    .join("\n");

  const system = `You tailor one senior engineer's resume to one job posting. You select and rephrase; you never author.

THE MASTER RESUME IS THE ONLY SOURCE OF FACT.
- You may only use bullet ids listed in the inventory you are given.
- You may rephrase a bullet to use the posting's vocabulary, but the claim must stay identical in substance.
- You may NOT introduce a technology that is not already in the bullet or the master skill list.
- You may NOT introduce or change a number. If the bullet says "200+", the rewrite says "200+" or omits it.
- You may NOT promote scope. "Contributed to" does not become "Led". "Built a feature" does not become "Owned the platform".
- Rewrites are checked mechanically against the source. A rewrite that adds a technology or a figure is discarded and the original wording is used instead, so the only effect of overreaching is a worse resume.

SELECTION IS THE REAL WORK.
A tailored resume is defined by what it leaves out. Choose the bullets that evidence THIS posting's requirements, drop the ones that do not, and put the strongest evidence first within each role. Do not include every bullet.

Skill groups: order by relevance to this posting. Only use skill names from the master list.

gapsToExpect: requirements this resume genuinely does not evidence, stated plainly. These are what interviewers will probe.
doNotClaim: things the posting wants that the candidate must not imply anywhere in the application.`;

  const user = `# THE ROLE

${job.title} at ${job.company}
${job.location} (${job.remoteStatus})

# REQUIREMENT COVERAGE (computed deterministically)

Required coverage: ${match.requiredCoverage}%   Preferred coverage: ${match.preferredCoverage}%
Skills this posting names that the candidate claims: ${match.relevantSkills.join(", ") || "none"}
Terms the posting names that the candidate does NOT claim: ${match.unclaimedTerms.join(", ") || "none"}

Requirements with no supporting evidence:
${match.gaps.map((g) => `  - [${g.weight}] ${g.text}`).join("\n") || "  (none)"}

# ROLES

${roles}

# BULLET INVENTORY (the only material you may use)

${inventory}

# POSTING

${truncateWords(job.descriptionClean, 6000)}

Return only the structured object.`;

  const { result, usage, usageMissing } = await callModelWithReceipt(
    repo,
    { runId, jobId: job.id, purpose: "tailor", model: opts.model, tier: null },
    () =>
      client.messages
        .stream({
          model: opts.model,
          max_tokens: 16000,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          output_config: {
            effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max",
            format: { type: "json_schema", schema: TAILOR_JSON_SCHEMA as unknown as Record<string, unknown> },
          },
          messages: [{ role: "user", content: user }],
        })
        .finalMessage(),
    (response) => {
      const message = response as Anthropic.Message;
      if (message.stop_reason === "refusal") throw new Error("Model declined to tailor this resume.");
      const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
      if (!text) throw new Error("No text block in response.");

      const parsed = TailorSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        throw new Error(
          `Tailoring plan failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }

      const plan = parsed.data;
      // The one true provenance check, defined in render.ts alongside the
      // composition it guards. Called here too so the run's own report
      // (below, and the caller's cost/violation accounting) reflects what the
      // model actually got wrong - `composeResume` will re-run it before
      // rendering.
      const { violations, reverted } = enforceProvenance(resume, plan);
      return { plan, violations, reverted };
    },
  );

  return { plan: result.plan, violations: result.violations, reverted: result.reverted, usage, usageMissing };
}
