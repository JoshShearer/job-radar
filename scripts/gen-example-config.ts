/**
 * Regenerate config.example/ from a previous Job Radar's config, through the
 * same converter `jr import-legacy --old-root` uses.
 *   npm run gen:examples -- <old-root>   (a checkout of the previous tool, e.g. `git worktree add ../jr-v1 v1-final`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";
import { convertLegacyConfig } from "../src/adapters/legacy/config.js";
import { CONFIG_FILES } from "../src/adapters/fs/config-loader.js";

if (!process.argv[2]) {
  console.error("usage: npm run gen:examples -- <old-root>");
  process.exit(1);
}
const oldRoot = resolve(process.argv[2]);
const out = resolve(import.meta.dirname, "..", "config.example");
const c = convertLegacyConfig(resolve(oldRoot, "config/career-profile.yaml"), resolve(oldRoot, "config/sources.yaml"));
for (const [key, rel] of Object.entries(CONFIG_FILES)) {
  const file = resolve(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(c[key as keyof typeof c], { lineWidth: 0 }));
  console.log(`wrote ${file}`);
}
