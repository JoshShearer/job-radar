import type { CareerProfile } from "../config/schema.js";
import type { Resume } from "./schema.js";
import { ResumeSchema } from "./schema.js";

/**
 * Scaffold a master resume from what the repo already knows for certain.
 *
 * Seeded from two sources and nothing else:
 *  - `career-profile.yaml` signals, which are the skill vocabulary already
 *    tuned by hand, so retyping them here would be busywork.
 *  - The accomplishments the candidate stated when specifying this project.
 *
 * Employment history is NOT seeded, because nothing in this repo knows it.
 * The scaffold leaves a placeholder role that fails `resume lint` on purpose:
 * a loud error is better than a plausible-looking blank that quietly produces
 * an empty resume.
 */

const SKILL_CATEGORIES: ReadonlyArray<readonly [string, RegExp]> = [
  ["Languages", /^(typescript|javascript|python|sql|bash|c\+\+|go|rust)$/],
  ["Frontend", /(react|next\.?js|three\.?js|webgl|tailwind|css|html|react native|spa)/],
  ["Backend", /(node|express|payload|graphql|rest|api|websocket|mqtt|postgres|mongo|sqlite|redis)/],
  ["Infrastructure", /(aws|vercel|cloudfront|firebase|ci\/cd|docker|linux|edge)/],
  ["Growth engineering", /(seo|geo|aeo|schema|structured data|search console|ga4|core web vitals|crawl|sitemap|indexation|canonical|hreflang|programmatic)/],
  ["AI", /(llm|agent|rag|embedding|prompt|openai|anthropic|claude|ai)/],
  ["IoT and hardware", /(iot|node-red|automation|controls|plc|sensor|firmware|embedded)/],
];

function categorize(term: string): string {
  for (const [label, re] of SKILL_CATEGORIES) if (re.test(term.toLowerCase())) return label;
  return "Other";
}

/** Aliases a posting might use for a term. Spelling should not decide a match. */
function aliasesFor(term: string): string[] {
  const out = new Set<string>();
  const t = term.toLowerCase();
  if (t.includes(".")) out.add(t.replace(/\./g, ""));
  if (t.includes(" ")) out.add(t.replace(/\s+/g, ""));
  if (t.includes("-")) out.add(t.replace(/-/g, " "));
  if (t === "next.js") ["nextjs", "next js"].forEach((a) => out.add(a));
  if (t === "node.js") ["nodejs", "node"].forEach((a) => out.add(a));
  if (t === "postgresql") ["postgres", "psql"].forEach((a) => out.add(a));
  if (t === "seo") out.add("search engine optimization");
  out.delete(t);
  return [...out];
}

/** Accomplishments the candidate stated directly. Real, but undated. */
const STATED_PROJECTS = [
  {
    id: "proj-shroomspy",
    name: "ShroomSpy",
    context: "Production marketplace built on Next.js and Payload CMS, operated solo.",
    bullets: [
      { id: "b-shroomspy-build", text: "Built and operate a production Next.js + Payload CMS marketplace.", skills: ["Next.js", "Payload CMS", "TypeScript", "React"] },
      { id: "b-shroomspy-experiments", text: "Designed and ran 200+ measured SEO experiments.", skills: ["technical SEO", "SEO experimentation"] },
      { id: "b-shroomspy-pipeline", text: "Built automated SEO data ingestion from Search Console, GA4, and CrUX/PageSpeed.", skills: ["Google Search Console", "GA4", "Core Web Vitals", "Python"] },
      { id: "b-shroomspy-psesq", text: "Built 35+ programmatic SEO landing pages.", skills: ["programmatic SEO", "Next.js"] },
      { id: "b-shroomspy-diagnostics", text: "Built custom indexing and technical SEO diagnostics.", skills: ["technical SEO", "crawlability"] },
    ],
  },
  {
    id: "proj-loopstring",
    name: "LoopString",
    context: "Automation and IoT platform connecting cloud applications to Linux edge devices.",
    bullets: [
      { id: "b-loopstring-platform", text: "Built an automation and IoT platform.", skills: ["IoT", "Node.js", "TypeScript"] },
      { id: "b-loopstring-edge", text: "Built TypeScript/React/Node systems connecting cloud applications to Linux edge devices.", skills: ["TypeScript", "React", "Node.js", "MQTT", "Linux"] },
    ],
  },
  {
    id: "proj-proptech",
    name: "AI 3D proptech platform",
    context: "Lead Application Platform Developer on an AI-driven 3D real-estate platform.",
    bullets: [
      { id: "b-proptech-lead", text: "Served as Lead Application Platform Developer on an AI-driven 3D real-estate platform.", skills: ["React", "TypeScript"] },
      { id: "b-proptech-webgl", text: "Integrated Three.js/WebGL with React applications.", skills: ["Three.js", "WebGL", "React"] },
    ],
  },
] as const;

export function scaffoldResume(profile: CareerProfile, location: string): Resume {
  const terms = new Map<string, number>();
  for (const s of profile.signals) {
    if (s.weight <= 0) continue;
    const prior = terms.get(s.term) ?? 0;
    if (s.weight > prior) terms.set(s.term, s.weight);
  }

  const skills = [...terms.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term, weight]) => ({
      name: term,
      aliases: aliasesFor(term),
      level: weight >= 8 ? ("expert" as const) : weight >= 5 ? ("strong" as const) : ("working" as const),
      years: null,
      category: categorize(term),
    }));

  const declared = new Set(skills.map((s) => s.name.toLowerCase()));
  const projects = STATED_PROJECTS.map((p) => ({
    id: p.id,
    name: p.name,
    url: "",
    context: p.context,
    start: null,
    end: null,
    // Only keep skill tags that exist in the skills list, or lint will error.
    bullets: p.bullets.map((b) => ({
      id: b.id,
      text: b.text,
      skills: b.skills.filter((s) => declared.has(s.toLowerCase())),
      lanes: [],
      verified: true,
    })),
  }));

  return ResumeSchema.parse({
    basics: {
      name: profile.identity.name,
      headline: profile.identity.headline,
      location,
      summary: "",
    },
    skills,
    experience: [
      {
        id: "role-TODO-1",
        company: "TODO company name",
        title: "TODO job title",
        start: "2020-01",
        end: null,
        location: "TODO",
        context: "TODO one line on what this company does",
        employment_type: "full_time",
        bullets: [
          {
            id: "b-TODO-1",
            text: "TODO replace with something you actually did, one claim per bullet",
            skills: [],
            lanes: [],
            verified: false,
          },
        ],
      },
    ],
    projects,
    education: [
      { id: "edu-1", school: "TODO school", credential: "BS Electrical Engineering", year: "" },
    ],
    certifications: [],
  });
}
