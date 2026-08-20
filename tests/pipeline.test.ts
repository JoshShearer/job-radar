import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { loadProfile, resetConfigCache, PROJECT_ROOT } from "../src/config/load.js";
import type { CareerProfile } from "../src/config/schema.js";
import { applyFilters } from "../src/pipeline/filters.js";
import { scoreJob, buildCompanyCounts } from "../src/pipeline/score.js";
import { normalizeJob } from "../src/pipeline/normalize.js";
import type { SourceJob } from "../src/sources/types.js";
import type { NormalizedJob } from "../src/model/job.js";

let profile: CareerProfile;

beforeAll(() => {
  resetConfigCache();
  profile = loadProfile(resolve(PROJECT_ROOT, "config", "career-profile.yaml"));
});

function source(over: Partial<SourceJob> = {}): SourceJob {
  return {
    source: "greenhouse",
    ats: "greenhouse",
    externalId: "test:1",
    sourceUrl: "https://example.com/job/1",
    applicationUrl: "https://example.com/job/1/apply",
    company: "Acme",
    title: "Senior Software Engineer",
    locationRaw: "Remote - US",
    datePosted: new Date().toISOString(),
    descriptionHtml: "<p>Build things with TypeScript and React.</p>",
    department: "Engineering",
    team: null,
    salary: null,
    ...over,
  };
}

function make(over: Partial<SourceJob> = {}): NormalizedJob {
  return normalizeJob(source(over), profile);
}

function score(job: NormalizedJob, counts = new Map<string, number>()) {
  const filter = applyFilters(job, profile);
  const result = scoreJob(job, profile, filter, { companyJobCounts: counts });
  return { filter, ...result };
}

// ---- the shipped config is itself under test -------------------------------

describe("career-profile.yaml", () => {
  it("loads and passes coherence validation", () => {
    expect(profile.identity.name).toBeTruthy();
    expect(Object.keys(profile.lanes).length).toBeGreaterThan(0);
  });

  it("has lane weights summing to 1", () => {
    const sum = Object.values(profile.lanes).reduce((a, l) => a + l.weight, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.02);
  });

  it("has ROI weights summing to 1", () => {
    const sum = Object.values(profile.roi.weights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.05);
  });
});

// ---- hard filters ----------------------------------------------------------

describe("applyFilters", () => {
  it("passes a well-matched remote senior role", () => {
    const r = applyFilters(make(), profile);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("rejects a different specialty named in the title", () => {
    const r = applyFilters(make({ title: "Senior iOS Engineer" }), profile);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/different specialty/i);
  });

  it("rejects a junior title", () => {
    const r = applyFilters(make({ title: "Junior Software Engineer" }), profile);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/below senior/i);
  });

  it("rejects onsite outside Austin", () => {
    const r = applyFilters(make({ locationRaw: "New York, NY" }), profile);
    expect(r.passed).toBe(false);
  });

  it("accepts hybrid in Austin", () => {
    const r = applyFilters(make({ locationRaw: "Austin, TX (Hybrid)" }), profile);
    expect(r.passed).toBe(true);
  });

  it("rejects a published range below the hard floor", () => {
    const r = applyFilters(
      make({ descriptionHtml: "<p>The salary range for this role is $90,000 - $110,000 per year.</p>" }),
      profile,
    );
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/below the hard floor/i);
  });

  it("does NOT reject when compensation is unpublished", () => {
    const r = applyFilters(make({ descriptionHtml: "<p>Competitive compensation.</p>" }), profile);
    expect(r.passed).toBe(true);
  });

  it("rejects a clearance requirement", () => {
    const r = applyFilters(
      make({ descriptionHtml: "<p>Applicants must hold an active security clearance.</p>" }),
      profile,
    );
    expect(r.passed).toBe(false);
  });

  it("does NOT reject on an unfamiliar tool in the body, only warns via scoring", () => {
    const r = applyFilters(
      make({ descriptionHtml: "<p>Our platform team uses Kubernetes and Terraform. You will write TypeScript.</p>" }),
      profile,
    );
    expect(r.passed).toBe(true);
  });

  it("warns but does not reject a contract role", () => {
    const r = applyFilters(make({ employmentTypeRaw: "Contract" }), profile);
    expect(r.passed).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/contract/i);
  });

  it("rejects an internship", () => {
    const r = applyFilters(make({ title: "Software Engineering Intern" }), profile);
    expect(r.passed).toBe(false);
  });
});

// ---- scoring ---------------------------------------------------------------

