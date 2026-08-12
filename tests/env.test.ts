import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/config/env.js";

const KEYS = ["JR_TEST_A", "JR_TEST_B", "JR_TEST_QUOTED", "JR_TEST_PRESET", "JR_TEST_EQUALS"];
const dirs: string[] = [];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "job-radar-env-"));
  dirs.push(dir);
  const file = join(dir, ".env");
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("loadEnvFile", () => {
  it("loads simple key=value pairs", () => {
    loadEnvFile(envFile("JR_TEST_A=hello\nJR_TEST_B=world\n"));
    expect(process.env.JR_TEST_A).toBe("hello");
    expect(process.env.JR_TEST_B).toBe("world");
  });

  it("ignores comments and blank lines", () => {
    loadEnvFile(envFile("# a comment\n\n   \nJR_TEST_A=ok\n"));
    expect(process.env.JR_TEST_A).toBe("ok");
  });

  it("strips surrounding quotes", () => {
    loadEnvFile(envFile('JR_TEST_QUOTED="quoted value"\n'));
    expect(process.env.JR_TEST_QUOTED).toBe("quoted value");
  });

  it("keeps '=' characters inside the value", () => {
    // API keys and base64 values routinely contain '='.
    loadEnvFile(envFile("JR_TEST_EQUALS=abc=def==\n"));
    expect(process.env.JR_TEST_EQUALS).toBe("abc=def==");
  });

  it("does not override an already-set real environment variable", () => {
    process.env.JR_TEST_PRESET = "from-shell";
    loadEnvFile(envFile("JR_TEST_PRESET=from-file\n"));
    expect(process.env.JR_TEST_PRESET).toBe("from-shell");
  });

  it("is a no-op when the file does not exist", () => {
    expect(() => loadEnvFile(join(tmpdir(), "definitely-not-here-job-radar", ".env"))).not.toThrow();
  });
});
