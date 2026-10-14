import { z } from "zod";

/**
 * Configuration, split by OWNER and CHANGE RATE rather than kept in one file:
 *
 *   search/strategy.yaml      what to look for (lanes, signals, exclusions)
 *   candidate/preferences.yaml what the candidate wants (pay, location)
 *   policy/evaluation.yaml    how postings are scored, ranked, routed
 *   operations.yaml           budgets, models, mail, transport
 *   sources.yaml              which boards to sweep
 *
 * Candidate FACTS are not configuration. They live in the evidence ledger
 * (candidate/evidence.yaml), which is the only source of claims about the
 * candidate anywhere in the system.
 *
 * Every schema is strict: an unknown key is an error, because a misspelled key
 * that silently falls back to a default disables a rule without telling anyone.
 */

const term = z.string().trim().min(1);

export const StrategySchema = z
  .object({
    lanes: z.record(z.string(), z.object({ label: term, weight: z.number().min(0).max(1) }).strict()),
    seniority: z.object({ accept: z.array(z.string()).default([]), reject: z.array(z.string()).default([]) }).strict(),
    target_titles: z.record(z.string(), z.array(term)).default({}),
    signals: z.array(z.object({ term, weight: z.number(), lane: term }).strict()).min(1),
    combos: z
      .array(
        z.object({ name: term, all: z.array(term).min(1), bonus: z.number(), lane: term, why: z.string().default("") }).strict(),
      )
      .default([]),
    negative_signals: z.array(z.object({ term, weight: z.number() }).strict()).default([]),
    hard_exclude_titles: z.array(z.string()).default([]),
    hard_exclude_description: z.array(z.string()).default([]),
  })
  .strict();
export type Strategy = z.infer<typeof StrategySchema>;