describe("scoreJob", () => {
  it("scores the exact-stack role far above a generic one", () => {
    const exact = make({
      title: "Senior Full Stack Engineer",
      descriptionHtml: `<p>We run a Next.js marketplace on Payload CMS with PostgreSQL and deploy to Vercel.
        You will own technical SEO, programmatic SEO, Core Web Vitals, and our Search Console pipeline.
        Strong TypeScript and React required.</p>`,
    });
    const generic = make({
      title: "Senior Software Engineer",
      descriptionHtml: "<p>Write software. Collaborate with the team. Java and Spring preferred.</p>",
    });

    const e = score(exact);
    const g = score(generic);
    expect(e.score.fitScore).toBeGreaterThan(g.score.fitScore + 25);
  });

  it("fires combination bonuses and names them", () => {
    const job = make({
      title: "Senior Growth Engineer",
      descriptionHtml:
        "<p>Own programmatic SEO across a Next.js site. TypeScript throughout. Run experimentation as an engineer.</p>",
    });
    const r = score(job);
    expect(r.score.combos.length).toBeGreaterThan(0);
    expect(r.score.explanation).toMatch(/COMBO/);
  });

  it("assigns the growth lane to an SEO-heavy role", () => {
    const r = score(
      make({
        title: "Technical SEO Engineer",
        descriptionHtml:
          "<p>Own technical SEO, indexation, sitemaps, hreflang, canonicalization, and Core Web Vitals.</p>",
      }),
    );
    expect(r.score.lane).toBe("growth_seo");
  });

  it("assigns the solutions lane to a pre-sales engineering role", () => {
    const r = score(
      make({
        title: "Senior Solutions Engineer",
        descriptionHtml: `<p>Own technical discovery and pre-sales for enterprise customers. Build
          proof-of-concept integrations against our API in TypeScript. Partner with account management
          through onboarding.</p>`,
      }),
    );
    expect(r.score.lane).toBe("solutions_eng");
  });

  /*
   * The regression this pins is invisible rather than loud: before the
   * solutions_eng lane existed, every Solutions Engineer posting scored in the
   * low 30s - indistinguishable from a paralegal listing - so 1,268 of them sat
   * unanalyzed below the gate while the tool reported the index exhausted. A
   * lane that stops crediting these is a lane that silently stops finding them.
   */
  it("scores a solutions engineering role far above a generic one", () => {
    const solutions = make({
      title: "Senior Solutions Engineer",
      descriptionHtml: `<p>Pre-sales technical discovery, proof of concept builds against our API,
        and customer onboarding. TypeScript and Python. Enterprise customers.</p>`,
    });
    const generic = make({
      title: "Senior Software Engineer",
      descriptionHtml: "<p>Write software. Collaborate with the team. Java and Spring preferred.</p>",
    });
    expect(score(solutions).score.fitScore).toBeGreaterThan(score(generic).score.fitScore + 25);
  });

  /*
   * The title list cannot be the only thing crediting this lane. Real postings
   * name the job a dozen ways - "Principal Presales Engineer", "Partner Success
   * Engineer", "Strategic Solutions Engineer, East" - and an exact-phrase list
   * will always trail the market. The description signals are what catch the
   * ones the list misses, so they get their own test: this title deliberately
   * matches no `target_titles` entry in any lane.
   */
  it("credits a pre-sales role whose title matches no target-title entry", () => {
    const description = `<p>Lead technical discovery with enterprise customers, own the
      proof of concept, and hand off through customer onboarding. This is a customer-facing
      role partnered with account management.</p>`;
    const presales = make({ title: "Principal Presales Engineer", descriptionHtml: description });
    const control = make({ title: "Principal Presales Engineer", descriptionHtml: "<p>Write software.</p>" });

    const titles = Object.values(profile.target_titles).flat();
    expect(titles.some((t) => "principal presales engineer".includes(t.toLowerCase()))).toBe(false);
    expect(score(presales).score.lane).toBe("solutions_eng");
    expect(score(presales).score.fitScore).toBeGreaterThan(score(control).score.fitScore + 15);
  });

  /*
   * `forward deployed engineer` was a target_titles entry, which bought it an
   * unconditional +18. It went 0-for-14 on `apply` recommendations against a
   * 7.8% baseline - the worst band measured. It must still be able to score on
   * real description signal; it must not be promoted on its title alone.
   */
  it("does not hand a forward-deployed title a free bonus", () => {
    const bare = make({
      title: "Forward Deployed Engineer",
      descriptionHtml: "<p>Write software. Collaborate with the team. Java and Spring preferred.</p>",
    });
    const control = make({
      title: "Widget Coordinator",
      descriptionHtml: "<p>Write software. Collaborate with the team. Java and Spring preferred.</p>",
    });
    expect(score(bare).score.fitScore).toBe(score(control).score.fitScore);
  });

  it("assigns the spatial lane to a 3D/proptech role", () => {
    const r = score(
      make({
        title: "Senior 3D Engineer",
        descriptionHtml: "<p>Build digital twin experiences with Three.js and WebGL for proptech and smart buildings.</p>",
      }),
    );
    expect(r.score.lane).toBe("spatial_iot");
  });

  it("explains itself rather than emitting a bare number", () => {
    const r = score(make());
    expect(r.score.explanation).toMatch(/Fit = \d+/);
    expect(r.score.explanation).toMatch(/Strong matches:/);
    expect(r.score.explanation).toMatch(/Weaknesses:/);
  });

  it("penalizes unwanted technologies in the title more than in the body", () => {
    const inTitle = score(make({ title: "Senior Rust Engineer" }));
    const inBody = score(make({ descriptionHtml: "<p>TypeScript role. Some services are written in Rust.</p>" }));
    const titlePenalty = inTitle.score.negativeSignals.find((s) => s.includes("rust"));
    expect(titlePenalty).toBeDefined();
    expect(inBody.score.fitScore).toBeGreaterThan(inTitle.score.fitScore);
  });

  it("ranks a small company above a giant one at equal fit", () => {
    const description = `<p>Next.js, Payload CMS, TypeScript, technical SEO, programmatic SEO, PostgreSQL.</p>`;
    const small = make({ company: "TinyCo", title: "Senior Growth Engineer", descriptionHtml: description });
    const huge = make({ company: "MegaCorp", title: "Senior Growth Engineer", descriptionHtml: description });

    const counts = buildCompanyCounts([
      ...Array.from({ length: 8 }, () => small),
      ...Array.from({ length: 600 }, () => huge),
    ]);

    const s = score(small, counts);
    const h = score(huge, counts);
    expect(s.score.fitScore).toBe(h.score.fitScore); // same match quality
    expect(s.score.applicationRoi).toBeGreaterThan(h.score.applicationRoi); // different ROI
  });

  it("forces priority D on a filtered-out job", () => {
    const r = score(make({ title: "Senior iOS Engineer" }));
    expect(r.score.priority).toBe("D");
  });

  it("gives an unpublished salary a neutral-positive compensation score, not zero", () => {
    const r = score(make({ descriptionHtml: "<p>Competitive compensation and equity.</p>" }));
    expect(r.comp.band).toBe("UNKNOWN");
    expect(r.score.compensationScore).toBeGreaterThan(50);
  });

  it("produces a deterministic result across repeated runs", () => {
    const job = make({
      title: "Senior Growth Engineer",
      descriptionHtml: "<p>Next.js, TypeScript, technical SEO, experimentation.</p>",
    });
    const a = score(job);
    const b = score(job);
    expect(a.score.fitScore).toBe(b.score.fitScore);
    expect(a.score.applicationRoi).toBe(b.score.applicationRoi);
    expect(a.score.lane).toBe(b.score.lane);
  });

  it("keeps scores inside 0-100", () => {
    const extreme = make({
      title: "Senior Founding Full Stack Growth Engineer",
      descriptionHtml: `<p>${[
        "typescript react next.js node.js payload cms postgresql mongodb aws vercel",
        "technical seo programmatic seo core web vitals search console ga4 hreflang",
        "three.js webgl proptech digital twin iot mqtt node-red websocket",
        "llm rag ai agent tool calling evals embeddings stripe marketplace",
      ].join(" ")}</p>`,
    });
    const r = score(extreme);
    expect(r.score.fitScore).toBeLessThanOrEqual(100);
    expect(r.score.fitScore).toBeGreaterThanOrEqual(0);
    expect(r.score.applicationRoi).toBeLessThanOrEqual(100);
  });
});

