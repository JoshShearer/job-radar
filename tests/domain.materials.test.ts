import { describe, expect, it } from "vitest";
import { extractNumbers, scopeOf, verifyContext, verifyHeading, verifySegment } from "../src/domain/materials/verify.js";
import { checkPack, composeResume, coverLetterText, answerText } from "../src/domain/materials/compose.js";
import type { PackPlan, ResumePlan } from "../src/domain/materials/plan.js";
import { TEST_EVIDENCE } from "./helpers/context.js";

const ctx = verifyContext(TEST_EVIDENCE, ["Initech", "Senior Frontend Engineer"]);
const kinds = (text: string, cites: string[], owner?: string) =>
  verifySegment(text, cites, ctx, owner ? { expectedOwner: owner } : {}).map((p) => p.kind);

describe("verifier: the overreach the old deny-list let through", () => {
  // Each of these PASSED the old checker (audit 2026-10-13, section 3.2).
  it.each([
    ["Led and mentored a team building a Vue, Svelte and Angular marketplace", ["acme-1"]],
    ["Owned and architected the company-wide payments platform end to end", ["acme-3"]],
    ["Staff engineer and engineering manager with deep distributed-systems and Kafka-scale expertise", ["acme-1"]],
    ["Ran two hundred SEO experiments, increasing revenue by forty percent", ["acme-2"]],
  ])("rejects: %s", (text, cites) => {
    expect(kinds(text, cites).length).toBeGreaterThan(0);
  });

  it("names WHY: scope, technology, figure, qualifier", () => {
    expect(kinds("Led the checkout flow", ["acme-3"])).toContain("scope_inflation");
    expect(kinds("Built a production Vue marketplace", ["acme-1"])).toContain("novel_technology");
    expect(kinds("Designed and ran 500+ measured SEO experiments", ["acme-2"])).toContain("novel_number");
    expect(kinds("Built a company-wide Next.js marketplace", ["acme-1"])).toContain("novel_qualifier");
  });

  it("does not let a skill tagged on ANOTHER claim license a technology here", () => {
    // PostgreSQL is a declared skill (on globex-1), but acme-1 is not evidence for it.
    expect(kinds("Built a production Next.js marketplace on PostgreSQL", ["acme-1"])).toContain("novel_technology");
  });
});

describe("verifier: honest rephrasing passes", () => {
  it.each([
    ["Built a production Next.js marketplace using React and Payload CMS", ["acme-1"]],
    ["Built a production NextJS marketplace", ["acme-1"]],
    ["Designed and ran over two hundred measured SEO experiments", ["acme-2"]],
    ["Designed and ran 200+ SEO experiments to measure organic growth", ["acme-2"]],
    ["Contributed to the checkout flow in TypeScript", ["acme-3"]],
  ])("accepts: %s", (text, cites) => {
    expect(kinds(text, cites)).toEqual([]);
  });
});

describe("verifier: citations", () => {
  it("rejects unknown and unverified claims", () => {
    expect(kinds("Built things", ["nope"])).toContain("unknown_claim");
    expect(kinds("Led a team of four engineers through a platform migration", ["acme-4"])).toContain("unverified_claim");
  });
  it("pins a citation to its owner", () => {
    expect(kinds("Maintained PostgreSQL-backed reporting services", ["globex-1"], "acme")).toContain("wrong_owner");
  });
  it("lets uncited framing describe the target, not the candidate", () => {
    expect(kinds("I'm applying for the Senior Frontend Engineer role at Initech.", [])).toEqual([]);
    expect(kinds("I would love to help build the next chapter of Initech's frontend.", [])).toEqual([]);
    expect(kinds("I built a marketplace that served 2 million users.", [])).toEqual(["uncited_assertion"]);
    expect(kinds("I have deep Kubernetes experience.", [])).toEqual(["uncited_assertion"]);
  });
});

