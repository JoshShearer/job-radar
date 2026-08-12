import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CareerProfileSchema, SourcesConfigSchema, type CareerProfile, type SourcesConfig } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "..", "..");

export const paths = {
  profile: () => process.env.JOB_RADAR_PROFILE ?? resolve(PROJECT_ROOT, "config", "career-profile.yaml"),
  sources: () => process.env.JOB_RADAR_SOURCES ?? resolve(PROJECT_ROOT, "config", "sources.yaml"),
  db: () => process.env.JOB_RADAR_DB ?? resolve(PROJECT_ROOT, "data", "job-radar.sqlite"),
  reports: () => process.env.JOB_RADAR_REPORTS ?? resolve(PROJECT_ROOT, "reports"),
  resumes: () => resolve(PROJECT_ROOT, "resumes"),
};

/**
 * Note the generic: it is parameterized on the schema, not on the output type,
 * so `z.infer` resolves to the schema's OUTPUT type (post-defaults). Typing it
 * as `z.ZodType<T>` instead resolves to the input type, which makes every
 * field with a `.default()` come back as possibly-undefined.
 */
function loadYaml<S extends z.ZodTypeAny>(file: string, schema: S, label: string): z.infer<S> {
  if (!existsSync(file)) {
    throw new Error(`${label} not found at ${file}. Copy the example from config/ or set the env override.`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${label} at ${file} is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${label} at ${file} failed validation:\n${issues}`);
  }
  return parsed.data;
}

let cachedProfile: CareerProfile | null = null;
let cachedSources: SourcesConfig | null = null;

export function loadProfile(file = paths.profile()): CareerProfile {
  if (cachedProfile) return cachedProfile;
  const profile = loadYaml(file, CareerProfileSchema, "Career profile");
  validateProfileCoherence(profile);
  cachedProfile = profile;
  return profile;
}

export function loadSources(file = paths.sources()): SourcesConfig {
  if (cachedSources) return cachedSources;
  cachedSources = loadYaml(file, SourcesConfigSchema, "Sources config");
  return cachedSources;
}

/** Reset caches - used by tests. */
export function resetConfigCache(): void {
  cachedProfile = null;
  cachedSources = null;
}

/**
 * Cross-field checks that a per-field schema cannot express. These catch the
 * config mistakes that would silently produce a nonsense slate.
 */
function validateProfileCoherence(p: CareerProfile): void {
  const errors: string[] = [];
  const c = p.compensation;

  if (c.target_min > c.target_max) errors.push("compensation.target_min exceeds target_max");
  if (c.acceptable_min > c.target_min)
    errors.push("compensation.acceptable_min exceeds target_min");
  if (c.reject_below_max > c.acceptable_min)
    errors.push("compensation.reject_below_max exceeds acceptable_min");
  if (c.stretch_min < c.target_max)
    errors.push("compensation.stretch_min is below target_max");
  if (c.contract_min_hourly > c.contract_max_hourly)
    errors.push("compensation.contract_min_hourly exceeds contract_max_hourly");

  const laneKeys = Object.keys(p.lanes);
  const laneWeightSum = Object.values(p.lanes).reduce((a, l) => a + l.weight, 0);
  if (Math.abs(laneWeightSum - 1) > 0.02)
    errors.push(`lanes weights sum to ${laneWeightSum.toFixed(2)}, expected ~1.00`);

  for (const s of p.signals) {
    if (!laneKeys.includes(s.lane)) errors.push(`signal "${s.term}" references unknown lane "${s.lane}"`);
  }
  for (const combo of p.combos) {
    if (!laneKeys.includes(combo.lane))
      errors.push(`combo "${combo.name}" references unknown lane "${combo.lane}"`);
  }
  for (const key of Object.keys(p.target_titles)) {
    if (!laneKeys.includes(key)) errors.push(`target_titles has unknown lane key "${key}"`);
  }

  const roiSum = Object.values(p.roi.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(roiSum - 1) > 0.05)
    errors.push(`roi.weights sum to ${roiSum.toFixed(2)}, expected ~1.00`);

  if (p.scoring.freshness_full_days >= p.scoring.freshness_zero_days)
    errors.push("scoring.freshness_full_days must be less than freshness_zero_days");

  if (errors.length) {
    throw new Error(`Career profile is internally inconsistent:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
