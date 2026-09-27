import { describe, it, expect } from "vitest";
import { ResumeSchema, lintResume, allBullets, monthsBetween } from "../src/resume/schema.js";
import { extractRequirements, skillsMentioned, matchResumeToJob, careerYears, yearsDemanded } from "../src/resume/requirements.js";
import { checkRewrite, checkSelection, buildVocabulary } from "../src/resume/provenance.js";
import type { TailorPlan } from "../src/resume/tailor.js";
import { composeResume, enforceProvenance } from "../src/resume/render.js";
import { canonicalSkill, containsSkill, extractNumericClaims } from "../src/lib/text.js";

const resume = ResumeSchema.parse({
  basics: { name: "Ada Lovelace", headline: "Senior engineer", summary: "Builds things." },
  skills: [
    { name: "TypeScript", aliases: ["TS"] },
    { name: "Next.js", aliases: ["NextJS", "Next JS"] },
    { name: "Node.js", aliases: ["nodejs", "node"] },
    { name: "technical SEO", aliases: ["SEO"] },
    { name: "PostgreSQL", aliases: ["postgres"] },
  ],
  experience: [
    {
      id: "role-acme",
      company: "Acme",
      title: "Senior Engineer",
      start: "2021-03",
      end: null,
      bullets: [
        { id: "b-acme-1", text: "Built a Next.js storefront serving 200+ pages.", skills: ["Next.js", "TypeScript"] },
        { id: "b-acme-2", text: "Ran technical SEO audits across the catalog.", skills: ["technical SEO"] },
        { id: "b-acme-3", text: "Unconfirmed thing that happened.", skills: ["Node.js"], verified: false },
      ],
    },
    {
      id: "role-old",
      company: "Oldco",
      title: "Engineer",
      start: "2018-01",
      end: "2020-06",
      bullets: [{ id: "b-old-1", text: "Maintained a PostgreSQL reporting pipeline.", skills: ["PostgreSQL"] }],
    },
  ],
  projects: [],
  education: [],
});

describe("text helpers", () => {
  it("canonicalizes spellings so a posting's style cannot change the answer", () => {
    expect(canonicalSkill("Next.js")).toBe("nextjs");
    expect(canonicalSkill("Node-RED")).toBe("nodered");
    expect(canonicalSkill("C++")).toBe("c++");
  });

  it("matches whole tokens only", () => {
    expect(containsSkill("we use react heavily", "react")).toBe(true);
    // "react" inside "reactive" is not a React requirement.
    expect(containsSkill("reactive streams experience", "react")).toBe(false);
  });

  it("handles symbol-terminated skills that \\b cannot", () => {
    expect(containsSkill("strong c++ background", "c++")).toBe(true);
    expect(containsSkill("strong c background", "c++")).toBe(false);
  });

  it("extracts numeric claims but ignores bare years", () => {
    const claims = extractNumericClaims("Grew traffic 40% across 200+ pages since 2021");
    expect(claims).toContain("40%");
    expect(claims).toContain("200+");
    expect(claims).not.toContain("2021");
  });
});

describe("requirement extraction", () => {
  const jd = `
About the role

We are hiring an engineer.

Requirements
- 5+ years building production web applications
- Strong TypeScript and React experience
- Experience with Next.js

Nice to have
- Rust experience
- Familiarity with Kubernetes

Benefits
- Health insurance
- Unlimited PTO
`;

  it("separates required from preferred", () => {
    const reqs = extractRequirements(jd);
    const required = reqs.filter((r) => r.weight === "required").map((r) => r.text);
    const preferred = reqs.filter((r) => r.weight === "preferred").map((r) => r.text);

    expect(required).toContain("Strong TypeScript and React experience");
    expect(preferred).toContain("Rust experience");
  });

  it("stops at the benefits section", () => {
    const texts = extractRequirements(jd).map((r) => r.text);
    expect(texts).not.toContain("Health insurance");
    expect(texts).not.toContain("Unlimited PTO");
  });

  it("does not treat a long sentence containing heading words as a heading", () => {
    const reqs = extractRequirements(
      "Requirements\n- Ship code\n\nYou should have a deep understanding of distributed systems and be able to explain tradeoffs clearly to a non-technical audience across many teams\n",
    );
    // The long line is not a heading, and is too long to be a requirement line.
    expect(reqs.map((r) => r.text)).toEqual(["Ship code"]);
  });

  it("is deterministic", () => {
    expect(extractRequirements(jd)).toEqual(extractRequirements(jd));
  });
});

