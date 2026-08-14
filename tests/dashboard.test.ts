import { describe, it, expect } from "vitest";
import { buildDashboard, bucketByWeek, formatRate, weekStart } from "../src/report/dashboard.js";
import type { SourcesConfig } from "../src/config/schema.js";
import { GHOSTED_AFTER_DAYS, STALE_AFTER_DAYS } from "../src/model/status.js";
import { MIN_SAMPLE } from "../src/stats/funnel.js";
import { memoryRepo, seedJob, daysAgo } from "./helpers/db.js";

function sources(over: { remoteok?: boolean } = {}): SourcesConfig {
  return { watchlist: [], sources: { remoteok: { enabled: over.remoteok ?? false } } } as unknown as SourcesConfig;
}

function page(repo: ReturnType<typeof memoryRepo>["repo"], srcs = sources()): string {
  return buildDashboard({ repo, sources: srcs, now: new Date("2026-08-14T00:00:00Z") });
}

/**
 * The rule this file exists to defend: nothing on this page may read as more
 * certain than the data behind it. A bare percentage and a chart of one point
 * are the two ways a layout lies without any number being wrong.
 */
describe("rates always carry their sample size", () => {
  it("never renders a percentage without an n", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED" });

    const html = page(repo);
    // Every percent sign in a rate cell has to be followed by its sample. The
    // sweep is over rate cells specifically, because CSS widths are also
    // percentages and are not claims about anything.
    const rateCells = [...html.matchAll(/<td class="rate">([^<]*)<\/td>/g)].map((m) => m[1]!);
    expect(rateCells.length).toBeGreaterThan(0);
    for (const cell of rateCells) {
      if (cell.includes("%")) expect(cell, cell).toMatch(/\(n=\d+\)/);
    }
  });

  it("formatRate refuses to emit a bare percentage", () => {
    expect(formatRate(1, 1)).toBe("100% (n=1)");
    expect(formatRate(0.5, 40)).toBe("50% (n=40)");
    expect(formatRate(0, 12)).toBe("0% (n=12)");
  });

  it("distinguishes nobody converted from too few to round to one percent", () => {
    // 1 of 6919 is the real shape of the top of this funnel. Rounding it to
    // "0%" would report that nothing got through when something did.
    expect(formatRate(1 / 6919, 6919)).toBe("<1% (n=6919)");
    expect(formatRate(0, 6919)).toBe("0% (n=6919)");
  });

  it("renders an empty stage as n/a rather than 0%", () => {
    // A rate of null means the stage above is empty. "0%" would claim everyone
    // who got there failed to advance; nobody got there.
    expect(formatRate(null, 0)).toBe("n/a (n=0)");
    const { repo } = memoryRepo();
    expect(page(repo)).toContain("n/a (n=0)");
  });
});

describe("low-data states", () => {
  it("refuses to draw a trend below the sample floor and says why", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { status: "NEW" });
    repo.setStatus(id, "APPLIED");

    const html = page(repo);
    expect(html).toContain("Not enough data yet");
    expect(html).toContain("n=1 applications");
    expect(html).not.toContain('<table class="trend">');
  });

  it("draws the trend once there are enough applications", () => {
    const { repo, db } = memoryRepo();
    for (let i = 0; i < 16; i++) repo.setStatus(seedJob(db, { status: "NEW" }), "APPLIED");

    const html = page(repo);
    expect(html).toContain('<table class="trend">');
    expect(html).not.toContain("Not enough data yet");
  });

  it("surfaces the funnel's own sample warning instead of hiding it", () => {
    const { repo, db } = memoryRepo();
    repo.setStatus(seedJob(db), "APPLIED");
    expect(page(repo)).toContain("conversion rates are noise");
  });

  it("never draws a chart under its own warning that the numbers are noise", () => {
    // The chart threshold and the warning threshold are the same constant. If
    // they ever drift, this page contradicts itself in two adjacent sections.
    const { repo, db } = memoryRepo();
    for (let i = 0; i < MIN_SAMPLE.applied - 1; i++) repo.setStatus(seedJob(db), "APPLIED");

    const warned = page(repo);
    expect(warned).toContain("conversion rates are noise");
    expect(warned).not.toContain('<table class="trend">');

    repo.setStatus(seedJob(db), "APPLIED");
    const charted = page(repo);
    expect(charted).not.toContain("conversion rates are noise");
    expect(charted).toContain('<table class="trend">');
  });
});

