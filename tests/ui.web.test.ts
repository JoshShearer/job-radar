import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { startServer, safeBack, occurredAt, type ServerHandle } from "../src/ui/web/server.js";
import { admit, hostnameOf, sameOrigin } from "../src/ui/web/access.js";
import { localDay, markdown } from "../src/ui/web/html.js";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { applicationFold, pursuitOf } from "../src/app/pursuit.js";
import { GH_ACME, ghBoard, makeEnv, testConfig, type TestEnv } from "./helpers/context.js";
import { slateCardHtml } from "../src/ui/reports/render.js";
import { OperationsSchema } from "../src/domain/config/schema.js";

const TAILNET = "box.tail1234.ts.net";
const LOGIN = "me@example.com";
const HOSTILE = `Engineer <img src=x onerror=alert(1)> "quoted" & co`;

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function client(getPort: () => number) {
  return function call(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const port = getPort();
    return new Promise((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      });
      req.on("error", fail);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const tokenOf = (html: string) => /name="csrf" value="([a-f0-9]+)"/.exec(html)![1]!;
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/* ------------------------------------------------------------- the server */

describe("web UI on loopback", () => {
  let env: TestEnv;
  let server: ServerHandle;
  let id = "";
  let hostileId = "";
  let token = "";
  const call = client(() => server.port);

  beforeAll(async () => {
    env = makeEnv({
      routes: {
        [GH_ACME]: ghBoard([
          { id: 1, title: "Senior Software Engineer" },
          { id: 2, title: HOSTILE },
          { id: 3, title: "Staff Frontend Engineer" },
        ]),
      },
    });
    await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
    evaluate(env.ctx, null);
    const rows = env.store.ranking({ eligible: true });
    id = rows.find((r) => r.title === "Senior Software Engineer")!.opportunityId;
    hostileId = env.store.ranking({}).find((r) => r.title.includes("onerror"))?.opportunityId ?? "";
    server = await startServer(env.ctx, { port: 0 });
    token = tokenOf((await call("GET", "/")).body);
  });
  afterAll(() => server.close());

  it("binds 127.0.0.1 only", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("serves every page with no script, no inline style, and a strict CSP", async () => {
    for (const path of ["/", "/ranked", "/ranked?p=A&p=B&pursuit=all&posting=all&q=engineer", "/apps", "/system", `/o/${id}`, `/o/${id}/submit`]) {
      const r = await call("GET", path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).not.toMatch(/<script/i);
      expect(r.body, path).not.toMatch(/<[^>]*\sstyle=/i);
      expect(r.body, path).not.toMatch(/<style/i);
      expect(r.body, path).not.toMatch(/<[^>]*\son[a-z]+=/i);
      const csp = String(r.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("shows the slate and today's counts", async () => {
    const r = await call("GET", "/");
    expect(r.body).toContain("Senior Software Engineer");
    expect(r.body).toMatch(/new postings? clears? the bar today/);
    expect(r.body).toContain('aria-current="page"');
  });

  it("escapes posting text from job boards everywhere it appears", async () => {
    expect(hostileId).not.toBe("");
    for (const path of ["/", "/ranked?pursuit=all&posting=all&ineligible=1&evergreen=1", `/o/${hostileId}`]) {
      const body = (await call("GET", path)).body;
      expect(body, path).not.toContain("<img src=x");
      if (body.includes("onerror")) expect(body, path).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });

  it("serves the stylesheet and fonts from fixed names, cached; nothing else", async () => {
    const page = (await call("GET", "/")).body;
    const css = /href="(\/assets\/app\.css\?v=[a-f0-9]{10})"/.exec(page)![1]!;
    const r = await call("GET", css);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/css");
    expect(r.headers["cache-control"]).toContain("immutable");
    expect(r.body).toContain("--carbon");
    const font = await call("GET", "/assets/archivo-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    const iconUrl = /<link rel="icon" href="(\/assets\/icon\.svg\?v=[a-f0-9]{10})" type="image\/svg\+xml">/.exec(page)![1]!;
    const icon = await call("GET", iconUrl);
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
    expect(icon.headers["cache-control"]).toContain("immutable");
    expect(icon.body).toContain("<svg");
    for (const bad of ["/assets/nope.css", "/assets/../server.ts", "/assets/%2e%2e%2fserver.ts", "/assets/server.ts"]) {
      expect((await call("GET", bad)).status, bad).toBe(404);
    }
  });

  it("answers an unknown page or posting with 404, and other methods with 405", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("GET", "/o/doesnotexist")).status).toBe(404);
    expect((await call("GET", `/o/${id}/g/nogeneration`)).status).toBe(404);
    expect((await call("PUT", "/")).status).toBe(405);
    expect((await call("DELETE", "/act/pursue")).status).toBe(405);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await call("GET", "/", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await call("GET", "/", { headers: { host: `${TAILNET}` } })).status).toBe(403);
  });

  it("refuses proxied requests when no tailnet host is configured", async () => {
    const r = await call("GET", "/", { headers: { host: TAILNET, "x-forwarded-for": "100.1.2.3", "tailscale-user-login": LOGIN } });
    expect(r.status).toBe(403);
    // A proxy that rewrites Host to loopback still has to present an allowed host and login.
    const rewritten = await call("GET", "/", { headers: { "x-forwarded-for": "100.1.2.3" } });
    expect(rewritten.status).toBe(403);
  });

  it("refuses a write without the CSRF token, from another origin, or cross-site", async () => {
    const body = form({ id, to: "shortlisted", csrf: "wrong" });
    expect((await call("POST", "/act/pursue", { body, headers: FORM })).status).toBe(403);
    const good = form({ id, to: "shortlisted", csrf: token });
    expect((await call("POST", "/act/pursue", { body: good, headers: { ...FORM, origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("POST", "/act/pursue", { body: good, headers: { ...FORM, origin: `http://127.0.0.1:${server.port + 1}` } })).status).toBe(403);
    expect((await call("POST", "/act/pursue", { body: good, headers: { ...FORM, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(pursuitOf(env.ctx, id).state).toBe("new");
  });

  it("refuses a body that is not a urlencoded form, or too large", async () => {
    expect((await call("POST", "/act/pursue", { body: JSON.stringify({ id, to: "shortlisted", csrf: token }), headers: { "content-type": "application/json" } })).status).toBe(415);
    expect((await call("POST", "/act/pursue", { body: `csrf=${token}&pad=${"x".repeat(20_000)}`, headers: FORM })).status).toBe(413);
    expect(pursuitOf(env.ctx, id).state).toBe("new");
  });

  it("records a pursuit decision through the same use case as the CLI, then says so", async () => {
    const r = await call("POST", "/act/pursue", { body: form({ id, to: "shortlisted", csrf: token, back: "/ranked?p=B" }), headers: { ...FORM, origin: `http://127.0.0.1:${server.port}` } });
    expect(r.status).toBe(303);
    const location = String(r.headers.location);
    expect(location).toMatch(/^\/ranked\?p=B&f=[a-f0-9]{16}$/);
    expect(pursuitOf(env.ctx, id).state).toBe("shortlisted");
    expect(env.store.recentRuns("2000-01-01T00:00:00Z").some((x) => x.command === "web:pursue" && x.outcome === "ok")).toBe(true);
    const shown = await call("GET", location);
    expect(shown.body).toContain("Shortlisted: Acme, Senior Software Engineer.");
    // A flash id is not a message: an invented one shows nothing.
    expect((await call("GET", "/?f=0000000000000000")).body).not.toContain('class="flash');
  });

  it("reports a refused transition instead of pretending", async () => {
    const r = await call("POST", "/act/pursue", { body: form({ id, to: "new", csrf: token }), headers: FORM });
    expect(r.status).toBe(303);
    const shown = await call("GET", String(r.headers.location));
    expect(shown.body).toMatch(/class="flash refused"/);
    expect(pursuitOf(env.ctx, id).state).toBe("shortlisted");
  });

  it("cannot record a submission, or anything but a decision, through the pursuit form", async () => {
    expect((await call("POST", "/act/pursue", { body: form({ id, to: "applied", csrf: token }), headers: FORM })).status).toBe(400);
    expect((await call("POST", "/act/pursue", { body: form({ id, to: "submitted", csrf: token }), headers: FORM })).status).toBe(400);
    expect((await call("POST", "/act/pursue", { body: form({ id: "nope", to: "skipped", csrf: token }), headers: FORM })).status).toBe(400);
    expect((await call("POST", "/act/nothing", { body: form({ csrf: token }), headers: FORM })).status).toBe(404);
  });

  it("never redirects off-site, whatever `back` says", async () => {
    for (const back of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
      const r = await call("POST", "/act/pursue", { body: form({ id, to: "reviewed", csrf: token, back }), headers: FORM });
      expect(String(r.headers.location), back).toMatch(/^\/\?f=[a-f0-9]{16}$/);
    }
  });

  it("records a submission only on an explicit yes, once", async () => {
    const before = env.store.applications(id).length;
    const no = await call("POST", "/act/submit", { body: form({ id, csrf: token }), headers: FORM });
    expect(no.status).toBe(303);
    expect((await call("GET", String(no.headers.location))).body).toContain("Nothing recorded");
    expect(env.store.applications(id).length).toBe(before);

    const future = new Date(env.clock.now().getTime() + 3 * 86_400_000);
    const tooLate = await call("POST", "/act/submit", { body: form({ id, csrf: token, confirm: "yes", on: localDay(future) }), headers: FORM });
    expect((await call("GET", String(tooLate.headers.location))).body).toContain("in the future");
    expect(env.store.applications(id).length).toBe(before);

    const yes = await call("POST", "/act/submit", { body: form({ id, csrf: token, confirm: "yes", note: "applied on their site", back: `/o/${id}` }), headers: FORM });
    expect(yes.status).toBe(303);
    expect(String(yes.headers.location)).toMatch(new RegExp(`^/o/${id}\\?f=`));
    const apps = env.store.applications(id);
    expect(apps).toHaveLength(1);
    expect(apps[0]!.submittedAt).toBe(env.clock.now().toISOString());
    expect(apps[0]!.note).toBe("from the web UI: applied on their site");
    expect(pursuitOf(env.ctx, id).state).toBe("applied");

    const again = await call("POST", "/act/submit", { body: form({ id, csrf: token, confirm: "yes" }), headers: FORM });
    expect((await call("GET", String(again.headers.location))).body).toContain("Already recorded");
    expect(env.store.applications(id)).toHaveLength(1);
    expect((await call("GET", `/o/${id}/submit`)).status).toBe(409);
  });

  it("records what an employer did, on the day it happened", async () => {
    const app = env.store.applications(id)[0]!;
    const yesterday = localDay(new Date(env.clock.now().getTime() - 86_400_000));
    const r = await call("POST", "/act/outcome", { body: form({ app: app.id, to: "screen", on: yesterday, note: "phone call", csrf: token, back: "/apps" }), headers: FORM });
    expect(r.status).toBe(303);
    expect(String(r.headers.location)).toMatch(/^\/apps\?f=/);
    const f1 = applicationFold(env.ctx, app.id);
    expect(f1.state).toBe("screen");
    const event = f1.steps.at(-1)!.event;
    expect(localDay(new Date(event.occurredAt))).toBe(yesterday);
    expect(event.note).toBe("from the web UI: phone call");
    expect((await call("GET", String(r.headers.location))).body).toContain("Recorded screen for Acme, Senior Software Engineer (was submitted).");

    // The fold, not the form, decides: a screen after a screen is refused and nothing is appended.
    const again = await call("POST", "/act/outcome", { body: form({ app: app.id, to: "screen", csrf: token, back: "/apps" }), headers: FORM });
    expect((await call("GET", String(again.headers.location))).body).toMatch(/class="flash refused"/);
    expect(applicationFold(env.ctx, app.id).steps.length).toBe(f1.steps.length);

    const today = await call("POST", "/act/outcome", { body: form({ app: app.id, to: "interview", csrf: token, back: "/apps" }), headers: FORM });
    expect(today.status).toBe(303);
    expect(applicationFold(env.ctx, app.id).state).toBe("interview");
    expect(env.store.recentRuns("2000-01-01T00:00:00Z").some((x) => x.command === "web:outcome" && x.outcome === "ok")).toBe(true);
    const page = (await call("GET", `/o/${id}`)).body;
    expect(page).toContain(`Application <code>${app.id}</code>`);
    expect(page).toContain("Record an outcome");
  });

  it("refuses an outcome that is not one, or for an unknown application", async () => {
    const app = env.store.applications(id)[0]!;
    expect((await call("POST", "/act/outcome", { body: form({ app: app.id, to: "submitted", csrf: token }), headers: FORM })).status).toBe(400);
    expect((await call("POST", "/act/outcome", { body: form({ app: app.id, to: "hired!", csrf: token }), headers: FORM })).status).toBe(400);
    expect((await call("POST", "/act/outcome", { body: form({ app: "nope", to: "screen", csrf: token }), headers: FORM })).status).toBe(400);
    const bad = await call("POST", "/act/outcome", { body: form({ app: app.id, to: "interview", on: "2026-02-31", csrf: token }), headers: FORM });
    expect((await call("GET", String(bad.headers.location))).body).toContain("is not a date");
  });

  it("lists applications with their state", async () => {
    const r = await call("GET", "/apps");
    expect(r.body).toContain("Still open");
    expect(r.body).toContain("Senior Software Engineer");
    expect(r.body).toContain('class="state state-interview"');
  });

  it("filters and pages the ranking", async () => {
    const all = await call("GET", "/ranked?pursuit=all&posting=all");
    expect(all.body).toContain("Staff Frontend Engineer");
    const q = await call("GET", "/ranked?pursuit=all&posting=all&q=frontend");
    expect(q.body).toContain("Staff Frontend Engineer");
    expect(q.body).not.toContain("Senior Software Engineer");
    const none = await call("GET", "/ranked?q=no-such-company-anywhere");
    expect(none.body).toContain("No postings match these filters");
    expect((await call("GET", "/ranked?page=-4&p=Z&pursuit=bogus&posting=bogus")).status).toBe(200);
    expect((await call("GET", "/ranked?page=99")).body).toContain("No postings match");
  });

  it("shows system health, spend and runs", async () => {
    const r = await call("GET", "/system");
    expect(r.body).toContain("Model spend");
    expect(r.body).toContain("web:pursue");
  });
});

/* ----------------------------------------------------- generations (packs) */

describe("web UI: reading and approving a pack", () => {
  let env: TestEnv;
  let server: ServerHandle;
  let id = "";
  let dir = "";
  let token = "";
  const call = client(() => server.port);

  beforeAll(async () => {
    env = makeEnv({ routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
    await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
    evaluate(env.ctx, null);
    id = env.store.ranking({ eligible: true })[0]!.opportunityId;
    const files = {
      "pack-review.md": "# Application pack - Acme\n\n> Nothing here has been sent.\n\n## Do NOT claim\n\n- Kubernetes at scale <script>alert(1)</script>\n- **leadership** of a `team`\n\n| Claim | Status |\n|---|---|\n| one | verified |\n",
      "Cover_Letter.md": "Dear Acme,\n\nI build things.\n",
      "Cover_Letter.html": "<!doctype html><p>Dear Acme</p><script>alert(1)</script>",
      "Cover_Letter.pdf": "%PDF-1.4 fake",
      "pack.json": "{}",
    };
    const published = env.ctx.artifacts.publish(id, "pack-abc123", files);
    dir = published.dir;
    env.store.recordArtifact(
      {
        id: "abc123",
        opportunityId: id,
        kind: "pack",
        planKey: "k",
        postingMaterial: "m",
        evidenceVersion: "e",
        dir,
        manifest: { files: published.files, attachment: null, coverLetter: "Cover_Letter.pdf", answers: [{ question: "Why Acme?", answer: "Because <b>reasons</b>." }], repairs: 0, rejectedSentences: 2 },
        createdAt: env.clock.now().toISOString(),
      },
      null,
    );
    server = await startServer(env.ctx, { port: 0 });
    token = tokenOf((await call("GET", "/")).body);
  });
  afterAll(() => server.close());

  it("renders the pack's documents, escaped, with the answers fill may use", async () => {
    const r = await call("GET", `/o/${id}/g/abc123`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Not approved.");
    expect(r.body).toContain("<h3>Do NOT claim</h3>");
    expect(r.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(r.body).not.toMatch(/<script/i);
    expect(r.body).toContain("<strong>leadership</strong> of a <code>team</code>");
    expect(r.body).toContain("<th>Claim</th>");
    expect(r.body).toContain("Because &lt;b&gt;reasons&lt;/b&gt;.");
    expect(r.body).toContain("2 sentences removed by verification");
    expect(r.body.indexOf("pack-review.md")).toBeLessThan(r.body.indexOf("Cover_Letter.md"));
    expect(r.body).not.toContain("pack.json");
    expect((await call("GET", `/o/${id}`)).body).toContain(`/o/${id}/g/abc123`);
  });

  it("serves a generated file only when it is listed and unchanged; HTML sandboxed", async () => {
    const pdf = await call("GET", `/o/${id}/g/abc123/f/Cover_Letter.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const html = await call("GET", `/o/${id}/g/abc123/f/Cover_Letter.html`);
    expect(html.status).toBe(200);
    expect(String(html.headers["content-security-policy"])).toMatch(/^sandbox;/);
    expect(String(html.headers["content-security-policy"])).not.toContain("script-src");
    expect((await call("GET", `/o/${id}/g/abc123/f/pack.json`)).status).toBe(404);
    expect((await call("GET", `/o/${id}/g/abc123/f/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await call("GET", `/o/${id}/g/abc123/f/%E0%A4%A`)).status).toBe(404);
    writeFileSync(env.ctx.artifacts.path(dir, "Cover_Letter.md"), "Tampered.\n");
    const changed = await call("GET", `/o/${id}/g/abc123/f/Cover_Letter.md`);
    expect(changed.status).toBe(409);
    expect(changed.body).toContain("changed on disk");
  });

  it("approves only when the reader says they read it, through the CLI's use case", async () => {
    const no = await call("POST", "/act/approve", { body: form({ id, gen: "abc123", csrf: token }), headers: FORM });
    expect((await call("GET", String(no.headers.location))).body).toContain("Not approved");
    expect(env.store.artifacts(id, "pack")[0]!.approvedAt).toBeNull();

    const wrongGen = await call("POST", "/act/approve", { body: form({ id, gen: "nope", read: "yes", csrf: token }), headers: FORM });
    expect((await call("GET", String(wrongGen.headers.location))).body).toMatch(/class="flash refused"/);
    expect(env.store.artifacts(id, "pack")[0]!.approvedAt).toBeNull();

    const yes = await call("POST", "/act/approve", { body: form({ id, gen: "abc123", read: "yes", note: "read twice", csrf: token, back: `/o/${id}/g/abc123` }), headers: FORM });
    expect(String(yes.headers.location)).toMatch(new RegExp(`^/o/${id}/g/abc123\\?f=`));
    expect(env.store.artifacts(id, "pack")[0]!.approvedAt).toBe(env.clock.now().toISOString());
    const after = await call("GET", String(yes.headers.location));
    expect(after.body).toContain("Approved pack abc123");
    expect(after.body).toContain('class="approved"');
    expect(after.body).not.toContain("Approve this pack");
    expect(env.store.recentRuns("2000-01-01T00:00:00Z").some((x) => x.command === "web:approve" && x.outcome === "ok")).toBe(true);
  });
});

/* ------------------------------------------------------- through tailscale */

describe("web UI behind tailscale serve", () => {
  let env: TestEnv;
  let server: ServerHandle;
  const call = client(() => server.port);
  const viaTailnet = (extra: Record<string, string> = {}) => ({
    host: `${TAILNET}:8443`,
    "x-forwarded-for": "100.108.99.116",
    "x-forwarded-host": `${TAILNET}:8443`,
    "x-forwarded-proto": "https",
    "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    "tailscale-user-login": LOGIN,
    "tailscale-user-name": "Pat Example",
    ...extra,
  });

  beforeAll(async () => {
    const config = testConfig((c) => {
      c.operations.web.allowed_hosts = [TAILNET];
      c.operations.web.allowed_logins = [LOGIN];
      c.sources.sources.remoteok.enabled = true;
    });
    env = makeEnv({ config, routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
    await sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString()));
    evaluate(env.ctx, null);
    server = await startServer(env.ctx, { port: 0 });
  });
  afterAll(() => server.close());

  it("admits an allowed tailnet login on an allowed host, and names them", async () => {
    const r = await call("GET", "/", { headers: viaTailnet() });
    expect(r.status).toBe(200);
    expect(r.body).toContain("Signed in as Pat Example through the tailnet");
  });

  it("refuses a missing or unlisted login, an unlisted host, and any Funnel request", async () => {
    const noLogin = viaTailnet();
    delete (noLogin as Record<string, string>)["tailscale-user-login"];
    expect((await call("GET", "/", { headers: noLogin })).status).toBe(403);
    expect((await call("GET", "/", { headers: viaTailnet({ "tailscale-user-login": "someone@else.com" }) })).status).toBe(403);
    expect((await call("GET", "/", { headers: viaTailnet({ host: "other.tail1234.ts.net" }) })).status).toBe(403);
    expect((await call("GET", "/", { headers: viaTailnet({ "tailscale-funnel-request": "?1" }) })).status).toBe(403);
    expect(env.logs.some((l) => l.includes("refused") && l.includes("Funnel"))).toBe(true);
  });

  it("accepts a write whose Origin is the tailnet host it came in on", async () => {
    const page = await call("GET", "/", { headers: viaTailnet() });
    const token = tokenOf(page.body);
    const id = env.store.ranking({ eligible: true })[0]!.opportunityId;
    const body = form({ id, to: "reviewed", csrf: token });
    const foreign = await call("POST", "/act/pursue", { body, headers: { ...viaTailnet({ origin: `https://${TAILNET}` }), ...FORM } });
    expect(foreign.status).toBe(403); // port differs: a different origin
    const ok = await call("POST", "/act/pursue", { body, headers: { ...viaTailnet({ origin: `https://${TAILNET}:8443`, "sec-fetch-site": "same-origin" }), ...FORM } });
    expect(ok.status).toBe(303);
    expect(pursuitOf(env.ctx, id).state).toBe("reviewed");
  });

  it("carries the Remote OK attribution while that source is enabled", async () => {
    const r = await call("GET", "/system", { headers: viaTailnet() });
    expect(r.body).toContain('href="https://remoteok.com"');
    expect(r.body).toContain("Remote OK");
  });
});

/* ---------------------------------------------------------------- policies */

describe("access policy", () => {
  const policy = { allowedHosts: [TAILNET], allowedLogins: ["Me@Example.com"] };
  const proxied = { host: TAILNET, "x-forwarded-for": "100.1.1.1", "tailscale-user-login": "me@example.com", "tailscale-user-name": "Me" };

  it("admits loopback names directly, with or without a port", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:4180", "localhost:4180", "[::1]:4180", "LOCALHOST"]) expect(admit({ host }, policy).ok, host).toBe(true);
  });

  it("refuses other names directly, even an allowed tailnet one (no identity)", () => {
    for (const host of [TAILNET, "evil.example", "127.0.0.1.evil.example", "", "a b"]) expect(admit({ host }, policy).ok, host).toBe(false);
    expect(admit({}, policy).ok).toBe(false);
  });

  it("admits a proxied request only with an allowed host and login (case-insensitive)", () => {
    const a = admit(proxied, policy);
    expect(a).toEqual({ ok: true, via: "tailnet", host: TAILNET, login: "me@example.com", name: "Me" });
    expect(admit({ ...proxied, host: `${TAILNET.toUpperCase()}:8443` }, policy).ok).toBe(true);
    expect(admit({ ...proxied, "tailscale-user-login": "other@example.com" }, policy).ok).toBe(false);
    expect(admit({ ...proxied, "tailscale-user-login": "" }, policy).ok).toBe(false);
    expect(admit({ ...proxied, host: "127.0.0.1" }, policy).ok).toBe(false);
    expect(admit({ host: TAILNET, forwarded: "for=1.2.3.4" }, policy).ok).toBe(false);
    expect(admit({ ...proxied, "tailscale-funnel-request": "?1" }, policy).ok).toBe(false);
    expect(admit(proxied, { allowedHosts: [TAILNET], allowedLogins: [] }).ok).toBe(false);
  });

  it("parses Host headers strictly", () => {
    expect(hostnameOf("Box.Example:8443")).toBe("box.example");
    expect(hostnameOf("[::1]:80")).toBe("[::1]");
    expect(hostnameOf("box.example:")).toBeNull();
    expect(hostnameOf("user@box.example")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });

  it("checks Origin against the Host the request came in on", () => {
    expect(sameOrigin({ host: "127.0.0.1:4180" })).toBe(true);
    expect(sameOrigin({ host: "127.0.0.1:4180", origin: "http://127.0.0.1:4180" })).toBe(true);
    expect(sameOrigin({ host: `${TAILNET}:8443`, origin: `https://${TAILNET}:8443` })).toBe(true);
    expect(sameOrigin({ host: "127.0.0.1:4180", origin: "http://127.0.0.1:4181" })).toBe(false);
    expect(sameOrigin({ host: "127.0.0.1:4180", origin: "null" })).toBe(false);
    expect(sameOrigin({ host: "127.0.0.1:4180", origin: "file://127.0.0.1:4180" })).toBe(false);
    expect(sameOrigin({ host: "127.0.0.1:4180", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(sameOrigin({ host: "127.0.0.1:4180", "sec-fetch-site": "same-site" })).toBe(false);
    expect(sameOrigin({ host: "127.0.0.1:4180", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4180" })).toBe(true);
  });

  it("keeps `back` on this site", () => {
    expect(safeBack("/ranked?p=A&f=abc")).toBe("/ranked?p=A");
    expect(safeBack("/o/abc/g/def")).toBe("/o/abc/g/def");
    for (const bad of [null, "", "//evil.example", "https://evil.example", "/\\evil", "ranked", "javascript:alert(1)"]) expect(safeBack(bad), String(bad)).toBe("/");
  });

  it("dates an event from a date input: today is now, the past is local noon, the future is refused", () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    expect(occurredAt(null, now)).toBe(now.toISOString());
    expect(occurredAt(localDay(now), now)).toBe(now.toISOString());
    const past = occurredAt("2026-09-15", now);
    expect(localDay(new Date(past))).toBe("2026-09-15");
    expect(new Date(past).getHours()).toBe(12);
    expect(() => occurredAt("2027-01-01", now)).toThrow(/future/);
    expect(() => occurredAt("2026-02-30", now)).toThrow(/not a date/);
    expect(() => occurredAt("yesterday", now)).toThrow(/not a date/);
  });

  it("requires a tailnet login whenever a proxied host is allowed, and plain hostnames", () => {
    const base = testConfig().operations;
    const parse = (web: unknown) => OperationsSchema.safeParse({ ...base, web });
    expect(parse({ allowed_hosts: [TAILNET], allowed_logins: [LOGIN] }).success).toBe(true);
    expect(parse({}).success).toBe(true);
    const missing = parse({ allowed_hosts: [TAILNET] });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain("allowed_logins");
    for (const host of [`${TAILNET}:8443`, `https://${TAILNET}`, "Box.Example", "*.ts.net"]) {
      expect(parse({ allowed_hosts: [host], allowed_logins: [LOGIN] }).success, host).toBe(false);
    }
    expect(parse({ port: 0 }).success).toBe(false);
    expect(parse({ unknown: true }).success).toBe(false);
  });
});

describe("rendered text", () => {
  it("never links a non-http(s) URL, even one stored before URLs were filtered", () => {
    const env = makeEnv({ routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
    return sweep(env.ctx, env.store.startRun("t", env.clock.now().toISOString())).then(() => {
      evaluate(env.ctx, null);
      const row = env.store.ranking({ eligible: true })[0]!;
      const evil = { ...row, detail: { ...row.detail, applicationUrl: "javascript:alert(1)", url: "javascript:alert(2)" } };
      const html = slateCardHtml(evil, env.clock.now().toISOString());
      expect(html).not.toMatch(/href="\s*javascript:/i);
      expect(html).not.toMatch(/javascript:/i);
    });
  });

  it("renders generated Markdown from escaped text only", () => {
    const out = markdown('# Title <b>\n\n- item `<x>` **bold**\n\n> quote & "q"\n\n[link](javascript:alert(1)) <img src=x onerror=alert(1)>\n');
    expect(out).toContain("<h2>Title &lt;b&gt;</h2>");
    expect(out).toContain("<li>item <code>&lt;x&gt;</code> <strong>bold</strong></li>");
    expect(out).toContain("<blockquote>quote &amp; &quot;q&quot;</blockquote>");
    expect(out).not.toMatch(/<a\s|<img/i);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
