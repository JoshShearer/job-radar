import { beforeEach, describe, expect, it } from "vitest";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { discover } from "../src/app/discover.js";
import { discoverCompany } from "../src/adapters/ats/discover.js";
import { FsSourcesWriter } from "../src/adapters/fs/sources-writer.js";
import { loadConfig } from "../src/adapters/fs/config-loader.js";
import { buildAdapters } from "../src/adapters/ats/registry.js";
import { EXAMPLE_CONFIG, makeEnv, type Routes, type TestEnv } from "./helpers/context.js";

/**
 * `jr discover --add` through its use case, with the real discovery adapter
 * over a fake transport and the real file writer over a scratch config
 * directory. The fixture sources.yaml carries comments, blank lines, trailing
 * comments and both entry styles; every test diffs it before and after.
 */
const FIXTURE = resolve(import.meta.dirname, "fixtures/sources-commented.yaml");

const board = (n: number) => ({ jobs: Array.from({ length: n }, (_, i) => ({ id: i })) });
const GH = (t: string) => `boards-api.greenhouse.io/v1/boards/${t}/jobs`;
const LEVER = (t: string) => `api.lever.co/v0/postings/${t}?`;
const ASHBY = (t: string) => `api.ashbyhq.com/posting-api/job-board/${t}`;

let dir: string;
let file: string;

function scratchConfig(sources = FIXTURE): string {
  const d = mkdtempSync(join(tmpdir(), "jr-discover-"));
  cpSync(EXAMPLE_CONFIG, d, { recursive: true });
  copyFileSync(sources, join(d, "sources.yaml"));
  return d;
}

function envFor(routes: Routes): TestEnv {
  return makeEnv({ routes, config: loadConfig(dir) });
}

async function run(env: TestEnv, companies: string[], add: boolean) {
  return discover(env.ctx, companies, {
    probe: (c) => discoverCompany(c, env.ctx.transport()),
    writer: add ? new FsSourcesWriter(dir) : null,
  });
}

/** The lines of `after` that are not in `before`, asserting nothing else changed. */
function insertedLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const inserted: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else inserted.push(line);
  }
  expect(i, "every original line survives, in order").toBe(a.length);
  return inserted;
}

beforeEach(() => {
  dir = scratchConfig();
  file = join(dir, "sources.yaml");
});

