import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  EvaluationPolicySchema,
  OperationsSchema,
  PreferencesSchema,
  SourcesSchema,
  StrategySchema,
  MIN_TRANSPORT_DELAY_MS,
  type Config,
} from "../../domain/config/schema.js";

/**
 * Convert the previous single `career-profile.yaml` (+ `sources.yaml`) into
 * the split configuration. Values that used to be hardcoded in TypeScript
 * (priority bands, reconcile weight, calibration bounds, model choices) are
 * written out explicitly with the values the old code used.
 */
export function convertLegacyConfig(profileFile: string, sourcesFile: string): Config {
  const p = parseYaml(readFileSync(profileFile, "utf8")) as Record<string, any>;
  const src = parseYaml(readFileSync(sourcesFile, "utf8")) as Record<string, any>;
  const sc = p.scoring ?? {};
  const strategy = StrategySchema.parse({
    lanes: p.lanes,
    seniority: p.seniority,
    target_titles: p.target_titles ?? {},
    signals: p.signals,
    combos: p.combos ?? [],
    negative_signals: p.negative_signals ?? [],
    hard_exclude_titles: p.hard_exclude_titles ?? [],
    hard_exclude_description: p.hard_exclude_description ?? [],
  });
  const preferences = PreferencesSchema.parse({
    compensation: p.compensation,
    location: p.location,
    notes: p.compensation?.prefer_employment_type === "full_time" ? ["Stable full-time W-2 work is strongly preferred over contract."] : [],
  });
  const policy = EvaluationPolicySchema.parse({
    scoring: {
      normalize_divisor: sc.normalize_divisor,
      title_match_bonus: sc.title_match_bonus,
      title_multiplier: sc.title_multiplier,
      freshness_full_days: sc.freshness_full_days,
      freshness_zero_days: sc.freshness_zero_days,
      freshness_max_points: sc.freshness_max_points,
      evergreen_days: sc.evergreen_days,
      stale_warning_days: 90,
      report_threshold: sc.report_threshold,
    },
    roi: p.roi,
    priority: { A: { min_fit: 78, min_roi: 72 }, a_without_combo_min_fit: 88, B: { min_fit: 65, min_roi: 55 }, C: { min_fit: 45 } },
    reconcile: { analyst_roi_weight: 0.7 },
    calibration: { min_sample: 8, min_ratio: 0.25, max_ratio: 1.5 },
    assessment: {
      two_stage: p.analysis_detail?.two_stage ?? true,
      dossier_for: p.analysis_detail?.dossier_for ?? ["apply_and_outreach", "apply"],
      dossier_min_fit: p.analysis_detail?.dossier_min_fit ?? 70,
      description_char_budget: 7000,
      max_attempts: sc.analysis_max_attempts ?? 2,
    },
    selection: {
      per_company_cap: p.analysis_diversity?.per_company_cap ?? 2,
      backfill_cap: p.analysis_diversity?.per_company_backfill_cap ?? 3,
      cold_after: p.analysis_diversity?.cold_after ?? 6,
      unexplored_bonus: p.analysis_diversity?.unexplored_bonus ?? 8,
      cold_penalty: p.analysis_diversity?.cold_penalty ?? 15,
      fresh_days: sc.analysis_fresh_days ?? 21,
      fresh_bonus: sc.analysis_fresh_bonus ?? 12,
    },
    lifecycle: {
      park_after_days: p.parking?.after_days ?? 3,
      max_fraction_per_board: p.parking?.max_fraction_per_source ?? 0.8,
    },
    report: p.report,
    source_policy: p.source_policy,
  });
  const perRun = Number(sc.max_spend_per_run_usd ?? 1.5);
  const operations = OperationsSchema.parse({
    budgets: { per_run_usd: perRun, per_day_usd: Math.max(perRun * 3, 3), per_month_usd: 45 },
    models: {
      triage: { model: "claude-opus-5", effort: "medium", max_output_tokens: 4000 },
      assessment: { model: "claude-opus-5", effort: "medium", max_output_tokens: 16000 },
      tailor: { model: "claude-opus-5", effort: "high", max_output_tokens: 16000 },
      pack: { model: "claude-sonnet-5", effort: "high", max_output_tokens: 16000 },
      import: { model: "claude-opus-5", effort: "high", max_output_tokens: 16000 },
    },
    mail: {
      gmail_query: p.inbox?.gmail_query ?? "label:job-applications",
      eml_dir: p.inbox?.eml_dir ?? null,
      page_size: Math.min(Number(p.inbox?.scan_limit ?? 100), 500),
      ghost_after_days: p.inbox?.ghost_after_days ?? 30,
    },
    http: {
      delay_ms: Math.max(MIN_TRANSPORT_DELAY_MS, Number(src.http?.delay_ms ?? 1200)),
      timeout_ms: src.http?.timeout_ms ?? 20000,
      max_retries: src.http?.max_retries ?? 2,
      user_agent: src.http?.user_agent ?? "job-radar/1.0 (personal job search)",
    },
  });
  const sources = SourcesSchema.parse({ sources: src.sources, watchlist: src.watchlist ?? [] });
  return { strategy, preferences, policy, operations, sources };
}
