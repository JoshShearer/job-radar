import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import {
  coherenceProblems,
  EvaluationPolicySchema,
  OperationsSchema,
  PreferencesSchema,
  SourcesSchema,
  StrategySchema,
  type Config,
} from "../../domain/config/schema.js";
import { EvidenceSchema, type Evidence } from "../../domain/candidate/evidence.js";
import { PersonalSchema, type Personal } from "../../domain/candidate/personal.js";

export const CONFIG_FILES = {
  strategy: "search/strategy.yaml",
  preferences: "candidate/preferences.yaml",
  policy: "policy/evaluation.yaml",
  operations: "operations.yaml",
  sources: "sources.yaml",
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

function readYaml(file: string, text?: string): unknown {
  if (text === undefined && !existsSync(file)) throw new ConfigError(`Missing ${file}. Run \`jr init\` or copy the examples from config.example/.`);
  try {
    return parseYaml(text ?? readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid YAML: ${(err as Error).message}`);
  }
}

function parseWith<S extends z.ZodType>(schema: S, raw: unknown, file: string): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${file} failed validation:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Load and validate every config file, then cross-check them. Fails loudly.
 * `pending` substitutes the text of a file about to be written, so a writer
 * can validate the exact result before it touches the disk.
 */
export function loadConfig(configDir: string, pending: Partial<Record<keyof typeof CONFIG_FILES, string>> = {}): Config {
  const load = <S extends z.ZodType>(key: keyof typeof CONFIG_FILES, schema: S) => {
    const file = resolve(configDir, CONFIG_FILES[key]);
    return parseWith(schema, readYaml(file, pending[key]), file);
  };
  const config: Config = {
    strategy: load("strategy", StrategySchema),
    preferences: load("preferences", PreferencesSchema),
    policy: load("policy", EvaluationPolicySchema),
    operations: load("operations", OperationsSchema),
    sources: load("sources", SourcesSchema),
  };
  const problems = coherenceProblems(config);
  if (problems.length) throw new ConfigError(`Configuration is inconsistent:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return config;
}

const EVIDENCE_KEYS = new Set(["basics", "skills", "experience", "projects", "education", "certifications"]);

export function loadEvidence(file: string): Evidence {
  const raw = readYaml(file);
  if (raw && typeof raw === "object") {
    const unknown = Object.keys(raw as object).filter((k) => !EVIDENCE_KEYS.has(k));
    if (unknown.length) {
      throw new ConfigError(`${file}: unknown top-level key(s) ${unknown.join(", ")}. Personal details belong in candidate/personal.yaml.`);
    }
  }
  return parseWith(EvidenceSchema, raw, file);
}

export function evidenceExists(file: string): boolean {
  return existsSync(file);
}

export function loadPersonal(file: string): Personal {
  if (!existsSync(file)) {
    throw new ConfigError(`No personal details at ${file}. Copy config.example/candidate/personal.yaml there and fill it in; it stays on this machine.`);
  }
  return parseWith(PersonalSchema, readYaml(file), file);
}

export function tryLoadPersonal(file: string): Personal | null {
  try {
    return loadPersonal(file);
  } catch {
    return null;
  }
}