describe("verifier: false refusals observed on a live pack", () => {
  const e = {
    ...TEST_EVIDENCE,
    skills: [...TEST_EVIDENCE.skills, { ...TEST_EVIDENCE.skills[0]!, name: "Payload CMS", aliases: ["PayloadCMS"] }, { ...TEST_EVIDENCE.skills[0]!, name: "GraphQL", aliases: [] }, { ...TEST_EVIDENCE.skills[0]!, name: "Python", aliases: [] }],
  };
  const live = verifyContext(
    {
      ...e,
      experience: [
        ...e.experience,
        {
          id: "ls",
          company: "LoopString",
          title: "Founder",
          start: "2022-01",
          end: null,
          claims: [
            { id: "ls-11", text: "Drove route-based SEO from a PayloadCMS Pages collection over GraphQL.", skills: ["Payload CMS", "GraphQL"], verified: true },
            { id: "ls-12", text: "Owned a custom React front end on a Python API backend over PostgreSQL.", skills: ["React", "Python", "PostgreSQL"], verified: true },
          ],
        },
      ],
    } as typeof TEST_EVIDENCE,
    ["GitLab", "Senior CX Platform Engineer", "Practice Management"],
  );

  it("a spaced spelling of a declared multi-word skill is the same technology", () => {
    expect(verifySegment("I drove route-based rendering from a Payload CMS Pages collection over GraphQL.", ["ls-11"], live)).toEqual([]);
  });
  it("a hyphenated compound is not a new name", () => {
    expect(verifySegment("I did Python-backed engineering on a React platform over PostgreSQL.", ["ls-12"], live)).toEqual([]);
  });
  it("\"won't\" is not the accomplishment \"won\"", () => {
    expect(verifySegment("I'd like to be clear that I won't overstate my fit for this team.", [], live)).toEqual([]);
  });
  it("the posting's own department may be named", () => {
    expect(verifySegment("I'm applying to GitLab's Practice Management team.", [], live)).toEqual([]);
  });
  it("and the real overreach on the same pack is still refused", () => {
    // ls-12 says nothing about GraphQL.
    expect(verifySegment("I owned a React front end over GraphQL APIs.", ["ls-12"], live).length).toBeGreaterThan(0);
    expect(verifySegment("I won an award for this platform.", [], live).length).toBeGreaterThan(0);
  });
});

