import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { legacyDb } from "./helpers/legacy.js";
import { readLegacy } from "../src/adapters/legacy/reader.js";
import { convertLegacyConfig } from "../src/adapters/legacy/config.js";
import { importLegacy } from "../src/app/legacy-import.js";
import { evaluate } from "../src/app/evaluate.js";
import { applicationFold, applicationViews, pursuitOf } from "../src/app/pursuit.js";
import { spendSummary } from "../src/app/spend.js";
import { coherenceProblems } from "../src/domain/config/schema.js";
import { makeEnv } from "./helpers/context.js";

describe("legacy import", () => {
  it("brings history across as events at their original times, and keeps analyses stale", () => {
    const env = makeEnv({ now: "2026-10-01T00:00:00.000Z" });
    const r = importLegacy(env.ctx, readLegacy(legacyDb()));
    expect(r.outcome).toBe("ok");
    expect(r.value).toMatchObject({ opportunities: 6, applications: 3, legacyAssessments: 1, mail: 1, automaticGhosts: 1 });

    evaluate(env.ctx, null);
    expect(pursuitOf(env.ctx, "j-skipped").state).toBe("skipped");
    const apps = applicationViews(env.ctx);
    const acme = apps.find((a) => a.opportunityId === "j-applied")!;
    expect(acme.state).toBe("rejected");
    expect(acme.furthest).toBe("screen");
    expect(acme.submittedAt).toBe("2026-08-04T00:00:00Z");
    const steps = applicationFold(env.ctx, acme.id).steps;
    expect(steps.map((s) => s.event.actor)).toEqual(["mail", "mail"]);

    // The automatic GHOSTED is imported, flagged, and can be voided by a human.
    const ghost = apps.find((a) => a.opportunityId === "j-ghost")!;
    expect(ghost.state).toBe("ghosted");
    expect(env.ctx.store.applicationEvents(ghost.id)[0]!.actor).toBe("system");

    // A legacy analysis never counts as current.
    const row = env.ctx.store.rankingFor("j-applied")!;
    expect(row.analystRec).toBeNull();
    expect(row.staleAssessment).toBe(true);

    // Pre-receipt spend comes across as a lower bound in the one ledger.
    env.clock.set("2026-08-10T00:00:00.000Z");
    expect(spendSummary(env.ctx, 30).month.committed).toBeCloseTo(0.31);

    // No coverage was imported, so nothing is inferred closed before a real sweep.
    expect(env.ctx.store.ranking({}).every((x) => x.postingState === "unknown")).toBe(true);
  });

  it("keeps each posting with the job it belongs to, whatever the old content dedupe linked", () => {
    const env = makeEnv();
    const r = importLegacy(env.ctx, readLegacy(legacyDb()));
    // acme:9 (j-live's own, also linked from j-closed) and acme:77 (linked from both, owned by neither) x2.
    expect(r.value.contestedLinks).toBe(3);
    const owner = (ext: string) => env.ctx.store.allAliases().find((a) => a.externalId === ext)?.opportunityId;
    expect(owner("acme:9")).toBe("j-live");
    expect(owner("acme:8")).toBe("j-closed");
    expect(owner("acme:77")).toBeUndefined();
    // No job is left without a posting.
    for (const id of ["j-applied", "j-skipped", "j-ghost", "j-closed", "j-live", "j-corrected"]) expect(env.ctx.store.aliasesFor(id).length).toBeGreaterThan(0);
  });

  it("a later move back to APPLIED voids the state it undid, keeping the record", () => {
    const env = makeEnv({ now: "2026-10-01T00:00:00.000Z" });
    const r = importLegacy(env.ctx, readLegacy(legacyDb()));
    expect(r.value.correctedEvents).toBe(1);
    const app = applicationViews(env.ctx).find((a) => a.opportunityId === "j-corrected")!;
    expect(app.state).toBe("submitted");
    expect(app.submittedAt).toBe("2026-08-11T00:00:00Z");
    const [screen] = env.ctx.store.applicationEvents(app.id);
    expect(screen!.to).toBe("screen");
    expect(env.ctx.store.voids("application_event").map((v) => v.targetId)).toContain(screen!.id);
  });

  it("a history that starts with a mailed rejection is not recorded as a human submission", () => {
    // Found by the 2026-10-14 review.
    const env = makeEnv({ now: "2026-10-01T00:00:00.000Z" });
    const data = readLegacy(legacyDb());
    const base = data.jobs.find((j) => j.id === "j-ghost")!;
    data.jobs.push({ ...base, id: "j-mailonly", externalId: "globex:99", status: "REJECTED", title: "Data Engineer" });
    data.statusEvents.push({ jobId: "j-mailonly", from: "NEW", to: "REJECTED", at: "2026-09-02T00:00:00Z", note: "REJECTED from email m7" });
    // And a late confirmation email after a real screen voids nothing.
    data.statusEvents.push({ jobId: "j-applied", from: "REJECTED", to: "APPLIED", at: "2026-09-12T00:00:00Z", note: "APPLIED from email m9" });
    const r = importLegacy(env.ctx, data);
    expect(r.value.unconfirmedSubmissions).toBe(1);
    const app = applicationViews(env.ctx).find((a) => a.opportunityId === "j-mailonly")!;
    const submitted = env.ctx.store.pursuitEvents("j-mailonly").find((e) => e.to === "applied")!;
    expect(submitted.actor).toBe("mail");
    expect(submitted.note).toMatch(/UNCONFIRMED/);
    expect(app.state).toBe("rejected");
    expect(applicationViews(env.ctx).find((a) => a.opportunityId === "j-applied")!.state).toBe("rejected");
  });

  it("refuses to import into a database that already has data", () => {
    const env = makeEnv();
    importLegacy(env.ctx, readLegacy(legacyDb()));
    expect(importLegacy(env.ctx, readLegacy(legacyDb())).outcome).toBe("refused");
  });

  it("converts the old single career profile into coherent split config", () => {
    // The previous tool's real committed config, frozen as a fixture.
    const dir = resolve(import.meta.dirname, "fixtures", "legacy-config");
    const c = convertLegacyConfig(resolve(dir, "career-profile.yaml"), resolve(dir, "sources.yaml"));
    expect(coherenceProblems(c)).toEqual([]);
    expect(c.policy.priority.A).toEqual({ min_fit: 78, min_roi: 72 });
    expect(c.operations.http.delay_ms).toBeGreaterThanOrEqual(500);
  });
});
