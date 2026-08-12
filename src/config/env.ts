import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./load.js";

/**
 * Load `.env` into process.env.
 *
 * Without this the documented setup ("copy .env.example to .env and add your
 * key") silently does nothing - the code reads process.env, and nothing ever
 * puts the file's contents there.
 *
 * Real environment variables always win over the file, so an explicit
 * `ANTHROPIC_API_KEY=... npm run cli -- analyze` overrides `.env` rather than
 * being silently ignored.
 */
export function loadEnvFile(file = resolve(PROJECT_ROOT, ".env")): void {
  if (!existsSync(file)) return;

  // Node 20.6+ ships a native loader. Prefer it when present.
  const native = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof native === "function") {
    try {
      native.call(process, file);
      return;
    } catch {
      // Fall through to the manual parser on any malformed-file error.
    }
  }

  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if present.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