describe("discover --add", () => {
  it("adds a new board under its ATS group and changes nothing else", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("clickhouse")]: board(3) });
    const r = await run(env, ["ClickHouse"], true);
    expect(r.outcome).toBe("ok");
    expect(r.notes.join("\n")).toMatch(/ADDED ClickHouse: greenhouse:clickhouse \(3 jobs\)/);
    const after = readFileSync(file, "utf8");
    expect(insertedLines(before, after)).toEqual(["      - { token: clickhouse, company: ClickHouse }"]);
    // The written file loads through the full loader, and a sweep would pick the board up.
    const boards = buildAdapters(loadConfig(dir).sources).flatMap((a) => a.boards().map((b) => b.boardId));
    expect(boards).toContain("greenhouse:clickhouse");
  });

  it("quotes a company name that needs it", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("acme")]: board(1) });
    const r = await run(env, ["Acme: The Company"], true);
    expect(r.outcome).toBe("ok");
    expect(insertedLines(before, readFileSync(file, "utf8"))).toHaveLength(1);
    expect(parse(readFileSync(file, "utf8")).sources.greenhouse.boards.at(-1)).toEqual({ token: "acme", company: "Acme: The Company" });
  });

  it("matches a block-style list's style", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [ASHBY("llamaindex")]: board(1) });
    const r = await run(env, ["LlamaIndex"], true);
    expect(r.outcome).toBe("ok");
    expect(insertedLines(before, readFileSync(file, "utf8"))).toEqual(["      - token: llamaindex", "        company: LlamaIndex"]);
  });

  it("re-running for the same company is a no-op that says HAVE", async () => {
    const env = envFor({ [GH("clickhouse")]: board(3) });
    await run(env, ["ClickHouse"], true);
    const once = readFileSync(file, "utf8");
    const again = envFor({ [GH("clickhouse")]: board(3) });
    const r = await run(again, ["ClickHouse"], true);
    expect(r.outcome).toBe("ok");
    expect(r.notes.join("\n")).toMatch(/HAVE  ClickHouse: greenhouse:clickhouse/);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  it("treats a configured token as HAVE regardless of case", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("grafanalabs")]: board(2) });
    const r = await run(env, ["Grafana Labs"], true);
    expect(r.notes.join("\n")).toMatch(/HAVE  Grafana Labs: greenhouse:grafanalabs/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("adds a token found twice in one invocation once", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("clickhouse")]: board(3) });
    const r = await run(env, ["ClickHouse", "clickhouse"], true);
    expect(insertedLines(before, readFileSync(file, "utf8"))).toHaveLength(1);
    expect(r.notes.join("\n")).toMatch(/HAVE  clickhouse/);
  });

  it("reports a company with no public board for the watchlist and writes nothing", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({});
    const r = await run(env, ["Ahrefs"], true);
    expect(r.outcome).toBe("ok");
    expect(r.notes.join("\n")).toMatch(/--    Ahrefs: no public board .*add it to the watchlist by hand/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(parse(before).watchlist).toEqual(parse(readFileSync(file, "utf8")).watchlist);
  });

  it("says when the board landed in a disabled provider block", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [LEVER("porter")]: [{ id: "x" }] });
    const r = await run(env, ["Porter"], true);
    expect(r.notes.join("\n")).toMatch(/ADDED Porter: lever:porter/);
    expect(r.notes.join("\n")).toMatch(/sources\.lever\.enabled is false/);
    expect(insertedLines(before, readFileSync(file, "utf8"))).toEqual(["      - token: porter", "        company: Porter"]);
  });

  it("writes nothing when the result would fail the full config loader", async () => {
    const env = envFor({ [GH("clickhouse")]: board(3) });
    // Break cross-file coherence after the context loaded: lane weights no longer sum to 1.
    const strategyFile = join(dir, "search/strategy.yaml");
    const strategy = parse(readFileSync(strategyFile, "utf8"));
    for (const lane of Object.values(strategy.lanes) as Array<{ weight: number }>) lane.weight = 0.9;
    writeFileSync(strategyFile, stringify(strategy));
    const before = readFileSync(file, "utf8");
    const r = await run(env, ["ClickHouse"], true);
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/Nothing was written/);
    expect(r.notes.join("\n")).toMatch(/weights sum/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses, writing nothing, when the target list has no entry to add after", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "jr-src-")), "sources.yaml");
    writeFileSync(empty, readFileSync(FIXTURE, "utf8").replace(/ashby:\n {4}enabled: true\n {4}boards:\n(?: {6}.*\n)+/, "ashby:\n    enabled: true\n    boards: []  # none yet\n"));
    dir = scratchConfig(empty);
    file = join(dir, "sources.yaml");
    const before = readFileSync(file, "utf8");
    expect(before).toMatch(/boards: \[\]  # none yet/);
    const r = await run(envFor({ [ASHBY("llamaindex")]: board(1) }), ["LlamaIndex"], true);
    expect(r.outcome).toBe("failed");
    expect(r.notes.join("\n")).toMatch(/Nothing was written.*add ashby:llamaindex by hand/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("without --add prints the line and writes nothing, and still says HAVE", async () => {
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("clickhouse")]: board(3), [GH("contentful")]: board(1) });
    const r = await run(env, ["ClickHouse", "Contentful"], false);
    const text = r.notes.join("\n");
    expect(text).toMatch(/FOUND ClickHouse: greenhouse:clickhouse \(3 jobs\)\n {6}- \{ token: clickhouse, company: ClickHouse \}/);
    expect(text).toMatch(/HAVE  Contentful: greenhouse:contentful/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps the shipped example's block style intact", async () => {
    dir = scratchConfig(join(EXAMPLE_CONFIG, "sources.yaml"));
    file = join(dir, "sources.yaml");
    const before = readFileSync(file, "utf8");
    const env = envFor({ [GH("quartzanalytics")]: board(1) });
    const r = await run(env, ["Quartz Analytics"], true);
    expect(r.outcome).toBe("ok");
    expect(insertedLines(before, readFileSync(file, "utf8"))).toEqual(["      - token: quartzanalytics", "        company: Quartz Analytics"]);
  });
});