describe("the reached-screen tile", () => {
  it("counts a job once, not once per stage it passed through", () => {
    const { repo, db } = memoryRepo();
    // One job, one conversation, all the way to an offer. stagesReached is
    // cumulative, so summing SCREEN+INTERVIEW+FINAL+OFFER would report 4.
    repo.setStatus(seedJob(db), "OFFER");

    const html = page(repo);
    const tile = html.match(/<div class="tile-v">(\d+)<\/div>\s*<div class="tile-l">Reached screen</)?.[1];
    expect(tile).toBe("1");
  });

  it("states the caveat that a rejection after a screen is not counted", () => {
    const { repo } = memoryRepo();
    expect(page(repo)).toContain("REJECTED or GHOSTED is credited only as far as APPLIED");
  });
});

describe("in flight", () => {
  it("lists live roles with their age and marks the quiet ones", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Acme", title: "Staff Engineer", status: "APPLIED", statusChangedAt: daysAgo(1) });
    seedJob(db, { company: "Globex", status: "APPLIED", statusChangedAt: daysAgo(STALE_AFTER_DAYS.APPLIED! + 3) });
    seedJob(db, { company: "Initech", status: "APPLIED", statusChangedAt: daysAgo(GHOSTED_AFTER_DAYS + 2) });

    const html = page(repo);
    expect(html).toContain("Acme - Staff Engineer");
    expect(html).toContain("1d");
    expect(html).toContain('<tr class="stale">');
    expect(html).toContain('<tr class="ghosted">');
    // A fresh row carries no flag class at all.
    expect(html).toContain('<tr class="">');
  });

  it("says so plainly when nothing is live", () => {
    const { repo } = memoryRepo();
    expect(page(repo)).toContain("Nothing submitted or in progress");
  });
});

describe("weekly bucketing", () => {
  it("buckets on the Monday of the week, in UTC", () => {
    expect(weekStart("2026-08-14T23:00:00Z")).toBe("2026-08-10"); // Friday
    expect(weekStart("2026-08-10T00:00:00Z")).toBe("2026-08-10"); // Monday itself
    expect(weekStart("2026-08-16T23:59:59Z")).toBe("2026-08-10"); // Sunday, same week
    expect(weekStart("2026-08-17T00:00:00Z")).toBe("2026-08-17"); // next Monday
  });

  it("does not fold the end of December into the following January", () => {
    // The bug an ISO week NUMBER would have: 2026-12-31 is ISO week 1 of 2027,
    // so a `${calendarYear}-W${week}` key renders it as 2026-W01 and sorts it
    // beside the previous January.
    const dec = weekStart("2026-12-31T12:00:00Z");
    const jan = weekStart("2026-01-02T12:00:00Z");
    expect(dec).toBe("2026-12-28");
    expect(jan).toBe("2025-12-29");
    expect(dec).not.toBe(jan);
    expect(dec > jan).toBe(true);
  });

  it("puts a role in the week it applied and the week they replied", () => {
    const buckets = bucketByWeek([
      { jobId: "a", to: "APPLIED", at: "2026-08-03T10:00:00Z" },
      { jobId: "a", to: "SCREEN", at: "2026-08-11T10:00:00Z" },
      { jobId: "b", to: "APPLIED", at: "2026-08-11T11:00:00Z" },
      { jobId: "b", to: "REVIEWED", at: "2026-08-11T12:00:00Z" },
    ]);

    expect(buckets).toEqual([
      { week: "2026-08-03", applications: 1, responses: 0 },
      { week: "2026-08-10", applications: 1, responses: 1 },
    ]);
  });

  it("counts a role once however many times its status was corrected", () => {
    // The event log is a log. Against the real database this counted 26
    // applications beside a tile reading 23, because one job had been
    // re-marked APPLIED over its life. Both were true and they answered
    // different questions, with nothing on the page saying which.
    const buckets = bucketByWeek([
      { jobId: "a", to: "APPLIED", at: "2026-08-03T10:00:00Z" },
      { jobId: "a", to: "APPLIED", at: "2026-08-04T10:00:00Z" },
      { jobId: "a", to: "APPLIED", at: "2026-08-12T10:00:00Z" },
    ]);
    expect(buckets).toEqual([{ week: "2026-08-03", applications: 1, responses: 0 }]);
  });

  it("counts one reply per role, not one per stage it advances through", () => {
    const buckets = bucketByWeek([
      { jobId: "a", to: "SCREEN", at: "2026-08-03T10:00:00Z" },
      { jobId: "a", to: "INTERVIEW", at: "2026-08-11T10:00:00Z" },
      { jobId: "a", to: "OFFER", at: "2026-08-18T10:00:00Z" },
    ]);
    expect(buckets.reduce((n, b) => n + b.responses, 0)).toBe(1);
    expect(buckets[0]).toEqual({ week: "2026-08-03", applications: 0, responses: 1 });
  });

  it("ignores transitions that are neither an application nor a reply", () => {
    expect(bucketByWeek([{ jobId: "a", to: "SKIPPED", at: "2026-08-03T10:00:00Z" }])).toEqual([]);
  });

  it("drops an unparseable timestamp rather than bucketing it somewhere", () => {
    expect(bucketByWeek([{ jobId: "a", to: "APPLIED", at: "not a date" }])).toEqual([]);
  });

  it("reconciles with the applied tile: distinct roles, counted once", () => {
    const { repo, db } = memoryRepo();
    const ids = Array.from({ length: 16 }, () => seedJob(db, { status: "NEW" }));
    for (const id of ids) repo.setStatus(id, "APPLIED");
    // A correction, exactly like the one in the real database.
    repo.setStatus(ids[0]!, "REVIEWED");
    repo.setStatus(ids[0]!, "APPLIED");

    const total = bucketByWeek(repo.statusTransitions()).reduce((n, b) => n + b.applications, 0);
    expect(total).toBe(ids.length);
  });
});