// ---- normalization ---------------------------------------------------------

describe("normalizeJob", () => {
  it("decodes double-escaped Greenhouse HTML", () => {
    const job = make({
      descriptionHtml: "&amp;lt;p&amp;gt;We use &amp;lt;strong&amp;gt;TypeScript&amp;lt;/strong&amp;gt;.&amp;lt;/p&amp;gt;",
    });
    expect(job.descriptionClean).toContain("TypeScript");
    expect(job.descriptionClean).not.toContain("<p>");
    expect(job.descriptionClean).not.toContain("&lt;");
  });

  it("prefers a provider-supplied plain-text description", () => {
    const job = make({
      descriptionHtml: "<p>html version</p>",
      descriptionPlain: "plain version",
    });
    expect(job.descriptionClean).toBe("plain version");
  });

  it("uses structured salary when the source provides it", () => {
    const job = make({ salary: { min: 180_000, max: 220_000, currency: "USD", period: "year" } });
    expect(job.salaryMin).toBe(180_000);
    expect(job.salaryMax).toBe(220_000);
  });

  it("produces a stable id for the same source + external id", () => {
    expect(make({ externalId: "abc" }).id).toBe(make({ externalId: "abc" }).id);
    expect(make({ externalId: "abc" }).id).not.toBe(make({ externalId: "xyz" }).id);
  });
});
