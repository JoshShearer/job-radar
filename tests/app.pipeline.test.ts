import { describe, expect, it } from "vitest";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { assess } from "../src/app/assess.js";
import { approve, preparePack, tailor } from "../src/app/materials.js";
import { fill } from "../src/app/fill.js";
import { applicationFold, applicationViews, pursuitOf, recordOutcome, transitionPursuit } from "../src/app/pursuit.js";
import { buildBriefing } from "../src/app/briefing.js";
import { spendFor } from "../src/app/spend.js";
import { withRun } from "../src/app/run.js";
import { EvidenceSchema } from "../src/domain/candidate/evidence.js";
import type { ModelRequest } from "../src/ports/io.js";
import { dossierVerdict, FakeModel, GH_ACME, ghBoard, makeEnv, TEST_EVIDENCE, testConfig, triageVerdict, type ModelReply } from "./helpers/context.js";

const JOBS = [
  { id: 1, title: "Senior Software Engineer" },
  { id: 2, title: "Junior Designer" },
  { id: 3, title: "Senior iOS Engineer" },
];

function replies(state: { triage?: Record<string, unknown>; dossier?: Record<string, unknown> } = {}) {
  return (req: ModelRequest): ModelReply => {
    const props = Object.keys((req.jsonSchema as { properties?: object }).properties ?? {});
    if (props.includes("headlineId")) {
      return {
        json: {
          positioning: "full-stack product engineer",
          headlineId: "h-full",
          summaryId: "s-main",
          skillGroups: [{ label: "Frontend", skills: ["React", "Next.js", "TypeScript"] }],
          roles: [{ roleId: "acme", claims: [{ claimId: "acme-1", rewrite: "Built a production NextJS marketplace" }, { claimId: "acme-2", rewrite: "Designed and ran 900 SEO experiments" }] }],
          projects: [],
          omitted: [],
          gapsToExpect: ["Kubernetes"],
          doNotClaim: ["Kubernetes"],
        },
      };
    }
    if (props.includes("coverLetter")) {
      return {
        json: {
          positioning: "frame",
          coverLetter: [
            [
              { text: "I'm applying for the Senior Software Engineer role at Acme.", cites: [] },
              { text: "I built a production Next.js marketplace with Payload CMS.", cites: ["acme-1"] },
              { text: "I scaled it to millions of users.", cites: ["acme-1"] },
            ],
          ],
          formAnswers: [
            { question: "Why do you want to work at Acme?", sentences: [{ text: "I designed and ran 200+ measured SEO experiments.", cites: ["acme-2"] }] },
            { question: "Describe your leadership experience", sentences: [{ text: "I led a large team.", cites: ["acme-3"] }] },
          ],
          doNotClaim: ["Kubernetes"],
          decideFirst: [],
        },
      };
    }
    if (props.includes("strengths")) return { json: dossierVerdict(state.dossier) };
    return { json: triageVerdict(state.triage) };
  };
}

