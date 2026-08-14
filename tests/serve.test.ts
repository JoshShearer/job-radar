import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReportServer } from "../src/report/serve.js";

let dir: string;
let port: number;
let boundAddress: string;
let close: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "job-radar-serve-"));
  writeFileSync(join(dir, "latest.html"), "<h1>Dashboard</h1>", "utf8");
  writeFileSync(join(dir, "latest-briefing.html"), "<h1>Latest briefing</h1>", "utf8");
  writeFileSync(join(dir, "2026-08-12.html"), "<h1>Aug 12</h1>", "utf8");
  writeFileSync(join(dir, "2026-08-12.md"), "# Aug 12", "utf8");
  const started = await startReportServer({ dir, port: 45871 });
  port = started.port;
  boundAddress = started.address;
  close = started.close;
});

afterAll(() => {
  close?.();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);

describe("report server", () => {
  it("serves an index listing past briefings", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Job Radar");
    expect(body).toContain("2026-08-12");
    expect(body).toContain("latest.html");
    expect(body).toContain("latest-briefing.html");
  });

  it("keeps the rolling files out of the dated archive list", async () => {
    const body = await (await get("/")).text();
    // Both rolling files are linked in the header, and neither belongs in the
    // list below it - "latest-briefing" is not a date, and it would sort in
    // among them as though it were one. Nothing failed when this was wrong,
    // which is why it has a test of its own.
    const list = body.slice(body.indexOf("<ul>"));
    expect(list).toContain("2026-08-12");
    expect(list).not.toContain("latest-briefing");
    expect(list).not.toContain("latest.html");
  });

  it("only offers a rolling file that exists", async () => {
    // Header links are existence-gated, so a directory with no dashboard shows
    // no dashboard link rather than a 404 dressed as navigation.
    const empty = mkdtempSync(join(tmpdir(), "job-radar-serve-empty-"));
    const started = await startReportServer({ dir: empty, port: 45899 });
    try {
      const body = await (await fetch(`http://127.0.0.1:${started.port}/`)).text();
      expect(body).not.toContain('href="/latest.html"');
      expect(body).not.toContain('href="/latest-briefing.html"');
      expect(body).toContain("No briefings yet");
    } finally {
      started.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("serves the dashboard at the landing path", async () => {
    const res = await get("/latest.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Dashboard");
  });

  it("serves a briefing", async () => {
    const res = await get("/2026-08-12.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Aug 12");
  });

  it("serves markdown as plain text", async () => {
    const res = await get("/2026-08-12.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("404s an unknown file", async () => {
    expect((await get("/nope.html")).status).toBe(404);
  });

  it("refuses file types it does not serve", async () => {
    // The SQLite database must never be reachable, whatever the path.
    expect((await get("/job-radar.sqlite")).status).toBe(404);
  });

  it("blocks path traversal out of the reports directory", async () => {
    for (const attack of [
      "/../../../../etc/passwd",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
    ]) {
      const res = await get(attack);
      expect([403, 404], `${attack} must not succeed`).toContain(res.status);
    }
  });

  it("rejects write methods", async () => {
    const res = await get("/latest.html", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("does not cache, so a regenerated briefing shows on refresh", async () => {
    const res = await get("/latest.html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("binds to loopback only", async () => {
    // Asserting on the bound address, not on a failed connection to 0.0.0.0:
    // on Linux a local connection to 0.0.0.0 is routed to 127.0.0.1 and
    // succeeds regardless of what the socket bound to, so that check would
    // pass a server listening on every interface.
    expect(boundAddress).toBe("127.0.0.1");
  });
});
