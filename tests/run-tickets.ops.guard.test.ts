import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPS, REPO, ops, rec, setup, ticket, type Ctx } from "./helpers/runTicketsOps.js";

/** /run-tickets ticket-ops: see tests/helpers/runTicketsOps.ts for the harness and why it is a subprocess. */
let c: Ctx;
beforeEach(() => {
  c = setup();
});
afterEach(() => {
  rmSync(c.root, { recursive: true, force: true });
});

describe("guard", () => {
  const write = (name: string, text: string) => writeFileSync(resolve(c.lane, name), text);

  it("generates the lane .env from the allowlist only", () => {
    writeFileSync(
      resolve(c.primary, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-live\nJOB_RADAR_DB=/home/x/real.sqlite\nJOB_RADAR_CONTACT=me@example.com\n# JOB_RADAR_MODEL=x\n",
    );
    expect(ops(c, ["guard", "--init"]).code).toBe(0);
    expect(readFileSync(resolve(c.lane, ".env"), "utf8")).toBe("JOB_RADAR_CONTACT=me@example.com\n");
  });

  it("does not leave a refused .env on disk", () => {
    writeFileSync(resolve(c.primary, ".env"), `JOB_RADAR_CONTACT=sk-ant-${"b".repeat(20)}\n`);
    expect(ops(c, ["guard", "--init"]).code).toBe(0);
    expect(existsSync(resolve(c.lane, ".env"))).toBe(false);
  });

  it("refuses an unknown key in the lane .env", () => {
    write(".env", "OTHER=1\n");
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses an Anthropic key VALUE under an allowed name", () => {
    write(".env", "JOB_RADAR_CONTACT=sk-ant-hidden\n");
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses the primary's path under an allowed name", () => {
    write(".env", `JOB_RADAR_CONTACT=${c.primary}/x\n`);
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses a symlinked .env even when its target is clean", () => {
    writeFileSync(resolve(c.root, "clean.env"), "JOB_RADAR_CONTACT=x\n");
    rmSync(resolve(c.lane, ".env"));
    symlinkSync(resolve(c.root, "clean.env"), resolve(c.lane, ".env"));
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses an exported key or path override", () => {
    expect(ops(c, ["guard"], undefined, { ANTHROPIC_API_KEY: "x" }).code).toBe(2);
    expect(ops(c, ["guard"], undefined, { JOB_RADAR_DB: "/x" }).code).toBe(2);
    expect(ops(c, ["guard"]).code).toBe(0);
  });

  it("refuses the owner's personal files in the lane", () => {
    mkdirSync(resolve(c.lane, "config"), { recursive: true });
    write("config/personal.yaml", "x");
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses a change to the owner's units, including drop-ins and timer links, and never retakes the snapshot", () => {
    const units = resolve(c.root, "config", "systemd", "user");
    mkdirSync(resolve(units, "job-radar-daily.service.d"), { recursive: true });
    writeFileSync(resolve(units, "job-radar-daily.service.d", "override.conf"), "WorkingDirectory=/lane\n");
    expect(ops(c, ["guard"]).code).toBe(2);
    expect(ops(c, ["guard", "--init"]).code).toBe(2); // --init does not adopt the change
    rmSync(resolve(units, "job-radar-daily.service.d"), { recursive: true });
    expect(ops(c, ["guard"]).code).toBe(0);
    mkdirSync(resolve(units, "timers.target.wants"), { recursive: true });
    symlinkSync("/lane/job-radar-daily.timer", resolve(units, "timers.target.wants", "job-radar-daily.timer"));
    expect(ops(c, ["guard"]).code).toBe(2);
  });

  it("refuses a server left listening from the lane", async () => {
    const server: ChildProcess = spawn("node", ["-e", "require('http').createServer().listen(0, '127.0.0.1', () => console.log('up'))"], {
      cwd: c.lane,
    });
    await new Promise((r) => server.stdout!.once("data", r));
    try {
      expect(ops(c, ["guard"]).code).toBe(2);
    } finally {
      server.kill();
    }
  });

  it("runs inside the steps too: an unsafe lane stops record", () => {
    ops(c, ["add", "JOB-1"]);
    write(".env", "OTHER=1\n");
    expect(rec(c, "triage", { clarificationAdd: [{ question: "q", answer: "a" }] }).code).toBe(2);
  });
});

describe("gate files", () => {
  it("cover the config closure of npm test and npm run typecheck, and name only files that exist", () => {
    const files: string[] = JSON.parse(execFileSync("node", [OPS, "gate-files"], { encoding: "utf8" })).files;
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8"));
    expect(pkg.scripts.test).toMatch(/^vitest run/);
    expect(pkg.scripts.typecheck).toMatch(/^tsc /);
    const closure = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts"]);
    const localImports = (f: string) =>
      [...readFileSync(resolve(REPO, f), "utf8").matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) =>
        resolve(REPO, f, "..", m[1]!).slice(REPO.length + 1).replace(/\.js$/, ".ts"),
      );
    // Everything the test config imports, transitively.
    const queue = ["vitest.config.ts"];
    while (queue.length) {
      const f = queue.shift()!;
      closure.add(f);
      for (const next of localImports(f)) if (!closure.has(next)) queue.push(next);
    }
    // The env loader decides which .env loads; where it resolves that path from is gate too,
    // and so is the composition root that calls it.
    closure.add("src/adapters/fs/paths.ts");
    for (const f of localImports("src/adapters/fs/paths.ts")) closure.add(f);
    closure.add("src/ui/compose.ts");
    const tsconfig = readFileSync(resolve(REPO, "tsconfig.json"), "utf8");
    expect(tsconfig).not.toMatch(/"extends"/); // a base config would join the closure
    for (const f of closure) expect(files).toContain(f);
    for (const f of files) if (f !== ".npmrc") expect(existsSync(resolve(REPO, f)), f).toBe(true);
  });
});
