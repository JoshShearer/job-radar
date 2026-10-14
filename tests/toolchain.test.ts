import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import Database from "better-sqlite3";

/**
 * pnpm's build policy (pnpm-workspace.yaml `allowBuilds`), pinned. JOB-69.
 *
 * Allowing better-sqlite3's build makes pnpm run its implicit `node-gyp rebuild`. pnpm does not
 * bundle node-gyp, so on a machine without a global one the install aborts before linking
 * node_modules/.bin, and `tsc` / `vitest` go missing. better-sqlite3 ships prebuilt bindings for
 * linux/darwin/win32 on x64/arm64 and loads them in preference to a source build, so the build is
 * allowed only where no prebuild exists for the platform. esbuild's postinstall always has to run.
 */
const REPO = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const SQLITE_DIR = dirname(require.resolve("better-sqlite3/package.json"));
const binding = require(join(SQLITE_DIR, "lib", "binding.js")) as { getPrebuildPath(): string | null };

describe("pnpm build policy", () => {
  const allowBuilds = (parse(readFileSync(resolve(REPO, "pnpm-workspace.yaml"), "utf8")) as {
    allowBuilds?: Record<string, boolean>;
  }).allowBuilds;

  it("lets esbuild's postinstall run", () => {
    expect(allowBuilds?.esbuild).toBe(true);
  });

  it("builds better-sqlite3 from source only on a platform with no prebuild", () => {
    const hasPrebuild = binding.getPrebuildPath() !== null;
    expect(
      allowBuilds?.["better-sqlite3"],
      hasPrebuild
        ? "a prebuild exists here: a source build only adds a node-gyp dependency (see CLAUDE.md Toolchain)"
        : `no better-sqlite3 prebuild for ${process.platform}-${process.arch}: allow the build and install node-gyp (see CLAUDE.md Toolchain)`,
    ).toBe(!hasPrebuild);
  });

  it("loads better-sqlite3 from its prebuild where one exists", () => {
    const db = new Database(":memory:");
    expect(db.prepare("select 1 + 1 as two").get()).toEqual({ two: 2 });
    db.close();
    const prebuild = binding.getPrebuildPath();
    if (prebuild !== null) expect(Object.keys(require.cache)).toContain(prebuild);
  });
});