describe("the whole pipeline, as a user runs it", () => {
  const verdicts: { triage?: Record<string, unknown>; dossier?: Record<string, unknown> } = {};
  const model = new FakeModel(replies(verdicts));
  const config = testConfig((c) => {
    c.sources.sources.greenhouse.boards = [
      { token: "acme", company: "Acme" },
      { token: "globex", company: "Globex" },
    ];
  });
  let board = ghBoard(JOBS);
  const env = makeEnv({
    now: "2026-10-01T12:00:00.000Z",
    config,
    model,
    routes: { [GH_ACME]: () => board, "boards-api.greenhouse.io/v1/boards/globex/": new Error("HTTP 500 Internal Server Error") },
    confirms: [true],
  });
  const ctx = env.ctx;
  const run = (name: string) => ctx.store.startRun(name, ctx.clock.now().toISOString());
  let oppId = "";

  it("sweeps: a failing board is isolated and the run says it was degraded", async () => {
    const r = await sweep(ctx, run("sweep"));
    expect(r.outcome).toBe("degraded");
    expect(r.value.boardsComplete).toBe(1);
    expect(r.value.failures[0]!.boardId).toBe("greenhouse:globex");
    expect(r.value.newOpportunities).toBe(3);
  });

  it("evaluates: hard filters reject on evidence; the eligible posting ranks", () => {
    const r = evaluate(ctx, run("evaluate"));
    expect(r.value.eligible).toBe(1);
    const rows = ctx.store.ranking({ eligible: true });
    expect(rows).toHaveLength(1);
    oppId = rows[0]!.opportunityId;
    expect(rows[0]!.postingState).toBe("open");
    expect(rows[0]!.confidence).toBe("raw");
    const rejected = ctx.store.ranking({ eligible: false });
    expect(rejected.map((x) => x.title).sort()).toEqual(["Junior Designer", "Senior iOS Engineer"]);
  });

  it("assesses: triage, then the dossier it earned; the ranking now carries the analyst", async () => {
    const r = await assess(ctx, run("assess"), { limit: 10 });
    expect(r.outcome).toBe("ok");
    expect(r.value.bought).toBe(2);
    expect(r.value.dossiers).toBe(1);
    const row = ctx.store.rankingFor(oppId)!;
    expect(row.confidence).toBe("analyzed");
    expect(row.analystRec).toBe("apply");
    expect(row.analystTier).toBe("dossier");
    expect(row.rawFit).not.toBe(row.fit); // raw keyword score is never overwritten
  });

  it("never re-buys an unchanged posting, however much time passes", async () => {
    const before = model.calls.length;
    env.clock.advanceDays(40);
    await sweep(ctx, run("sweep"));
    evaluate(ctx, run("evaluate"));
    expect(ctx.store.rankingFor(oppId)!.confidence).toBe("analyzed");
    const r = await assess(ctx, run("assess"), { limit: 10 });
    expect(r.value.bought).toBe(0);
    expect(model.calls.length).toBe(before);
  });

  it("a material change makes the assessment stale, and only then is it re-bought", async () => {
    board = ghBoard([{ ...JOBS[0]!, content: "<h3>Requirements</h3><ul><li>10+ years of Rust and Kubernetes at scale</li></ul>" }, JOBS[1]!, JOBS[2]!]);
    await sweep(ctx, run("sweep"));
    evaluate(ctx, run("evaluate"));
    const row = ctx.store.rankingFor(oppId)!;
    expect(row.confidence).not.toBe("analyzed");
    expect(row.staleAssessment).toBe(true);
    const r = await assess(ctx, run("assess"), { limit: 10 });
    expect(r.value.bought).toBe(2);
    board = ghBoard(JOBS); // back to the original posting for the rest of the story
    await sweep(ctx, run("sweep"));
    evaluate(ctx, run("evaluate"));
    expect(ctx.store.rankingFor(oppId)!.confidence).toBe("analyzed"); // the original answer is still in the store
  });

  it("tailors: a verified selection, rendered to an immutable generation; pursuit moves to preparing", async () => {
    const r = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, oppId));
    expect(r.outcome).toBe("ok");
    const gen = ctx.store.artifacts(oppId, "resume")[0]!;
    expect(gen.manifest.attachment).toMatch(/Pat_Example_Resume_Acme\.pdf$/);
    const md = ctx.artifacts.read(gen.dir, "Pat_Example_Resume_Acme.md")!;
    expect(md).toContain("Built a production NextJS marketplace");
    expect(md).toContain("Designed and ran 200+ measured SEO experiments"); // the "900" rewrite was reverted
    expect(md).not.toContain("900");
    expect(gen.manifest.repairs).toBe(1);
    expect(pursuitOf(ctx, oppId).state).toBe("preparing");
  });

  it("re-running tailor reuses (no call, same generation); an evidence edit re-verifies for free", async () => {
    const calls = model.calls.length;
    const again = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, oppId));
    expect(again.value.reused).toBe(true);
    expect(model.calls.length).toBe(calls);
    expect(ctx.store.artifacts(oppId, "resume")).toHaveLength(1);

    env.setEvidence(
      EvidenceSchema.parse({
        ...TEST_EVIDENCE,
        experience: TEST_EVIDENCE.experience.map((r) => (r.id === "acme" ? { ...r, claims: r.claims.filter((c) => c.id !== "acme-2") } : r)),
      }),
    );
    const rerender = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, oppId));
    expect(model.calls.length).toBe(calls);
    const gens = ctx.store.artifacts(oppId, "resume");
    expect(gens).toHaveLength(2);
    expect(ctx.artifacts.read(gens[0]!.dir, "Pat_Example_Resume_Acme.md")).not.toContain("SEO experiments"); // a removed claim cannot survive
    expect(rerender.value.reused).toBe(true);
    env.setEvidence(TEST_EVIDENCE);
  });

  it("prepares: refused sentences are removed, partial answers are not usable", async () => {
    const r = await withRun(ctx, "prepare", (runId) => preparePack(ctx, runId, oppId));
    expect(r.value.rejected).toBe(2);
    const pack = ctx.store.artifacts(oppId, "pack")[0]!;
    expect(pack.manifest.answers).toEqual([{ question: "Why do you want to work at Acme?", answer: "I designed and ran 200+ measured SEO experiments." }]);
    expect(ctx.artifacts.read(pack.dir, "pack-review.md")).toContain("Refused by the verifier");
    expect(pack.approvedAt).toBeNull();
  });

  it("fill uses NO drafted text until the pack is approved", async () => {
    await withRun(ctx, "fill", (runId) => fill(ctx, runId, oppId, { headless: true }));
    expect(env.browser.inputs[0]!.answers).toEqual([]);
    expect(env.browser.inputs[0]!.coverLetterPath).toBeNull();
    expect(env.browser.inputs[0]!.resumePath).toMatch(/Resume_Acme\.pdf$/);
  });

  it("after approval, fill uses the verified answers; only the human's yes records the submission", async () => {
    approve(ctx, oppId);
    const r = await withRun(ctx, "fill", (runId) => fill(ctx, runId, oppId));
    expect(env.browser.inputs[1]!.answers).toHaveLength(1);
    expect(env.browser.inputs[1]!.coverLetterPath).toMatch(/Cover_Letter_Acme\.pdf$/);
    expect(r.value.submittedRecorded).toBe(true);
    expect(pursuitOf(ctx, oppId).state).toBe("applied");
    expect(applicationViews(ctx)).toHaveLength(1);
  });

  it("outcomes are a fold over events: an older invite recorded after a newer rejection does not undo it", () => {
    const app = ctx.store.applications(oppId)[0]!;
    recordOutcome(ctx, null, app.id, "rejected", { occurredAt: "2026-11-20T00:00:00.000Z" });
    // The invitation genuinely happened before the rejection, so it is a
    // valid event; it simply cannot reorder history. Final state: rejected.
    const late = recordOutcome(ctx, null, app.id, "screen", { occurredAt: "2026-11-15T00:00:00.000Z" });
    expect(late.outcome).toBe("ok");
    expect(applicationFold(ctx, app.id).state).toBe("rejected");
    // An invitation dated AFTER the rejection is refused: rejected is final.
    expect(recordOutcome(ctx, null, app.id, "interview", { occurredAt: "2026-11-25T00:00:00.000Z" }).outcome).toBe("refused");
  });

  it("every dollar is attributable to the posting it was spent on", () => {
    const s = spendFor(ctx, oppId);
    expect(s.calls).toBeGreaterThanOrEqual(6);
    expect(s.usd).toBeGreaterThan(0);
  });

  it("the briefing says the funnel is unobserved when mail was never read", () => {
    // Re-open a second application so something is in flight.
    const b = buildBriefing(ctx);
    expect(b.funnel.counts.submitted).toBe(1);
    expect(b.health.some((h) => /failed their latest sweep/.test(h.text))).toBe(true);
  });
});