describe("verifier: holes found by the 2026-10-14 adversarial review", () => {
  const refused = (text: string, cites: string[], c = ctx) => expect(verifySegment(text, cites, c).length, text).toBeGreaterThan(0);
  const passes = (text: string, cites: string[], c = ctx) => expect(verifySegment(text, cites, c), text).toEqual([]);

  it("uncited first-person text may frame interest, never describe the candidate", () => {
    refused("I have worked in fintech for most of my career.", []);
    refused("I currently manage engineers and have been leading platform teams for years.", []);
    refused("I hold a doctorate in physics.", []);
    refused("I am the founding engineer of a marketplace.", []);
    refused("I have been a staff engineer for years.", [], verifyContext(TEST_EVIDENCE, ["Initech", "Staff Engineer"]));
    refused("I'd love to keep leading teams, as I have for years.", []);
    passes("I'm applying for the Senior Frontend Engineer role at Initech.", []);
    passes("I want to be direct about where my background does and doesn't line up with this posting.", []);
    passes("I'd welcome a conversation if the team sees transferable value in that background.", []);
  });

  it("an interest frame does not license a present-tense experience claim", () => {
    // Found by a security review of the PR: these passed behind "I'm excited" / "I'd love".
    refused("I'm excited to apply because I manage a platform group today.", []);
    refused("I'd love to bring what I do now: I lead platform engineering.", []);
    refused("I'm eager to join, as someone who runs infrastructure for a living.", []);
    refused("I'm interested because I currently own the payments stack.", []);
    refused("I want to keep working as a platform engineer.", []);
    refused("I'm applying since I specialize in frontend performance.", []);
    // Interest in the target's work is still fine.
    passes("I'd like to work on the checkout flow at Initech.", []);
    passes("I'm excited about how the team runs its platform.", []);
    passes("I'm interested in a role where a small team owns infrastructure end to end.", []);
  });

  it("the target context names the target; it never licenses a claim inside a cited sentence", () => {
    const k = verifyContext(TEST_EVIDENCE, ["Initech", "Senior Engineer, Kubernetes Platform", "Enterprise Platform"]);
    refused("Contributed to the checkout flow on Kubernetes.", ["acme-3"], k);
    refused("Contributed to the enterprise checkout flow.", ["acme-3"], k);
    refused("As a staff engineer, contributed to the checkout flow.", ["acme-3"], verifyContext(TEST_EVIDENCE, ["Initech", "Staff Engineer"]));
    passes("Contributed to the checkout flow, work I'd bring to Initech.", ["acme-3"], k);
  });

  it("a name at the start of a sentence, after a semicolon, or after e.g. is still a name", () => {
    refused("Contributed to the checkout flow; Google adopted it.", ["acme-3"]);
    refused("Contributed to the checkout flow for clients, e.g. Walmart.", ["acme-3"]);
    refused("Google partners used the checkout flow I contributed to.", ["acme-3"]);
    refused("Contributed to the checkout flow at eBay.", ["acme-3"]);
    expect(verifyHeading("Payments Platform", ["React"], ctx).length).toBeGreaterThan(0);
    passes("Earlier in my career I designed and ran 200+ measured SEO experiments.", ["acme-2"]);
    passes("Designed and ran more than 200 measured SEO experiments.", ["acme-2"]);
  });

  it("a figure keeps its unit, and vague quantities are quantities", () => {
    refused("Designed and ran 200x more SEO experiments.", ["acme-2"]);
    refused("Designed SEO experiments that cut load time in half.", ["acme-2"]);
    refused("Designed SEO experiments used by thousands of customers.", ["acme-2"]);
    refused("Designed SEO experiments across dozens of storefronts.", ["acme-2"]);
  });

  it("oversight and sole-ownership words are scope", () => {
    refused("Oversaw the checkout flow.", ["acme-3"]);
    refused("Single-handedly contributed the checkout flow.", ["acme-3"]);
    refused("Coordinated the checkout flow.", ["acme-3"]);
  });
});

describe("verifier: skill-group headings", () => {
  // Observed live: every Title Case heading word read as a name, so all five
  // groups of a real tailored resume were relabelled "Skills".
  it.each([
    ["Languages & APIs", ["TypeScript", "Node.js"]],
    ["Application Development", ["React", "Next.js"]],
    ["Cloud, Delivery & Data", ["PostgreSQL"]],
    ["Integration & Automation", ["Node.js"]],
    ["Engineering Practice", ["SEO"]],
    ["Frontend", ["React", "Next.js"]],
  ])("a generic heading passes: %s", (label, skills) => {
    expect(verifyHeading(label, skills, ctx)).toEqual([]);
  });

  it.each([
    ["Leadership & Strategy", ["TypeScript"]],
    ["Enterprise Platforms", ["TypeScript"]],
    ["Kubernetes & Cloud", ["TypeScript"]],
    ["Google Cloud Tools", ["PostgreSQL"]],
    ["AI & Machine Learning", ["React"]],
    ["10 Years of Frontend", ["React"]],
  ])("a heading that asserts something is refused: %s", (label, skills) => {
    expect(verifyHeading(label, skills, ctx).length).toBeGreaterThan(0);
  });

  it("a technology in the heading is fine when the group lists it", () => {
    expect(verifyHeading("React & Next.js", ["React", "Next.js"], ctx)).toEqual([]);
  });
});

