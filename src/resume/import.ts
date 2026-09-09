import Anthropic from "@anthropic-ai/sdk";
import { ResumeSchema, type Resume } from "./schema.js";
import { readUsage } from "../lib/cost.js";

/**
 * Turn an existing resume into the structured master file.
 *
 * This is restructuring, not writing. The model may only reorganize text the
 * candidate already wrote: split prose into bullets, tag which skills each
 * bullet evidences, assign stable ids. It may not add an employer, a date, a
 * metric, a technology, or an accomplishment that is not in the source, and it
 * may not "improve" a bullet's claim. Anything it is unsure of is marked
 * `verified: false`, which permanently excludes it from generated resumes
 * until a human confirms it.
 */

const RESUME_JSON_SCHEMA = {
  type: "object",
  properties: {
    basics: {
      type: "object",
      properties: {
        name: { type: "string" },
        headline: { type: "string" },
        location: { type: "string" },
        summary: { type: "string" },
      },
      required: ["name", "headline", "location", "summary"],
      additionalProperties: false,
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          level: { type: "string", enum: ["expert", "strong", "working", "familiar"] },
          category: { type: "string" },
        },
        required: ["name", "aliases", "level", "category"],
        additionalProperties: false,
      },
    },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          company: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: ["string", "null"] },
          location: { type: "string" },
          context: { type: "string" },
          employment_type: {
            type: "string",
            enum: ["full_time", "contract", "founder", "part_time", "internship"],
          },
          bullets: { $ref: "#/$defs/bullets" },
        },
        required: ["id", "company", "title", "start", "end", "location", "context", "employment_type", "bullets"],
        additionalProperties: false,
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          url: { type: "string" },
          context: { type: "string" },
          bullets: { $ref: "#/$defs/bullets" },
        },
        required: ["id", "name", "url", "context", "bullets"],
        additionalProperties: false,
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          school: { type: "string" },
          credential: { type: "string" },
          year: { type: "string" },
        },
        required: ["id", "school", "credential", "year"],
        additionalProperties: false,
      },
    },
    uncertain: {
      type: "array",
      items: { type: "string" },
      description: "Anything ambiguous in the source that a human must resolve.",
    },
  },
  required: ["basics", "skills", "experience", "projects", "education", "uncertain"],
  additionalProperties: false,
  $defs: {
    bullets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          verified: { type: "boolean" },
        },
        required: ["id", "text", "skills", "verified"],
        additionalProperties: false,
      },
    },
  },
} as const;

export async function importResume(
  sourceText: string,
  opts: { model: string; effort: string },
): Promise<{ resume: Resume; uncertain: string[]; usage: { input: number; output: number } }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });

  const system = `You convert an existing resume into a structured record. You are a parser with judgement, not a writer.

ABSOLUTE RULES:
- Never add an employer, title, date, metric, technology, or accomplishment that is not in the source text.
- Never strengthen a claim. "Worked on" does not become "Led". "Improved performance" does not acquire a percentage.
- Never invent a date. If a date is missing or ambiguous, use your best reading and list it in "uncertain".
- If you cannot tell whether something is a real accomplishment or a job-description-style duty, keep the wording and set verified: false.
- Preserve the candidate's own numbers exactly as written.

WHAT YOU MAY DO:
- Split a paragraph into separate bullets, one claim each.
- Tag each bullet with the skills it is EVIDENCE for, using skill names you also list in "skills".
- Normalize dates to YYYY-MM. A resume saying "2021" with no month becomes 2021-01 and goes in "uncertain".
- Assign short stable ids: roles like "role-acme", bullets like "b-acme-1", projects like "proj-shroomspy".
- Infer a skills list from what the bullets actually demonstrate, with aliases a job posting might use ("Next.js" -> "NextJS", "Next JS").

VERIFIED FLAG:
Set verified: true only for concrete things the candidate did that they could defend in an interview. Set verified: false for vague duty statements, anything you had to guess at, and anything that reads like it was copied from a job description. Unverified bullets are excluded from every generated resume until a human confirms them, so err toward false.`;

  // Streamed: a full resume at this token budget can exceed the 10-minute
  // non-streaming request ceiling, and the SDK rejects the call outright.
  const response = await client.messages
    .stream({
      model: opts.model,
      max_tokens: 32000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max",
        format: { type: "json_schema", schema: RESUME_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: [{ role: "user", content: `Convert this resume into the structured format.\n\n---\n\n${sourceText}` }],
    })
    .finalMessage();

  if (response.stop_reason === "refusal") throw new Error("Model declined to parse this resume.");
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("No text block in response.");

  const raw = JSON.parse(text) as { uncertain?: string[] };
  const parsed = ResumeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Imported resume failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return {
    resume: parsed.data,
    uncertain: raw.uncertain ?? [],
    usage: readUsage(response, "resume import").usage,
  };
}