describe("the page is self-contained", () => {
  it("requests nothing over the network and runs no script", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED" });
    const html = page(repo);

    // The property that matters is that opening the page fetches nothing and
    // therefore tells nobody it was opened. That is about elements which load
    // on their own - script, link, img, any src, a CSS import or url() - and
    // not about anchors, which are navigation the reader chooses.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("escapes a hostile company name instead of rendering it", () => {
    const { repo, db } = memoryRepo();
    // A job title comes from a third party's API. It is not trusted input.
    seedJob(db, { company: "<img src=x onerror=alert(1)>", status: "APPLIED" });
    const html = page(repo);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("links the posting without letting the URL break out of the attribute", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { company: "Acme", status: "APPLIED" });
    db.prepare("UPDATE jobs SET application_url = ? WHERE id = ?").run(
      'https://boards.example.test/x?a=1&b="><script>alert(1)</script>',
      id,
    );

    const html = page(repo);
    expect(html).toContain('href="https://boards.example.test/x?a=1&amp;b=&quot;&gt;');
    expect(html).not.toContain("<script>alert(1)");
  });
});

describe("Remote OK attribution", () => {
  it("is present when the source is enabled", () => {
    const { repo } = memoryRepo();
    const html = page(repo, sources({ remoteok: true }));
    expect(html).toContain("https://remoteok.com");
    expect(html).toContain("Remote OK is the source");
  });

  it("is present when a displayed job came from Remote OK, even if the source is now off", () => {
    const { repo, db } = memoryRepo();
    db.prepare("UPDATE jobs SET source = 'remoteok' WHERE 1=0").run();
    seedJob(db, { status: "APPLIED" });
    db.prepare("UPDATE jobs SET source = 'remoteok'").run();

    // Turning the source off later does not retract the credit for postings
    // already being shown.
    expect(page(repo, sources({ remoteok: false }))).toContain("Remote OK is the source");
  });

  it("is absent when the source is off and nothing shown came from it", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { status: "APPLIED" });
    expect(page(repo, sources({ remoteok: false }))).not.toContain("remoteok.com");
  });
});
