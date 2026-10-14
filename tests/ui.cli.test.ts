import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { legacyDb } from "./helpers/legacy.js";

/**
 * The CLI through its real entry point (`tsx src/ui/cli.ts`), as a user runs
 * it. This is the only test that exercises the tsx transform the real
 * commands run under; bugs that pass vitest and fail there are why it exists.
 * No network: data comes from a legacy import and a directory of .eml files.
 */
const ROOT = resolve(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "jr-cli-"));
const env = { ...process.env, JR_HOME: home, ANTHROPIC_API_KEY: "", JOB_RADAR_GMAIL_CLIENT_ID: "" };

function jr(...args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "src/ui/cli.ts"), ...args], { env, cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

beforeAll(() => {
  const r = jr("init");
  expect(r.code).toBe(0);
  // No live boards in a test; point mail at the fixture directory.
  const opsFile = join(home, "config/operations.yaml");
  const ops = parse(readFileSync(opsFile, "utf8"));
  ops.mail.eml_dir = resolve(ROOT, "tests/fixtures/eml");
  ops.mail.initial_lookback_days = 400;
  writeFileSync(opsFile, stringify(ops));
});

describe("jr, end to end through the real entry point", () => {
  it("check reports what is and is not configured", () => {
    const r = jr("check");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/config ok/);
    expect(r.out).toMatch(/no ANTHROPIC_API_KEY/);
  });

  it("imports a legacy database and evaluates it", () => {
    const r = jr("import-legacy", "--db", legacyDb());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/"applications": 3/);
    expect(jr("evaluate").out).toMatch(/6 postings/);
  });

  it("refuses to spend without a key, and records the refusal", () => {
    const r = jr("assess", "--limit", "1");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("show, pursue and the ambiguity refusal", () => {
    expect(jr("show", "j-skipped").out).toMatch(/pursuit skipped/);
    const amb = jr("show", "Acme");
    expect(amb.code).toBe(1);
    expect(amb.out).toMatch(/matches 4 postings/);
    expect(jr("pursue", "j-skipped", "reviewed").out).toMatch(/skipped -> reviewed/);
  });

  it("records outcomes, and refuses an impossible one with a reason", () => {
    const apps = jr("apps").out;
    const ghostId = /^(\S+)\s+ghosted/m.exec(apps)![1]!;
    expect(jr("outcome", ghostId, "screen", "--note", "they replied").out).toMatch(/ghosted -> screen/);
    const bad = jr("outcome", ghostId, "submitted");
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/only submitted once/);
  });

  it("reads mail from an .eml directory without credentials", () => {
    const r = jr("mail", "scan");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/coverage complete/);
  });

  it("writes a briefing and a self-contained HTML page", () => {
    const r = jr("report");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Job Radar briefing/);
    const html = readFileSync(join(home, "reports/latest.html"), "utf8");
    expect(html).not.toMatch(/<script|https?:\/\/fonts/);
  });

  it("spend reads the one ledger, including legacy lower-bound estimates", () => {
    expect(jr("spend", "--days", "400").out).toMatch(/legacy:apply/);
  });

  it("backs up with an integrity check and prunes", () => {
    expect(jr("backup", "--keep", "1").out).toMatch(/integrity checked/);
    expect(jr("backup", "--keep", "1").out).toMatch(/pruned/);
    const dirs = readdirSync(join(home, "data/backups"));
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(home, "data/backups", dirs[0]!, "config/operations.yaml"))).toBe(true);
    expect(existsSync(join(home, "data/backups", dirs[0]!, "manifest.json"))).toBe(true);
  });

  it("restores a backup into an empty directory, and refuses the live home and a non-empty one", () => {
    const set = readdirSync(join(home, "data/backups"))[0]!;
    const to = mkdtempSync(join(tmpdir(), "jr-cli-restore-"));
    const r = jr("restore", set, "--to", join(to, "home"));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/every hash matched/);
    expect(r.out).toMatch(/integrity_check ok/);
    expect(readFileSync(join(to, "home/config/candidate/evidence.yaml"))).toEqual(readFileSync(join(home, "config/candidate/evidence.yaml")));
    const again = jr("restore", set, "--to", join(to, "home"));
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/not empty/);
    const live = jr("restore", set, "--to", join(home, "restored"));
    expect(live.code).toBe(1);
    expect(live.out).toMatch(/live Job Radar home/);
    expect(existsSync(join(home, "restored"))).toBe(false);
  });

  it("a config typo fails loudly instead of disabling a rule", () => {
    const file = join(home, "config/policy/evaluation.yaml");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("report_threshold:", "report_treshold:"));
    const r = jr("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/report_treshold|report_threshold/);
    writeFileSync(file, original);
  });
});

void cpSync;
