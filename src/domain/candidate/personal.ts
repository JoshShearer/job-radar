import { z } from "zod";

/**
 * Personal details for application forms. Stated by the candidate, transcribed
 * verbatim, never inferred. An empty or null value means UNKNOWN: the field is
 * left blank and reported, never filled with a default. Answering "no
 * sponsorship needed" for someone who needs it is a false statement on a job
 * application, not a mis-ranking.
 */
export const PersonalSchema = z
  .object({
    identity: z
      .object({
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().default(""),
        city: z.string().default(""),
        state: z.string().default(""),
        postal_code: z.string().default(""),
        country: z.string().default("United States"),
      })
      .strict(),
    links: z
      .object({
        linkedin: z.string().default(""),
        github: z.string().default(""),
        website: z.string().default(""),
        twitter: z.string().default(""),
      })
      .strict()
      .prefault({}),
    work_eligibility: z
      .object({
        authorized_to_work_us: z.boolean().nullable().default(null),
        requires_sponsorship: z.boolean().nullable().default(null),
        authorization_option_hint: z.string().default("authorized to work in this country"),
      })
      .strict(),
    preferences: z
      .object({
        referral_source: z.string().default(""),
        desired_salary: z.string().default(""),
        notice_period: z.string().default(""),
      })
      .strict()
      .prefault({}),
    /** Company-specific answers, checked before any built-in rule. First match wins. */
    answers: z.array(z.object({ match: z.string().min(1), answer: z.string() }).strict()).default([]),
  })
  .strict();

export type Personal = z.infer<typeof PersonalSchema>;

export function contactLine(p: Personal | null): string[] {
  if (!p) return [];
  return [
    p.identity.email,
    p.identity.phone,
    [p.identity.city, p.identity.state].filter(Boolean).join(", "),
    p.links.linkedin,
    p.links.github,
    p.links.website,
  ].filter(Boolean);
}