describe("number extraction", () => {
  it("reads digits and words, and does not merge separate phrases", () => {
    expect([...extractNumbers("two hundred and fifty, a dozen, one of the first, 1.2M, 40%, 3x")].sort()).toEqual(
      // A figure with a unit is also recorded with it, so "200+" never licenses "200x".
      ["1200000", "12", "250", "3", "3x", "40", "40%"].sort(),
    );
    expect([...extractNumbers("2 million users")]).toEqual(["2000000"]);
  });
  it("detects scope", () => {
    expect(scopeOf("Contributed to the checkout flow")).toBe("contributed");
    expect(scopeOf("Architected the platform")).toBe("owned");
    expect(scopeOf("Mentored three engineers")).toBe("led");
  });
});

describe("composeResume", () => {
  const plan = (over: Partial<ResumePlan> = {}): ResumePlan => ({
    positioning: "full-stack",
    headlineId: "h-full",
    summaryId: "s-main",
    skillGroups: [{ label: "Frontend", skills: ["React", "Next.js", "Kubernetes"] }],
    roles: [
      {
        roleId: "acme",
        claims: [
          { claimId: "acme-1", rewrite: "Built a production NextJS marketplace" },
          { claimId: "acme-2", rewrite: "Designed and ran 900 SEO experiments" },
          { claimId: "globex-1", rewrite: null },
          { claimId: "acme-4", rewrite: null },
        ],
      },
    ],
    projects: [],
    omitted: [],
    gapsToExpect: [],
    doNotClaim: [],
    ...over,
  });

  it("repairs instead of trusting: wrong owner and unverified dropped, overreach reverted, undeclared skill dropped", () => {
    const { resume, repairs } = composeResume(TEST_EVIDENCE, plan(), ctx);
    const bullets = resume.roles[0]!.bullets;
    expect(bullets).toEqual(["Built a production NextJS marketplace", "Designed and ran 200+ measured SEO experiments"]);
    expect(resume.skillGroups[0]!.skills).toEqual(["React", "Next.js"]);
    expect(repairs.map((r) => r.action).sort()).toEqual(["dropped", "dropped", "dropped", "reverted"].sort());
    expect(resume.cited).toEqual(["acme-1", "acme-2"]);
  });

  it("never writes a headline or summary: unknown ids fall back to the candidate's own variant", () => {
    const { resume, repairs } = composeResume(TEST_EVIDENCE, plan({ headlineId: "made-up", summaryId: "s-main" }), ctx);
    expect(resume.headline).toBe("Senior full-stack engineer (TypeScript, React, Next.js)");
    expect(repairs.some((r) => r.where === "headline" && r.action === "defaulted")).toBe(true);
  });

  it("replaces a skill-group label that asserts something", () => {
    const { resume } = composeResume(TEST_EVIDENCE, plan({ skillGroups: [{ label: "10 years of React", skills: ["React"] }] }), ctx);
    expect(resume.skillGroups[0]!.label).toBe("Skills");
  });
});

describe("checkPack", () => {
  const pack: PackPlan = {
    positioning: "x",
    coverLetter: [
      [
        { text: "I'm applying for the Senior Frontend Engineer role at Initech.", cites: [] },
        { text: "I built a production Next.js marketplace with Payload CMS.", cites: ["acme-1"] },
        { text: "I led a twelve-person team.", cites: ["acme-3"] },
      ],
    ],
    formAnswers: [
      { question: "Why this role?", sentences: [{ text: "I designed and ran 200+ measured SEO experiments.", cites: ["acme-2"] }] },
      { question: "Tell us about leadership", sentences: [{ text: "I managed a large team at Globex.", cites: ["globex-1"] }] },
    ],
    doNotClaim: ["Kubernetes"],
    decideFirst: [],
  };

  it("removes refused sentences and refuses partial answers", () => {
    const c = checkPack(pack, ctx);
    expect(c.rejectedCount).toBe(2);
    expect(coverLetterText(c)).not.toContain("twelve");
    expect(coverLetterText(c)).toContain("Next.js marketplace");
    expect(answerText(c.formAnswers[0]!)).toContain("200+");
    expect(answerText(c.formAnswers[1]!)).toBeNull();
  });
});
