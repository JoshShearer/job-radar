import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Structural rules, enforced rather than documented:
 *
 *   domain   imports only domain, kernel, zod, node:crypto
 *   kernel   imports only kernel and node:crypto
 *   ports    imports only ports, domain, kernel
 *   app      imports only app, ports, domain, kernel, zod
 *   adapters never imports app or ui
 *
 * and nothing in domain or app reads the wall clock.
 */
const SRC = resolve(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function layer(file: string): string {
  return relative(SRC, file).split("/")[0]!;
}

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]!);
}

function target(file: string, spec: string): string {
  if (!spec.startsWith(".")) return `pkg:${spec}`;
  return layer(resolve(file, "..", spec));
}

const ALLOWED: Record<string, (t: string) => boolean> = {
  kernel: (t) => t === "kernel" || t === "pkg:node:crypto",
  domain: (t) => ["domain", "kernel", "pkg:zod", "pkg:node:crypto"].includes(t),
  ports: (t) => ["ports", "domain", "kernel"].includes(t),
  app: (t) => ["app", "ports", "domain", "kernel", "pkg:zod"].includes(t),
  adapters: (t) => t !== "app" && t !== "ui",
  ui: () => true,
};

describe("architecture", () => {
  const all = files(SRC);
  it.each(all.map((f) => [relative(SRC, f), f]))("%s respects the dependency direction", (_rel, file) => {
    const rule = ALLOWED[layer(file)]!;
    const bad = imports(file).filter((spec) => !rule(target(file, spec)));
    expect(bad).toEqual([]);
  });

  it("domain and app never read the wall clock (time is injected)", () => {
    const offenders = all
      .filter((f) => ["domain", "app"].includes(layer(f)))
      .filter((f) => /Date\.now\(\)|new Date\(\)/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no candidate facts are hardcoded in prompts", () => {
    const prompts = readFileSync(join(SRC, "domain/llm/prompts.ts"), "utf8");
    expect(prompts).not.toMatch(/\$\d{3}k|ShroomSpy|LoopString|years of experience\./);
  });
});
