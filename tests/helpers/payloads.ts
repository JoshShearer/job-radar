/** Provider payload shapes as observed on the live endpoints (pinned). */
export const greenhousePayload = {
  jobs: [
    {
      id: 6136160004,
      title: "Senior Software Engineer",
      absolute_url: "https://job-boards.greenhouse.io/vercel/jobs/6136160004",
      updated_at: "2026-08-06T13:47:17-04:00",
      first_published: "2026-08-06T12:50:10-04:00",
      location: { name: "Remote - US" },
      company_name: "Vercel",
      departments: [{ name: "Engineering" }, { name: "Platform" }],
      content: "&amp;lt;p&amp;gt;Build with TypeScript.&amp;lt;/p&amp;gt;",
      metadata: [{ name: "Employment Type", value: "Full-time" }],
    },
  ],
};

export const leverPayload = [
  {
    id: "abc-123",
    text: "Senior Full Stack Engineer",
    hostedUrl: "https://jobs.lever.co/ro/abc-123",
    applyUrl: "https://jobs.lever.co/ro/abc-123/apply",
    createdAt: 1786400108000,
    workplaceType: "remote",
    categories: { commitment: "Full-time", location: "Remote", team: "Engineering" },
    description: "<p>Intro paragraph.</p>",
    lists: [{ text: "Requirements", content: "<li>TypeScript</li><li>React</li>" }],
    additional: "<p>Benefits.</p>",
  },
];

export const ashbyPayload = {
  jobs: [
    {
      id: "34413f8d",
      title: "Senior Product Engineer",
      department: "Engineering",
      team: "Backend",
      employmentType: "FullTime",
      location: "New York, NY (HQ)",
      secondaryLocations: [{ location: "Remote (US)" }],
      publishedAt: "2026-04-07T17:12:35.753+00:00",
      isListed: true,
      isRemote: true,
      workplaceType: "Hybrid",
      jobUrl: "https://jobs.ashbyhq.com/ramp/34413f8d",
      applyUrl: "https://jobs.ashbyhq.com/ramp/34413f8d/application",
      descriptionHtml: "<p>About Ramp</p>",
      descriptionPlain: "About Ramp",
      compensation: {
        summaryComponents: [
          { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 211400, maxValue: 290600 },
          { compensationType: "EquityPercentage", interval: "NONE", currencyCode: null },
        ],
      },
    },
    { id: "hidden", title: "Unlisted role", isListed: false },
  ],
};

export const remoteOkPayload = [
  { legal: "API Terms of Service: Please link back..." },
  {
    slug: "senior-engineer-acme",
    id: "1136375",
    epoch: 1786400108,
    company: "Acme",
    position: "Senior Engineer",
    tags: ["typescript", "react"],
    description:
      "<strong>Build things.</strong> Please mention the word **ADROITLY** and tag RMTM2 when applying to show you read the job post completely (#RMTM2). This is a beta feature to avoid spam applicants. Companies can search these words to find applicants that read this and see they're human.",
    location: "Worldwide",
    apply_url: "https://remoteok.com/remote-jobs/senior-engineer-acme",
    salary_min: 150000,
    salary_max: 200000,
  },
  { id: "0", company: "Bad", position: "Engineer", salary_min: 0, salary_max: 0 },
];