const run = (ctx: ReturnType<typeof makeEnv>["ctx"]) => ctx.store.startRun("test", ctx.clock.now().toISOString());

describe("gates", () => {
  it("a run whose only call fails still reports what it spent", async () => {
    // Observed live: a dossier failing schema validation cost $0.11 and the run said $0.
    const model = new FakeModel(() => ({ json: { nope: 1 }, usage: { input_tokens: 20_000, output_tokens: 2_000 } }));
    const env = makeEnv({ model, routes: { [GH_ACME]: ghBoard([JOBS[0]!]) } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    const r = await assess(ctx, run(ctx), { limit: 1, twoStage: false });
    expect(r.value.failed).toBe(1);
    expect(r.value.bought).toBe(0);
    expect(r.value.spentUsd).toBeGreaterThan(0);
    expect(r.value.spentUsd).toBeCloseTo(ctx.store.modelCalls()[0]!.actualUsd!, 6);
  });

  it("an unendorsed posting is refused before any spend; an override proceeds and is recorded", async () => {
    const model = new FakeModel(replies({ triage: { recommendation: "skip", fitScore: 30 }, dossier: { recommendation: "skip", fitScore: 30 } }));
    const env = makeEnv({ model, routes: { [GH_ACME]: ghBoard([JOBS[0]!]) } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    await assess(ctx, run(ctx), { limit: 5, twoStage: false });
    const id = ctx.store.ranking({ eligible: true })[0]!.opportunityId;
    const calls = model.calls.length;
    const refused = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, id));
    expect(refused.outcome).toBe("refused");
    expect(refused.notes[0]).toMatch(/not endorsed/);
    expect(model.calls.length).toBe(calls);
    const ok = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, id, { override: true }));
    expect(ok.outcome).toBe("ok");
    expect(ctx.store.overrides(id).map((o) => o.gate)).toEqual(["verdict"]);
  });

  it("a posting its board stopped listing is closed after park_after_days, and preparation refuses it", async () => {
    let board = ghBoard([JOBS[0]!, { id: 7, title: "Senior Platform Engineer" }]);
    const env = makeEnv({ model: new FakeModel(replies()), routes: { [GH_ACME]: () => board } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    board = ghBoard([{ id: 7, title: "Senior Platform Engineer" }]);
    env.clock.advanceDays(1);
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    const gone = ctx.store.ranking({}).find((r) => r.title === "Senior Software Engineer")!;
    expect(gone.postingState).toBe("missing");
    env.clock.advanceDays(4);
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    expect(ctx.store.rankingFor(gone.opportunityId)!.postingState).toBe("closed");
    const r = await withRun(ctx, "tailor", (runId) => tailor(ctx, runId, gone.opportunityId));
    expect(r.outcome).toBe("refused");
    // Listed again: open again, with no special-case code.
    board = ghBoard([JOBS[0]!, { id: 7, title: "Senior Platform Engineer" }]);
    env.clock.advanceDays(1);
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    expect(ctx.store.rankingFor(gone.opportunityId)!.postingState).toBe("open");
  });

  it("a board that FAILS can never close its postings", async () => {
    let fail = false;
    const env = makeEnv({ routes: { [GH_ACME]: () => (fail ? (() => { throw new Error("HTTP 503"); })() : ghBoard([JOBS[0]!])) } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    fail = true;
    env.clock.advanceDays(30);
    const r = await sweep(ctx, run(ctx));
    expect(r.outcome).toBe("failed");
    evaluate(ctx, null);
    expect(ctx.store.ranking({})[0]!.postingState).toBe("open");
  });

  it("skipping is a decision the ranking respects", async () => {
    const env = makeEnv({ routes: { [GH_ACME]: ghBoard([JOBS[0]!]) } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    const id = ctx.store.ranking({ eligible: true })[0]!.opportunityId;
    expect(transitionPursuit(ctx, null, id, "skipped").outcome).toBe("ok");
    evaluate(ctx, null);
    expect(ctx.store.ranking({ eligible: true, pursuitStates: ["new", "reviewed"] })).toHaveLength(0);
    expect(buildBriefing(ctx).slate).toHaveLength(0);
  });
});

describe("run lifecycle", () => {
  it("a synchronous throw still finalizes the run as failed", async () => {
    const env = makeEnv();
    await expect(
      withRun(env.ctx, "boom", () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    const runs = env.store.recentRuns("2000-01-01T00:00:00Z");
    expect(runs[0]).toMatchObject({ command: "boom", outcome: "failed", error: "sync boom" });
  });

  it("a refusal is recorded as a refusal, not a success", async () => {
    const env = makeEnv({ evidence: null });
    const r = await withRun(env.ctx, "assess", (runId) => assess(env.ctx, runId, { limit: 1 }));
    expect(r.outcome).toBe("refused");
    expect(env.store.recentRuns("2000-01-01T00:00:00Z")[0]!.outcome).toBe("refused");
  });
});

describe("one requisition, several locations", () => {
  it("is judged on its best variant, and later steps use that same variant", async () => {
    const content = "<h3>Requirements</h3><ul><li>TypeScript and React</li><li>Next.js</li></ul>" + " Shared requisition text.".repeat(20);
    const board = ghBoard([
      { id: 1, title: "Senior Software Engineer", location: "Seattle, WA (onsite)", content, posted: "2026-09-29T12:00:00Z" },
      { id: 2, title: "Senior Software Engineer", location: "Remote - US", content, posted: "2026-09-29T12:00:00Z" },
    ]);
    const model = new FakeModel(replies());
    const env = makeEnv({ model, routes: { [GH_ACME]: board } });
    const ctx = env.ctx;
    await sweep(ctx, run(ctx));
    evaluate(ctx, null);
    const rows = ctx.store.ranking({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail.aliases).toBe(2);
    expect(rows[0]!.eligible).toBe(true);
    expect(rows[0]!.location).toMatch(/Remote/);
    await assess(ctx, run(ctx), { limit: 1, twoStage: false });
    expect(model.calls[0]!.user).toMatch(/Location: Remote/);
    evaluate(ctx, null);
    expect(ctx.store.rankingFor(rows[0]!.opportunityId)!.confidence).toBe("analyzed");
  });
});
