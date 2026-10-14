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

/*
 * Workable and SmartRecruiters need two calls: a list with no description,
 * then a detail per posting. Captured live on 2026-10-14 (Workable `futurae`,
 * SmartRecruiters `Vitol`) and trimmed: long HTML shortened, every key kept
 * that the adapter reads, plus neighbours that show the real shape.
 */
export const workableListPayload = {
  name: "Futurae",
  description: "<p>Futurae is a Swiss Cybersecurity company enabling users seamlessly authenticate.</p>",
  jobs: [
    {
      title: "Senior Partnerships Manager (DACH)",
      shortcode: "F4969C4153",
      code: "",
      employment_type: "Full-time",
      telecommuting: false,
      department: "Business",
      url: "https://apply.workable.com/j/F4969C4153",
      shortlink: "https://apply.workable.com/j/F4969C4153",
      application_url: "https://apply.workable.com/j/F4969C4153/apply",
      published_on: "2026-07-22",
      created_at: "2026-07-22",
      country: "Switzerland",
      city: "Zürich",
      state: "Zurich",
      education: "Bachelor's Degree",
      experience: "Mid-Senior level",
      function: "Sales",
      industry: "Information Technology and Services",
      locations: [{ country: "Switzerland", countryCode: "CH", city: "Zürich", region: "Zurich", hidden: false }],
    },
  ],
};
// The real list repeats a multi-location posting once per location, same
// shortcode, differing only in city/state/country/locations.
for (const [city, state, country, countryCode] of [
  ["Vienna", "Vienna", "Austria", "AT"],
  ["Frankfurt am Main", "Hessen", "Germany", "DE"],
] as const) {
  workableListPayload.jobs.push({ ...workableListPayload.jobs[0]!, city, state, country, locations: [{ country, countryCode, city, region: state, hidden: false }] });
}

export const workableDetailPayload = {
  id: 5981614,
  shortcode: "F4969C4153",
  title: "Senior Partnerships Manager (DACH)",
  remote: false,
  location: { city: "Zürich", country: "Switzerland", countryCode: "CH", region: "Zurich" },
  locations: [
    { city: "Zürich", country: "Switzerland", countryCode: "CH", hidden: false, region: "Zurich" },
    { city: "Vienna", country: "Austria", countryCode: "AT", hidden: false, region: "Vienna" },
    { city: "Frankfurt am Main", country: "Germany", countryCode: "DE", hidden: false, region: "Hessen" },
  ],
  state: "published",
  isInternal: false,
  code: "",
  published: "2026-07-22T00:00:00.000Z",
  type: "full",
  language: "en",
  department: ["Business"],
  accountUid: "001f7773-e313-4f23-95f7-cf2a8e7df3fc",
  approvalStatus: "approved",
  workplace: "hybrid",
  description: "<p>We’re strengthening the Alliances &amp; Partnerships team to ensure continuity and growth.</p>",
  requirements: "<p><strong>Tasks &amp; Responsibilities</strong></p><ul><li>Actively identify, evaluate, and develop new partnership opportunities.</li></ul>",
  benefits: "<ul><li>Work with purpose and take ownership in an international team</li></ul>",
};

const vitolPostingCommon = {
  id: "744000155316183",
  name: "Physical Operator – US West Coast Pipeline Operations",
  uuid: "01a44f22-7d2c-429c-888f-9487fb506332",
  jobAdId: "e52a3aae-66e5-4605-bfc0-2fdae4fdb0f3",
  defaultJobAd: true,
  refNumber: "REF899I",
  releasedDate: "2026-10-13T16:35:50.413Z",
  location: {
    city: "Houston",
    region: "TX",
    country: "us",
    remote: false,
    hybrid: false,
    latitude: "29.7600771",
    longitude: "-95.37011079999999",
    fullLocation: "Houston, TX, United States",
  },
  industry: { id: "oil_and_energy", label: "Oil And Energy" },
  function: { id: "supply_chain", label: "Supply Chain" },
  typeOfEmployment: { id: "permanent", label: "Full-time" },
  experienceLevel: { id: "associate", label: "Associate" },
  customField: [{ fieldId: "COUNTRY", fieldLabel: "Country/Region", valueId: "us", valueLabel: "United States" }],
  visibility: "PUBLIC",
  language: { code: "en", label: "English", labelNative: "English (US)" },
};

export const smartRecruitersListPayload = {
  offset: 0,
  limit: 100,
  totalFound: 1,
  content: [
    {
      ...vitolPostingCommon,
      company: { identifier: "Vitol", name: "Vitol" },
      department: { id: "1736421", label: "Operations" },
      ref: "https://api.smartrecruiters.com/v1/companies/Vitol/postings/744000155316183",
    },
  ],
};

export const smartRecruitersDetailPayload = {
  ...vitolPostingCommon,
  jobId: "9ddb789b-c3db-4af8-ab7c-1e7c76dc0ee9",
  company: { name: "Vitol", identifier: "Vitol" },
  department: { id: 1736421, label: "Operations" },
  creator: { name: "", avatarUrl: "" },
  postingUrl: "https://jobs.smartrecruiters.com/Vitol/744000155316183-physical-operator-us-west-coast-pipeline-operations",
  applyUrl: "https://jobs.smartrecruiters.com/Vitol/744000155316183-physical-operator-us-west-coast-pipeline-operations?oga=true",
  referralUrl: "https://jobs.smartrecruiters.com/external-referrals/company/Vitol/publication/01a44f22-7d2c-429c-888f-9487fb506332",
  jobAd: {
    sections: {
      companyDescription: { title: "Company Description", text: "<p>Vitol is a leader in energy and commodities.</p>" },
      jobDescription: { title: "Job Description", text: "<p>The Physical Operator is responsible for coordinating the physical movement of oil products.</p>" },
      qualifications: { title: "Qualifications", text: "<ul><li>Three or more years of relevant experience in refined-products pipeline scheduling.</li></ul>" },
      additionalInformation: { title: "Additional Information", text: "<p><strong>Work Environment</strong></p><ul><li>Primarily office-based.</li></ul>" },
    },
  },
  active: true,
};
