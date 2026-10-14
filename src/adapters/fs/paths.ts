import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where everything lives. `JR_HOME` relocates the whole tree (tests use it). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Paths {
  home: string;
  config: string;
  db: string;
  reports: string;
  artifacts: string;
  backups: string;
  browserProfile: string;
  evidence: string;
  personal: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.JR_HOME ? resolve(env.JR_HOME) : PACKAGE_ROOT;
  const config = resolve(home, "config");
  return {
    home,
    config,
    db: env.JR_DB ? resolve(env.JR_DB) : resolve(home, "data", "jr.sqlite"),
    reports: resolve(home, "reports"),
    artifacts: resolve(home, "artifacts"),
    backups: resolve(home, "data", "backups"),
    browserProfile: resolve(home, ".browser-profile"),
    evidence: resolve(config, "candidate", "evidence.yaml"),
    personal: resolve(config, "candidate", "personal.yaml"),
  };
}

/** Load `.env`; real environment variables always win over the file. */
export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