describe("skill matching", () => {
  it("matches aliases regardless of the posting's spelling", () => {
    expect(skillsMentioned("Experience with NextJS", resume.skills).map((h) => h.skill)).toContain("Next.js");
    expect(skillsMentioned("Experience with Next JS", resume.skills).map((h) => h.skill)).toContain("Next.js");
    expect(skillsMentioned("Experience with next.js", resume.skills).map((h) => h.skill)).toContain("Next.js");
  });

  it("does not match a skill that is not mentioned", () => {
    expect(skillsMentioned("Experience with Rust", resume.skills)).toHaveLength(0);
  });
});

describe("matchResumeToJob", () => {
  const bullets = allBullets(resume).map((b) => ({ bullet: b.bullet, sourceLabel: b.sourceLabel }));

  it("counts a requirement as covered only when a bullet evidences it", () => {
    const jd = "Requirements\n- Strong Next.js experience\n- Deep PostgreSQL tuning\n";
    const report = matchResumeToJob(resume, jd, bullets);
    const next = report.matches.find((m) => m.requirement.text.includes("Next.js"));
    expect(next?.covered).toBe(true);
    expect(next?.evidence.map((e) => e.bulletId)).toContain("b-acme-1");
  });

  it("names a skill but reports a gap when no bullet is tagged with it", () => {
    // The resume claims the skill in `skills` but has no evidence bullet.
    const thin = ResumeSchema.parse({
      basics: { name: "Ada" },
      skills: [{ name: "Kubernetes" }],
      experience: [{ id: "r1", company: "A", title: "Eng", start: "2020-01", bullets: [] }],
    });
    const report = matchResumeToJob(thin, "Requirements\n- Kubernetes at scale\n", []);
    expect(report.matches[0]?.covered).toBe(false);
    expect(report.requiredCoverage).toBe(0);
  });

  it("never uses an unverified bullet as evidence", () => {
    const jd = "Requirements\n- Node.js services\n";
    const report = matchResumeToJob(resume, jd, bullets);
    // b-acme-3 is the only Node.js bullet and it is verified: false.
    expect(report.matches[0]?.evidence).toHaveLength(0);
    expect(report.matches[0]?.covered).toBe(false);
  });

  it("does not treat owning a technology as evidence of leading with it", () => {
    // The real failure from the Vercel posting: "leading frontend migrations"
    // names Next.js, so every Next.js bullet looked like evidence.
    const jd =
      "Requirements\n- Demonstrated experience leading frontend migrations, modernizing legacy applications to Next.js\n";
    const report = matchResumeToJob(resume, jd, bullets);
    expect(report.matches[0]?.status).toBe("partial");
    expect(report.matches[0]?.unmet.join(" ")).toMatch(/leadership|migration/);
    expect(report.requiredCoverage).toBe(0);
  });

  it("does not treat using a library as contributing to it", () => {
    // This one matters most: OSS contribution is on the do-not-claim list.
    const jd = "Requirements\n- Have contributed to the Next.js or React open-source projects\n";
    const report = matchResumeToJob(resume, jd, bullets);
    expect(report.matches[0]?.status).toBe("partial");
    expect(report.matches[0]?.unmet.join(" ")).toContain("open source");
  });

  it("still marks a plain technology requirement as covered", () => {
    const report = matchResumeToJob(resume, "Requirements\n- Strong Next.js experience\n", bullets);
    expect(report.matches[0]?.status).toBe("covered");
  });

  it("checks a years threshold against the career span, not against a bullet", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    // resume spans 2018-01 to now => ~8.6 years
    const ok = matchResumeToJob(resume, "Requirements\n- 5+ years of TypeScript\n", bullets, now);
    expect(ok.matches[0]?.status).toBe("covered");

    const tooMany = matchResumeToJob(resume, "Requirements\n- 15+ years of TypeScript\n", bullets, now);
    expect(tooMany.matches[0]?.status).toBe("partial");
    expect(tooMany.matches[0]?.unmet.join(" ")).toContain("15+ years");
  });

  it("lists posting technologies the resume never claims", () => {
    const report = matchResumeToJob(resume, "Requirements\n- Rust and Kubernetes\n", bullets);
    expect(report.unclaimedTerms).toEqual(expect.arrayContaining(["rust", "kubernetes"]));
  });
});