export const PreferencesSchema = z
  .object({
    compensation: z
      .object({
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
      })
      .strict(),
    location: z
      .object({
        home_metro: term,
        remote_ok: z.boolean(),
        hybrid_metros: z.array(z.string()).default([]),
        onsite_ok_metros: z.array(z.string()).default([]),
        relocation_ok: z.boolean(),
        work_authorization_blockers: z.array(z.string()).default([]),
      })
      .strict(),
    /** Free-text search intent shown to the analyst ("stable W-2 preferred"). */
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;

const PriorityBand = z.object({ min_fit: z.number(), min_roi: z.number() }).strict();

export const EvaluationPolicySchema = z
  .object({
    scoring: z
      .object({
        normalize_divisor: z.number().positive(),
        title_match_bonus: z.number(),
        title_multiplier: z.number().positive(),
        freshness_full_days: z.number().positive(),
        freshness_zero_days: z.number().positive(),
        freshness_max_points: z.number().nonnegative(),
        evergreen_days: z.number().positive(),
        stale_warning_days: z.number().positive().default(90),
        report_threshold: z.number().min(0).max(100),
      })
      .strict(),
    roi: z
      .object({
        weights: z
          .object({
            fit: z.number(),
            differentiation: z.number(),
            compensation: z.number(),
            competition: z.number(),
            recency: z.number(),
            reachability: z.number(),
          })
          .strict(),
        competition: z
          .object({
            big_tech_penalty: z.number(),
            unknown_company_neutral: z.number(),
            small_company_bonus: z.number(),
          })
          .strict(),
      })
      .strict(),
    /**
     * Priority bands, used by EVERY path that assigns a deterministic priority.
     * `A` additionally needs a combo or `a_without_combo_min_fit`.
     */
    priority: z
      .object({
        A: PriorityBand,
        a_without_combo_min_fit: z.number(),
        B: PriorityBand,
        C: z.object({ min_fit: z.number() }).strict(),
      })
      .strict(),
    reconcile: z.object({ analyst_roi_weight: z.number().min(0).max(1) }).strict(),
    calibration: z
      .object({
        min_sample: z.number().int().positive(),
        min_ratio: z.number().positive(),
        max_ratio: z.number().positive(),
      })
      .strict(),
    assessment: z
      .object({
        two_stage: z.boolean(),
        dossier_for: z.array(z.enum(["apply_and_outreach", "apply", "network_or_watch", "skip"])).min(1),
        dossier_min_fit: z.number().min(0).max(100),
        description_char_budget: z.number().int().positive(),
        max_attempts: z.number().int().positive(),
      })
      .strict(),
    selection: z
      .object({
        per_company_cap: z.number().int().positive(),
        backfill_cap: z.number().int().positive(),
        cold_after: z.number().int().positive(),
        unexplored_bonus: z.number().nonnegative(),
        cold_penalty: z.number().nonnegative(),
        fresh_days: z.number().positive(),
        fresh_bonus: z.number().nonnegative(),
      })
      .strict(),
    lifecycle: z
      .object({
        park_after_days: z.number().positive(),
        max_fraction_per_board: z.number().positive().max(1),
      })
      .strict(),
    report: z
      .object({
        max_priority_a: z.number().int().positive(),
        max_priority_b: z.number().int().positive(),
        max_priority_c: z.number().int().positive(),
        max_total: z.number().int().positive(),
      })
      .strict(),
    source_policy: z
      .object({
        min_analyzed_for_verdict: z.number().int().positive(),
        retire_below_apply_rate: z.number().min(0).max(1),
        watch_below_selection_rate: z.number().min(0).max(1),
        min_passed_for_selection_verdict: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type EvaluationPolicy = z.infer<typeof EvaluationPolicySchema>;

/** The floor no configuration can go below. Other people's free endpoints. */
export const MIN_TRANSPORT_DELAY_MS = 500;

const ModelChoice = z
  .object({
    model: term,
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    max_output_tokens: z.number().int().positive(),
  })
  .strict();

export const OperationsSchema = z
  .object({
    budgets: z
      .object({
        per_run_usd: z.number().positive(),
        per_day_usd: z.number().positive(),
        per_month_usd: z.number().positive(),
      })
      .strict(),
    models: z
      .object({
        triage: ModelChoice,
        assessment: ModelChoice,
        tailor: ModelChoice,
        pack: ModelChoice,
        import: ModelChoice,
      })
      .strict(),
    mail: z
      .object({
        gmail_query: term,
        eml_dir: z.string().nullable().default(null),
        page_size: z.number().int().positive().max(500).default(100),
        max_messages_per_scan: z.number().int().positive().default(2000),
        /** First scan with no prior coverage looks back this far. */
        initial_lookback_days: z.number().int().positive().default(60),
        /** Re-read this much of the previous window, so late-indexed mail is not skipped. */
        overlap_days: z.number().int().nonnegative().default(2),
        ghost_after_days: z.number().int().positive(),
        /** Mail coverage older than this makes the funnel "unobserved". */
        coverage_max_age_days: z.number().int().positive().default(3),
      })
      .strict(),
    sweep: z
      .object({
        /** Briefing warns when the last complete sweep is older than this. */
        stale_after_days: z.number().positive().default(2),
      })
      .strict()
      .prefault({}),
    http: z
      .object({
        delay_ms: z
          .number()
          .int()
          .min(MIN_TRANSPORT_DELAY_MS, `delay_ms may not be below ${MIN_TRANSPORT_DELAY_MS}`)
          .default(1200),
        timeout_ms: z.number().int().positive().default(20000),
        max_retries: z.number().int().nonnegative().max(5).default(2),
        max_retry_after_ms: z.number().int().positive().default(120_000),
        user_agent: term.default("job-radar/1.0 (personal job search)"),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type Operations = z.infer<typeof OperationsSchema>;

const Board = z.object({ token: term, company: term }).strict();

export const SourcesSchema = z
  .object({
    sources: z
      .object({
        greenhouse: z.object({ enabled: z.boolean().default(true), boards: z.array(Board).default([]) }).strict().prefault({}),
        lever: z.object({ enabled: z.boolean().default(true), boards: z.array(Board).default([]) }).strict().prefault({}),
        ashby: z.object({ enabled: z.boolean().default(true), boards: z.array(Board).default([]) }).strict().prefault({}),
        workable: z.object({ enabled: z.boolean().default(true), boards: z.array(Board).default([]) }).strict().prefault({}),
        smartrecruiters: z.object({ enabled: z.boolean().default(true), boards: z.array(Board).default([]) }).strict().prefault({}),
        remoteok: z.object({ enabled: z.boolean().default(false) }).strict().prefault({}),
      })
      .strict(),
    watchlist: z.array(z.object({ company: term, why: z.string().default("") }).strict()).default([]),
  })
  .strict();
export type Sources = z.infer<typeof SourcesSchema>;

export interface Config {
  strategy: Strategy;
  preferences: Preferences;
  policy: EvaluationPolicy;
  operations: Operations;
  sources: Sources;
}

/**
 * Cross-field checks a per-field schema cannot express. Returned rather than
 * thrown so the loader can report every problem at once.
 */
export function coherenceProblems(c: Pick<Config, "strategy" | "preferences" | "policy">): string[] {
  const out: string[] = [];
  const lanes = Object.keys(c.strategy.lanes);
  if (lanes.length === 0) out.push("strategy.lanes: at least one lane is required");
  if (lanes.includes("other")) out.push('strategy.lanes: "other" is reserved for roles that fit no lane');
  const laneSum = Object.values(c.strategy.lanes).reduce((a, l) => a + l.weight, 0);
  if (Math.abs(laneSum - 1) > 0.02) out.push(`strategy.lanes: weights sum to ${laneSum.toFixed(2)}, expected 1.0`);
  for (const s of c.strategy.signals) {
    if (!lanes.includes(s.lane)) out.push(`strategy.signals: "${s.term}" names unknown lane "${s.lane}"`);
  }
  for (const k of c.strategy.combos) {
    if (!lanes.includes(k.lane)) out.push(`strategy.combos: "${k.name}" names unknown lane "${k.lane}"`);
  }
  for (const lane of Object.keys(c.strategy.target_titles)) {
    if (!lanes.includes(lane)) out.push(`strategy.target_titles: unknown lane "${lane}"`);
  }
  const w = c.policy.roi.weights;
  const roiSum = w.fit + w.differentiation + w.compensation + w.competition + w.recency + w.reachability;
  if (Math.abs(roiSum - 1) > 0.02) out.push(`policy.roi.weights sum to ${roiSum.toFixed(2)}, expected 1.0`);
  const comp = c.preferences.compensation;
  if (!(comp.reject_below_max <= comp.acceptable_min)) out.push("preferences.compensation: reject_below_max must be <= acceptable_min");
  if (!(comp.acceptable_min <= comp.target_min)) out.push("preferences.compensation: acceptable_min must be <= target_min");
  if (!(comp.target_min <= comp.target_max)) out.push("preferences.compensation: target_min must be <= target_max");
  if (!(comp.stretch_min <= comp.stretch_max)) out.push("preferences.compensation: stretch_min must be <= stretch_max");
  if (!(comp.contract_min_hourly <= comp.contract_max_hourly)) out.push("preferences.compensation: contract_min_hourly must be <= contract_max_hourly");
  const sc = c.policy.scoring;
  if (!(sc.freshness_full_days < sc.freshness_zero_days)) out.push("policy.scoring: freshness_full_days must be < freshness_zero_days");
  const sel = c.policy.selection;
  if (sel.backfill_cap < sel.per_company_cap) out.push("policy.selection: backfill_cap must be >= per_company_cap");
  const cal = c.policy.calibration;
  if (!(cal.min_ratio < cal.max_ratio)) out.push("policy.calibration: min_ratio must be < max_ratio");
  const p = c.policy.priority;
  if (!(p.A.min_fit >= p.B.min_fit && p.B.min_fit >= p.C.min_fit)) out.push("policy.priority: bands must be ordered A >= B >= C");
  return out;
}
