import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { startServer, type ServerHandle } from "../src/ui/web/server.js";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { pursuitOf } from "../src/app/pursuit.js";
import { GH_ACME, ghBoard, makeEnv } from "./helpers/context.js";
import { slateCardHtml } from "../src/ui/reports/render.js";

const env = makeEnv({ routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
let server: ServerHandle;
let port = 0;
let id = "";

function call(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
  evaluate(env.ctx, null);
  id = env.store.ranking({ eligible: true })[0]!.opportunityId;
  server = await startServer(env.ctx, { port: 0 });
  port = Number(new URL(server.url).port);
});
afterAll(() => server.close());

describe("local web UI", () => {
  it("binds loopback only and serves a script-free page with a strict CSP", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const r = await call("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Senior Software Engineer");
    expect(r.body).not.toMatch(/<script/i);
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await call("GET", "/", { headers: { host: "evil.example" } })).status).toBe(403);
  });

  it("refuses a write without the CSRF token, or from another origin", async () => {
    const form = `id=${id}&to=shortlisted&csrf=wrong`;
    expect((await call("POST", "/act", { body: form, headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(403);
    const page = (await call("GET", "/")).body;
    const token = /name="csrf" value="([a-f0-9]+)"/.exec(page)![1]!;
    const cross = await call("POST", "/act", { body: `id=${id}&to=shortlisted&csrf=${token}`, headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } });
    expect(cross.status).toBe(403);
    expect(pursuitOf(env.ctx, id).state).toBe("new");
  });

  it("records a pursuit decision through the same use case as the CLI", async () => {
    const token = /name="csrf" value="([a-f0-9]+)"/.exec((await call("GET", "/")).body)![1]!;
    const r = await call("POST", "/act", { body: `id=${id}&to=shortlisted&csrf=${token}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(303);
    expect(pursuitOf(env.ctx, id).state).toBe("shortlisted");
    expect(env.store.recentRuns("2000-01-01T00:00:00Z").some((x) => x.command === "web:pursue" && x.outcome === "ok")).toBe(true);
  });

  it("cannot record a submission or anything but a pursuit state", async () => {
    const token = /name="csrf" value="([a-f0-9]+)"/.exec((await call("GET", "/")).body)![1]!;
    const r = await call("POST", "/act", { body: `id=${id}&to=submitted&csrf=${token}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.status).toBe(400);
  });
});

describe("rendered links", () => {
  it("never links a non-http(s) URL, even one stored before URLs were filtered", () => {
    const row = env.store.ranking({ eligible: true })[0]!;
    const evil = { ...row, detail: { ...row.detail, applicationUrl: "javascript:alert(1)", url: "javascript:alert(2)" } };
    const html = slateCardHtml(evil, env.clock.now().toISOString());
    expect(html).not.toMatch(/href="\s*javascript:/i);
    expect(html).not.toMatch(/javascript:/i);
  });
});