describe("provenance", () => {
  const vocab = buildVocabulary(resume);

  it("accepts a rephrasing that changes wording but not substance", () => {
    const v = checkRewrite(
      "b-acme-1",
      "Built a Next.js storefront serving 200+ pages.",
      "Shipped a Next.js storefront covering 200+ pages.",
      vocab,
    );
    expect(v).toHaveLength(0);
  });

  it("rejects a rewrite that introduces a technology", () => {
    // The classic tailoring failure: the posting wants Kubernetes, so it
    // appears in the bullet.
    const v = checkRewrite(
      "b-acme-1",
      "Built a Next.js storefront serving 200+ pages.",
      "Built a Next.js storefront on Kubernetes serving 200+ pages.",
      vocab,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("invented_skill");
  });

  it("allows a technology the candidate genuinely claims elsewhere", () => {
    const v = checkRewrite(
      "b-acme-1",
      "Built a storefront serving 200+ pages.",
      "Built a TypeScript storefront serving 200+ pages.",
      vocab,
    );
    expect(v).toHaveLength(0);
  });

  it("rejects an inflated metric", () => {
    const v = checkRewrite(
      "b-acme-1",
      "Built a Next.js storefront serving 200+ pages.",
      "Built a Next.js storefront serving 500+ pages.",
      vocab,
    );
    expect(v.some((x) => x.kind === "invented_metric")).toBe(true);
  });

  it("rejects a metric appearing where there was none", () => {
    const v = checkRewrite("b-acme-2", "Ran technical SEO audits across the catalog.", "Ran technical SEO audits that grew organic traffic 40%.", vocab);
    expect(v.some((x) => x.kind === "invented_metric")).toBe(true);
  });

  it("allows dropping a metric", () => {
    const v = checkRewrite("b-acme-1", "Built a Next.js storefront serving 200+ pages.", "Built a Next.js storefront.", vocab);
    expect(v).toHaveLength(0);
  });

  it("rejects citations to bullets that do not exist or are unverified", () => {
    const v = checkSelection(resume, ["b-acme-1", "b-nope", "b-acme-3"]);
    expect(v.map((x) => x.kind)).toEqual(["unknown_bullet", "unverified_bullet"]);
  });

  it("rejects a real, verified bullet cited under a role it does not belong to", () => {
    // "b-old-1" exists and is verified, but it is Oldco's bullet, not Acme's.
    const v = checkSelection(resume, ["b-acme-1", "b-old-1"], "role-acme");
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("wrong_role");
    expect(v[0]?.bulletId).toBe("b-old-1");
  });

  it("does not flag wrong_role when no expected owner is given", () => {
    expect(checkSelection(resume, ["b-old-1"])).toHaveLength(0);
  });
});

describe("enforceProvenance repairs a plan rather than failing", () => {
  const plan = (): TailorPlan => ({
    positioning: "p",
    headline: "Senior Engineer",
    summary: "s",
    skillGroups: [{ label: "Core", skills: ["TypeScript", "Kubernetes"] }],
    roles: [
      {
        roleId: "role-acme",
        bulletIds: ["b-acme-1", "b-acme-3", "b-ghost"],
        rewrites: [
          { bulletId: "b-acme-1", text: "Built a Next.js storefront on Kubernetes serving 200+ pages." },
        ],
      },
      { roleId: "role-ghost", bulletIds: [], rewrites: [] },
    ],
    projectIds: ["proj-ghost"],
    omitted: [],
    gapsToExpect: [],
    doNotClaim: [],
  });

  it("drops unknown roles, unknown and unverified bullets, and undeclared skills", () => {
    const p = plan();
    const { violations } = enforceProvenance(resume, p);

    expect(p.roles.map((r) => r.roleId)).toEqual(["role-acme"]);
    expect(p.roles[0]?.bulletIds).toEqual(["b-acme-1"]);
    expect(p.projectIds).toEqual([]);
    expect(p.skillGroups[0]?.skills).toEqual(["TypeScript"]);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("reverts a bad rewrite so the master wording is used instead", () => {
    const p = plan();
    const { reverted } = enforceProvenance(resume, p);
    expect(reverted).toContain("b-acme-1");
    expect(p.roles[0]?.rewrites).toHaveLength(0);

    // Composition then falls back to the true text, not the invented one.
    const { composed } = composeResume(resume, p);
    expect(composed.roles[0]?.bullets[0]).toBe("Built a Next.js storefront serving 200+ pages.");
  });

  it("reverts an invented headline or summary to the master wording", () => {
    // Regression for JOB-46: enforceProvenance used to check only bulletIds
    // and rewrites, never the plan's free-text headline/summary, so a model
    // could invent a technology or figure there and have it render as-is.
    const p = plan();
    p.headline = "Senior Kubernetes Engineer"; // "Kubernetes" is not master vocabulary
    p.summary = "Shipped 500+ production releases."; // no such figure in the master resume
    const { violations, reverted } = enforceProvenance(resume, p);

    expect(reverted).toContain("basics.headline");
    expect(reverted).toContain("basics.summary");
    expect(p.headline).toBe(resume.basics.headline);
    expect(p.summary).toBe(resume.basics.summary);
    expect(violations.some((v) => v.kind === "invented_skill")).toBe(true);
    expect(violations.some((v) => v.kind === "invented_metric")).toBe(true);
  });

  it("does not revert a headline/summary rewrite that stays evidenced", () => {
    const p = plan();
    p.headline = "Senior TypeScript Engineer"; // TypeScript is genuinely claimed
    p.summary = "Builds Next.js products.";
    const { reverted } = enforceProvenance(resume, p);
    expect(reverted).not.toContain("basics.headline");
    expect(reverted).not.toContain("basics.summary");
    expect(p.headline).toBe("Senior TypeScript Engineer");
    expect(p.summary).toBe("Builds Next.js products.");
  });

  it("drops a citation to a real, verified bullet cited under the wrong role", () => {
    // Regression for JOB-46: a plan citing role B's verified bullet id under
    // role A used to render fine, because composeResume resolved bullet ids
    // through a single global map built from every role's bullets combined.
    // "b-old-1" is real and verified, but it belongs to role-old, not role-acme.
    const p = plan();
    p.roles[0]!.bulletIds = ["b-acme-1", "b-old-1"];
    const { violations } = enforceProvenance(resume, p);

    expect(violations.some((v) => v.kind === "wrong_role" && v.bulletId === "b-old-1")).toBe(true);
    expect(p.roles[0]?.bulletIds).not.toContain("b-old-1");

    const { composed } = composeResume(resume, p);
    const acmeRole = composed.roles.find((r) => r.company === "Acme");
    expect(acmeRole?.bullets).not.toContain("Maintained a PostgreSQL reporting pipeline.");
  });
});

describe("composeResume", () => {
  it("orders roles reverse-chronologically regardless of plan order", () => {
    const p: TailorPlan = {
      positioning: "", headline: "H", summary: "S", skillGroups: [],
      roles: [
        { roleId: "role-old", bulletIds: ["b-old-1"], rewrites: [] },
        { roleId: "role-acme", bulletIds: ["b-acme-1"], rewrites: [] },
      ],
      projectIds: [], omitted: [], gapsToExpect: [], doNotClaim: [],
    };
    const { composed } = composeResume(resume, p);
    expect(composed.roles.map((r) => r.company)).toEqual(["Acme", "Oldco"]);
  });

  it("drops a role whose bullets were all rejected", () => {
    const p: TailorPlan = {
      positioning: "", headline: "H", summary: "S", skillGroups: [],
      roles: [{ roleId: "role-acme", bulletIds: [], rewrites: [] }],
      projectIds: [], omitted: [], gapsToExpect: [], doNotClaim: [],
    };
    expect(composeResume(resume, p).composed.roles).toHaveLength(0);
  });

  it("resolves each role's bullets from that role's own list, never a global index", () => {
    // Structural second gate, independent of enforcement: composeResume
    // builds a per-role bullet map, so `role-acme`'s bulletIds can only ever
    // resolve to bullets `role-acme` itself owns. Cross-referencing "b-old-1"
    // (real, verified, but belongs to role-old) under role-acme structurally
    // cannot resolve, even setting aside that enforcement would also strip it.
    const p: TailorPlan = {
      positioning: "", headline: "H", summary: "S", skillGroups: [],
      roles: [{ roleId: "role-acme", bulletIds: ["b-acme-1", "b-old-1"], rewrites: [] }],
      projectIds: [], omitted: [], gapsToExpect: [], doNotClaim: [],
    };
    const { composed } = composeResume(resume, p);
    const acmeRole = composed.roles.find((r) => r.company === "Acme");
    expect(acmeRole?.bullets).toEqual(["Built a Next.js storefront serving 200+ pages."]);
  });
});

describe("lintResume", () => {
  it("passes a clean resume", () => {
    expect(lintResume(resume).filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("catches duplicate ids, which would silently break provenance", () => {
    const dup = ResumeSchema.parse({
      basics: { name: "A" },
      skills: [{ name: "TypeScript" }],
      experience: [
        { id: "r1", company: "A", title: "E", start: "2020-01", bullets: [{ id: "b1", text: "Did a thing here.", skills: ["TypeScript"] }] },
        { id: "r2", company: "B", title: "E", start: "2021-01", bullets: [{ id: "b1", text: "Did another thing.", skills: ["TypeScript"] }] },
      ],
    });
    expect(lintResume(dup).some((i) => i.level === "error" && i.message.includes("duplicate id"))).toBe(true);
  });

  it("catches a skill tag that is not declared", () => {
    const bad = ResumeSchema.parse({
      basics: { name: "A" },
      skills: [{ name: "TypeScript" }],
      experience: [{ id: "r1", company: "A", title: "E", start: "2020-01", bullets: [{ id: "b1", text: "Shipped a Rust service.", skills: ["Rust"] }] }],
    });
    expect(bad && lintResume(bad).some((i) => i.level === "error" && i.message.includes("not declared"))).toBe(true);
  });

  it("catches leftover scaffold placeholders", () => {
    const bad = ResumeSchema.parse({
      basics: { name: "A" },
      skills: [],
      experience: [{ id: "r1", company: "A", title: "E", start: "2020-01", bullets: [{ id: "b1", text: "TODO replace with something real", skills: [] }] }],
    });
    expect(lintResume(bad).some((i) => i.message.includes("placeholder"))).toBe(true);
  });

  it("does not mistake a component or type name for a placeholder", () => {
    // Real bullets contain JSX and generics. An earlier case-insensitive rule
    // flagged "<ComparisonPage>" and blocked a valid resume.
    const ok = ResumeSchema.parse({
      basics: { name: "A" },
      skills: [{ name: "React" }],
      experience: [
        {
          id: "r1", company: "A", title: "E", start: "2020-01",
          bullets: [
            { id: "b1", text: "Built 35+ landing pages from shared <ComparisonPage> scaffolding.", skills: ["React"] },
            { id: "b2", text: "Typed the payloads as Array<string> end to end.", skills: ["React"] },
            { id: "b3", text: "Rendered a <div> per row without a key warning.", skills: ["React"] },
          ],
        },
      ],
    });
    expect(lintResume(ok).filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("still catches a real angle-bracket placeholder", () => {
    const bad = ResumeSchema.parse({
      basics: { name: "A" },
      skills: [{ name: "React" }],
      experience: [{ id: "r1", company: "A", title: "E", start: "2020-01", bullets: [{ id: "b1", text: "Worked at <company name> doing things.", skills: ["React"] }] }],
    });
    expect(bad && lintResume(bad).some((i) => i.message.includes("placeholder"))).toBe(true);
  });

  it("errors when there is no employment history at all", () => {
    const empty = ResumeSchema.parse({ basics: { name: "A" }, skills: [], experience: [] });
    expect(lintResume(empty).some((i) => i.level === "error" && i.where === "experience")).toBe(true);
  });

  it("flags an employment gap without treating it as an error", () => {
    const gap = lintResume(resume).find((i) => i.message.includes("gap"));
    // Oldco ends 2020-06, Acme starts 2021-03 => 9 months.
    expect(gap?.level).toBe("warning");
    expect(gap?.message).toContain("9-month gap");
  });
});

describe("careerYears", () => {
  it("spans earliest start to latest end", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(careerYears([{ start: "2018-01", end: "2020-06" }, { start: "2021-03", end: null }], now)).toBe(8.6);
  });

  it("is zero with no roles", () => {
    expect(careerYears([])).toBe(0);
  });
});

describe("yearsDemanded", () => {
  it.each([
    ["5+ years building web apps", 5],
    ["At least 10 years of experience", 10],
    ["3 or more years in a senior role", 3],
    ["Strong TypeScript skills", null],
  ])("reads %s", (text, expected) => {
    expect(yearsDemanded(text as string)).toBe(expected);
  });
});

describe("monthsBetween", () => {
  it("counts across a year boundary", () => {
    expect(monthsBetween("2020-06", "2021-03")).toBe(9);
  });
});
