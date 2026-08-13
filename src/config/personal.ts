import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "./load.js";
import { checkTopLevelKeys } from "./unknown-keys.js";

const PERSONAL_KEYS = ["identity", "links", "work_eligibility", "preferences", "answers"] as const;

/**
 * Personal details used to fill application forms.
 *
 * This file is gitignored and never leaves the machine. Nothing here is
 * inferred, generated, or guessed by a model - every value is stated by the
 * candidate and transcribed verbatim into the form. That is the whole point:
 * answers about work authorization, sponsorship, and location are factual
 * claims about a real person, and a model has no business inventing them.
 */
export const PersonalSchema = z.object({
  identity: z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    email: z.string().email(),
    // Empty is allowed and means "I have not told you". Every field that can be
    // empty is reported as needing you rather than filled with a placeholder -
    // a made-up phone number typed into a real application is worse than a
    // blank one.
    phone: z.string().default(""),
    city: z.string().default(""),
    state: z.string().default(""),
    country: z.string().default("United States"),
  }),
  links: z
    .object({
      linkedin: z.string().default(""),
      github: z.string().default(""),
      website: z.string().default(""),
      twitter: z.string().default(""),
    })
    .default({}),
  work_eligibility: z.object({
    /**
     * `null` means unstated, and unstated means the field is left blank and
     * flagged. There is no safe default here: answering "authorized" for
     * someone who is not, or "no sponsorship needed" for someone who needs it,
     * is a false statement on a job application, not a mis-ranking.
     */
    authorized_to_work_us: z.boolean().nullable().default(null),
    requires_sponsorship: z.boolean().nullable().default(null),
    /**
     * Some forms ask with a sentence-style dropdown rather than yes/no. This
     * hint is scored against the options the form actually offers; if nothing
     * matches confidently the field is left blank and reported, never guessed.
     */
    authorization_option_hint: z.string().default("authorized to work in this country"),
  }),
  preferences: z
    .object({
      referral_source: z.string().default(""),
      /**
       * Left empty by default on purpose. A desired-salary box is the first
       * number in the negotiation, and the prepared pack's advice is almost
       * always to ask for their range first. Empty means "leave it blank and
       * tell me", not "make something up".
       */
      desired_salary: z.string().default(""),
      notice_period: z.string().default(""),
    })
    .default({}),
  /**
   * Escape hatch for company-specific questions. First match wins, and these
   * are checked before any built-in rule, so a bad automatic answer can always
   * be overridden by hand.
   */
  answers: z
    .array(z.object({ match: z.string().min(1), answer: z.string() }))
    .default([]),
});

export type Personal = z.infer<typeof PersonalSchema>;

export function personalPath(): string {
  return process.env.JOB_RADAR_PERSONAL ?? resolve(PROJECT_ROOT, "config", "personal.yaml");
}

export function loadPersonal(file = personalPath()): Personal {
  if (!existsSync(file)) {
    throw new Error(
      `No personal details at ${file}.\n` +
        `Copy config/personal.example.yaml to config/personal.yaml and fill it in. ` +
        `It is gitignored and stays on this machine.`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  checkTopLevelKeys(raw, PERSONAL_KEYS, "config/personal.yaml");

  const parsed = PersonalSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${file} failed validation:\n${issues}`);
  }
  return parsed.data;
}
