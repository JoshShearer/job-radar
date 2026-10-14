import { describe, expect, it } from "vitest";
import { sweep } from "../src/app/sweep.js";
import { evaluate } from "../src/app/evaluate.js";
import { recordSubmission, applicationFold } from "../src/app/pursuit.js";
import { scanMail, mailCoverageSpan } from "../src/app/mail.js";
import { buildBriefing } from "../src/app/briefing.js";
import type { Email } from "../src/ports/io.js";
import { FakeMailbox, GH_ACME, ghBoard, makeEnv } from "./helpers/context.js";

async function withApplication(mailbox: FakeMailbox, now = "2026-10-01T12:00:00.000Z") {
  const env = makeEnv({ now, mailbox, routes: { [GH_ACME]: ghBoard([{ id: 1, title: "Senior Software Engineer" }]) } });
  const ctx = env.ctx;
  const run = () => ctx.store.startRun("t", ctx.clock.now().toISOString());
  await sweep(ctx, run());
  evaluate(ctx, null);
  const opp = ctx.store.ranking({ eligible: true })[0]!.opportunityId;
  const r = recordSubmission(ctx, null, opp, { submittedAt: "2026-09-01T00:00:00.000Z" });
  return { env, ctx, run, appId: r.value.applicationId! };
}

const mail = (id: string, receivedAt: string, subject: string, body: string, from = "no-reply@acme.greenhouse.io"): Email => ({ id, from, subject, body, receivedAt });

describe("mail ingestion", () => {
  it("records a rejection as an application event with the email's own time, in one transaction with the message", async () => {
    const box = new FakeMailbox([mail("m1", "2026-09-20T10:00:00.000Z", "Your application to Acme", "We have decided to move forward with other candidates.")]);
    const { ctx, run, appId } = await withApplication(box);
    const r = await scanMail(ctx, run());
    expect(r.outcome).toBe("ok");
    expect(r.value.applied).toBe(1);
    expect(applicationFold(ctx, appId).state).toBe("rejected");
    const ev = ctx.store.applicationEvents(appId)[0]!;
    expect(ev).toMatchObject({ to: "rejected", occurredAt: "2026-09-20T10:00:00.000Z", actor: "mail", mailMessageId: "m1" });
  });

  it("is order-independent: a newer rejection and an older invite in one scan end rejected", async () => {
    const box = new FakeMailbox([
      mail("rej", "2026-09-25T10:00:00.000Z", "Acme update", "We will not be moving forward."),
      mail("inv", "2026-09-10T10:00:00.000Z", "Acme interview", "We'd like to schedule a call with you."),
    ]);
    const { ctx, run, appId } = await withApplication(box);
    await scanMail(ctx, run());
    const f = applicationFold(ctx, appId);
    expect(f.state).toBe("rejected");
  });

  it("paginates fully, and a mid-scan outage leaves the cursor where it was (no backlog skipped)", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => mail(`c${i}`, `2026-09-1${i}T10:00:00.000Z`, "Acme: thank you for applying", "We received your application."));
    msgs.push(mail("late-rej", "2026-09-05T10:00:00.000Z", "Acme", "We have decided not to proceed with your application."));
    const box = new FakeMailbox(msgs, 2);
    box.failOn.add(2);
    const { ctx, run, appId } = await withApplication(box);
    const first = await scanMail(ctx, run());
    expect(first.outcome).toBe("degraded");
    expect(first.value.coverage).toBe("partial");
    expect(mailCoverageSpan(ctx)).toBeNull(); // nothing COMPLETE yet
    expect(applicationFold(ctx, appId).state).toBe("submitted"); // the rejection was on a page never read

    const second = await scanMail(ctx, run());
    expect(second.value.coverage).toBe("complete");
    expect(second.value.alreadySeen).toBeGreaterThan(0); // idempotent re-read of page 1
    expect(applicationFold(ctx, appId).state).toBe("rejected");
  });

  it("the next scan starts from the last complete window minus the overlap", async () => {
    const box = new FakeMailbox([]);
    const { env, ctx, run } = await withApplication(box);
    await scanMail(ctx, run());
    env.clock.advanceDays(5);
    const r = await scanMail(ctx, run());
    expect(r.value.window!.from).toBe("2026-09-29T12:00:00.000Z"); // 2026-10-01T12:00 minus 2 days overlap
  });

  it("ambiguous mail goes to review, never to a guess", async () => {
    const box = new FakeMailbox([mail("x", "2026-09-20T10:00:00.000Z", "Acme", "We are moving forward with other candidates. We'd also like to schedule a call.")]);
    const { ctx, run, appId } = await withApplication(box);
    const r = await scanMail(ctx, run());
    expect(r.value.ambiguous).toBe(1);
    expect(applicationFold(ctx, appId).state).toBe("submitted");
    expect(ctx.store.mailMessages({ resolutions: ["ambiguous"] })).toHaveLength(1);
  });

  it("a dry run writes nothing, including no coverage", async () => {
    const box = new FakeMailbox([mail("m1", "2026-09-20T10:00:00.000Z", "Acme", "We will not be moving forward.")]);
    const { ctx, run, appId } = await withApplication(box);
    const r = await scanMail(ctx, run(), { dryRun: true });
    expect(r.value.applied).toBe(1);
    expect(applicationFold(ctx, appId).state).toBe("submitted");
    expect(ctx.store.mailScans()).toHaveLength(0);
  });

  it("no mailbox: refused, and the briefing calls the funnel unobserved", async () => {
    const { env, ctx, run } = await withApplication(new FakeMailbox([]));
    env.mailbox = null;
    expect((await scanMail(ctx, run())).outcome).toBe("refused");
    expect(buildBriefing(ctx).health.some((h) => /UNOBSERVED/.test(h.text))).toBe(true);
  });

  it("silence becomes a ghosting SUGGESTION only when the mailbox was read across it", async () => {
    const box = new FakeMailbox([]);
    const { env, ctx, run } = await withApplication(box, "2026-08-25T12:00:00.000Z");
    await scanMail(ctx, run()); // coverage begins before submission
    env.clock.set("2026-10-15T12:00:00.000Z");
    await scanMail(ctx, run());
    const b = buildBriefing(ctx);
    expect(b.silence[0]).toMatchObject({ kind: "suggest_ghosted" });
    // A suggestion only: nothing was written.
    expect(ctx.store.applicationEvents()).toHaveLength(0);
  });
});
