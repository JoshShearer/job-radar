import { z } from "zod";

/**
 * Career profile schema. Validation is strict on purpose: a typo in the YAML
 * that silently disables a filter is worse than a crash on startup.
 */

const SignalSchema = z.object({
  term: z.string().min(1),
  weight: z.number(),
  lane: z.string().min(1),
});

const NegativeSignalSchema = z.object({
  term: z.string().min(1),
  weight: z.number(),
});

const ComboSchema = z.object({
  name: z.string().min(1),
  all: z.array(z.string().min(1)).min(1),
  bonus: z.number(),
  lane: z.string().min(1),
  why: z.string().default(""),
});

const LaneSchema = z.object({
  label: z.string().min(1),
  weight: z.number().min(0).max(1),
});

export const CareerProfileSchema = z.object({
  identity: z.object({
    name: z.string().min(1),
    headline: z.string().default(""),
    years_experience: z.number().int().nonnegative().default(0),
  }),
  compensation: z.object({
    currency: z.string().default("USD"),
    target_min: z.number().positive(),
    target_max: z.number().positive(),
    acceptable_min: z.number().positive(),
    reject_below_max: z.number().positive(),
    stretch_min: z.number().positive(),
    stretch_max: z.number().positive(),
    contract_min_hourly: z.number().positive(),
    contract_max_hourly: z.number().positive(),
    prefer_employment_type: z.enum(["full_time", "contract", "either"]).default("full_time"),
  }),
  location: z.object({
    home_metro: z.string().min(1),
    remote_ok: z.boolean(),
    hybrid_metros: z.array(z.string()).default([]),
    onsite_ok_metros: z.array(z.string()).default([]),
    relocation_ok: z.boolean(),
    work_authorization_blockers: z.array(z.string()).default([]),
  }),
  lanes: z.record(z.string(), LaneSchema),
  seniority: z.object({
    accept: z.array(z.string()).default([]),
    reject: z.array(z.string()).default([]),
  }),
  target_titles: z.record(z.string(), z.array(z.string())),
  signals: z.array(SignalSchema).min(1),
  combos: z.array(ComboSchema).default([]),
  negative_signals: z.array(NegativeSignalSchema).default([]),
  hard_exclude_titles: z.array(z.string()).default([]),
  hard_exclude_description: z.array(z.string()).default([]),
  scoring: z.object({
    normalize_divisor: z.number().positive(),
    title_match_bonus: z.number(),
    title_multiplier: z.number().positive(),
    freshness_full_days: z.number().positive(),
    freshness_zero_days: z.number().positive(),
    freshness_max_points: z.number().nonnegative(),
    analysis_threshold: z.number().min(0).max(100),
    report_threshold: z.number().min(0).max(100),
  }),
  roi: z.object({
    weights: z.object({
      fit: z.number(),
      differentiation: z.number(),
      compensation: z.number(),
      competition: z.number(),
      recency: z.number(),
      reachability: z.number(),
    }),
    competition: z.object({
      big_tech_penalty: z.number(),
      unknown_company_neutral: z.number(),
      small_company_bonus: z.number(),
    }),
  }),
  report: z.object({
    max_priority_a: z.number().int().positive(),
    max_priority_b: z.number().int().positive(),
    max_priority_c: z.number().int().positive(),
    max_total: z.number().int().positive(),
  }),
});

export type CareerProfile = z.infer<typeof CareerProfileSchema>;

const BoardSchema = z.object({
  token: z.string().min(1),
  company: z.string().min(1),
});

export const SourcesConfigSchema = z.object({
  http: z
    .object({
      delay_ms: z.number().int().nonnegative().default(1200),
      timeout_ms: z.number().int().positive().default(20000),
      max_retries: z.number().int().nonnegative().max(5).default(2),
      user_agent: z.string().min(1),
    })
    .default({
      delay_ms: 1200,
      timeout_ms: 20000,
      max_retries: 2,
      user_agent: "job-radar/0.1",
    }),
  sources: z.object({
    greenhouse: z
      .object({ enabled: z.boolean().default(true), boards: z.array(BoardSchema).default([]) })
      .default({ enabled: false, boards: [] }),
    lever: z
      .object({ enabled: z.boolean().default(true), boards: z.array(BoardSchema).default([]) })
      .default({ enabled: false, boards: [] }),
    ashby: z
      .object({ enabled: z.boolean().default(true), boards: z.array(BoardSchema).default([]) })
      .default({ enabled: false, boards: [] }),
    remoteok: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  }),
  watchlist: z
    .array(z.object({ company: z.string().min(1), why: z.string().default("") }))
    .default([]),
});

export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;
