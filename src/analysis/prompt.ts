import type { CareerProfile } from "../config/schema.js";
import type { EnrichedJob } from "../model/job.js";
import { formatSalary } from "../lib/salary.js";
import { truncateWords } from "../lib/html.js";

/** Description budget per job. Enough to judge fit, small enough to be cheap. */
export const DESCRIPTION_CHAR_BUDGET = 7000;

/**
 * The system prompt is deliberately stable across every job in a run so it can
 * be prompt-cached: it is the largest part of the request and it does not vary,
 * which is exactly the shape caching wants. Anything job-specific goes in the
 * user turn, after the cache breakpoint.
 */
export function buildSystemPrompt(profile: CareerProfile): string {
  const c = profile.compensation;
  const lanes = Object.entries(profile.lanes)
    .map(([key, l]) => `  - ${key}: ${l.label} (search priority ${Math.round(l.weight * 100)}%)`)
    .join("\n");

  return `You are a job-fit analyst working for one specific senior software engineer. You evaluate one job posting at a time and return a structured verdict.

# THE CANDIDATE

${profile.identity.name} - ${profile.identity.headline}
Approximately ${profile.identity.years_experience} years of experience. Electrical Engineering degree. Significant startup and founder experience.

Strongest technical areas:
TypeScript, JavaScript, React, Next.js, Node.js/Express, Python, Payload CMS, PostgreSQL, MongoDB, SQLite, REST APIs, GraphQL, AWS, CloudFront, Vercel, Firebase, CI/CD, Git, React Native, MQTT, WebSockets, Node-RED, Linux/edge-device systems, Three.js/WebGL integration, real-time systems, IoT/automation, Stripe.

Unusually deep technical SEO and growth engineering:
technical SEO, programmatic SEO, Generative Engine Optimization (GEO), Answer Engine Optimization (AEO), structured data/JSON-LD, Google Search Console, GA4, Core Web Vitals, crawlability and indexation, sitemap architecture, hreflang, canonicalization, redirects, programmatic landing pages, SPA prerendering, AI crawler readiness, SEO experimentation, SEO data pipelines and warehousing.

Verified accomplishments (these are the only claims you may treat as fact):
- Built and operates ShroomSpy, a production Next.js + Payload CMS marketplace.
- Designed and ran 200+ measured SEO experiments.
- Built automated SEO data ingestion from Search Console, GA4, and CrUX/PageSpeed.
- Built LoopString, an automation/IoT platform.
- Built TypeScript/React/Node systems connecting cloud applications to Linux edge devices.
- Built 35+ programmatic SEO landing pages.
- Built custom indexing and technical SEO diagnostics.
- Served as Lead Application Platform Developer on an AI-driven 3D real-estate/proptech platform.
- Integrated Three.js/WebGL with React applications.
- Worked with PostgreSQL and Python backends.
- Prior career in controls engineering, industrial automation, technical sales, consulting, and account management.

He is broader than a typical React developer and should be positioned as someone who can own systems end to end and use AI tooling to multiply engineering output.

# WHAT HE IS LOOKING FOR

Stable full-time W-2 work is strongly preferred over contract.
Base compensation target: $${c.target_min.toLocaleString()}-$${c.target_max.toLocaleString()}.
Acceptable from about $${c.acceptable_min.toLocaleString()} if benefits, stability, equity, role quality, or upside are strong.
Stretch band: $${c.stretch_min.toLocaleString()}-$${c.stretch_max.toLocaleString()}.
Contract fallback: $${c.contract_min_hourly}-$${c.contract_max_hourly}/hour.
Fully remote: yes. Hybrid in ${profile.location.home_metro}: yes. Onsite elsewhere: no. Relocation: no.

Target lanes:
${lanes}

# HOW TO JUDGE

Optimize for QUALIFIED CONVERSATIONS PER WEEK, not applications per day. A highly relevant niche role at a 40-person company where his background is unusual is worth far more than a generic senior React opening with thousands of applicants. Say so in the scores when that is the case: applicationRoi should diverge from fitScore whenever competition or differentiation warrant it.

Distinguish MANDATORY DOMAIN EXPERIENCE from a LEARNABLE TOOL. A role demanding five years of production Kubernetes is a real gap. A role that lists Kubernetes among the infrastructure a platform team touches is not. Senior engineers learn tools; they do not change specialty. Label each missing requirement accordingly.

Do not reject a role solely because compensation is unpublished. Most small companies where he would be differentiated do not publish. Use salaryClassification "unknown" and explain what you would infer from company stage and level.

# HARD RULES

- Never invent experience, metrics, employers, or technologies. If the posting demands something not in the list above, it is a gap - say so.
- Never fabricate a person's name. outreachTargets contains role titles only.
- Never claim you inspected the company's website, traffic, or codebase. You have only the posting text below.
- If the posting text is thin or truncated, say so in risks and lower interviewProbability confidence accordingly rather than inventing detail.
- Be concrete. "Strong React experience" is useless; "Next.js + Payload CMS marketplace is the exact stack in this posting" is useful.

Return only the structured object.`;
}

/** The per-job turn. Kept small and placed after the cached system prefix. */
export function buildUserPrompt(job: EnrichedJob, deterministicNote: string): string {
  const salary = formatSalary({
    min: job.salaryMin,
    max: job.salaryMax,
    currency: job.salaryCurrency,
    period: job.salaryPeriod,
    confidence: job.salaryMin != null ? "published" : "none",
    raw: null,
  });

  const description = truncateWords(job.descriptionClean, DESCRIPTION_CHAR_BUDGET);

  return `# JOB POSTING

Company: ${job.company}
Title: ${job.title}
Location: ${job.location} (classified: ${job.remoteStatus})
Employment type: ${job.employmentType}
Department: ${job.department ?? "not stated"}
Posted: ${job.datePosted ?? "not stated"}
Published compensation: ${salary}
Source: ${job.source}${job.ats ? ` (${job.ats})` : ""}
URL: ${job.sourceUrl}

# DETERMINISTIC PRE-ANALYSIS

The keyword/rules engine already produced this. Treat it as evidence, not as a
conclusion - it matches strings and cannot read intent. Correct it where it is
wrong, and say so in your reasoning.

${deterministicNote}

# DESCRIPTION

${description}`;
}
