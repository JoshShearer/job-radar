import { describe, it, expect } from "vitest";
import {
  chooseOption,
  classifyLabel,
  decide,
  isNeverFill,
  isSubmitControl,
  isYesNoOptions,
  matchPreparedAnswer,
  stateListAnswer,
  normalizeLabel,
  scoreOption,
  type DecisionContext,
} from "../src/apply/fields.js";
import { detectChallenge } from "../src/apply/autofill.js";
import { PersonalSchema } from "../src/config/personal.js";

const personal = PersonalSchema.parse({
  identity: {
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.com",
    phone: "+1 512 555 0100",
    city: "Austin",
    state: "Texas",
    country: "United States",
  },
  links: { linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada" },
  work_eligibility: { authorized_to_work_us: true, requires_sponsorship: false },
  preferences: { referral_source: "Company job board" },
});

const ctx: DecisionContext = { personal, pack: null };

/**
 * These are the exact question labels scraped from a live Greenhouse form
 * (Vercel, job 5752684004). Pinning real labels means a classification
 * regression shows up as a failing test instead of a wrong job application.
 */
const VERCEL_LABELS = {
  firstName: "First Name",
  lastName: "Last Name",
  email: "Email",
  phone: "Phone",
  country: "Country",
  basedIn:
    "Are you currently based in any of these countries? Please note these are the only countries where we are accepting applications",
  sponsorship: "Will you require Visa Sponsorship now, or in the future?",
  workAuth:
    "Your authorization to work in the country where you live. Please choose the option that describes your work authorization.",
  states: "Do you live in one of the following states?",
  linkedin: "LinkedIn Profile",
  twitter: "Twitter",
  github: "Github",
  website: "Website",
  privacy:
    "By submitting my application, I acknowledge that I have read and understand Vercel's Job Applicant Privacy Notice - https://vercel.com/legal/job-applicant-privacy-notice",
  doubleCheck:
    "Please double-check all the information provided above. Ensuring accuracy is crucial, as any errors or omissions may impact the review of your application.",
  referral: "Where did you first hear about this role?",
  gender: "How would you describe your gender identity? (mark all that apply)",
  race: "How would you describe your racial/ethnic background? (mark all that apply)",
  orientation: "How would you describe your sexual orientation? (mark all that apply)",
  transgender: "Do you identify as transgender?",
  disability:
    "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?",
  veteran: "Are you a veteran or active member of the United States Armed Forces?",
} as const;

describe("classifyLabel on real Greenhouse labels", () => {
  it("classifies the identity fields", () => {
    expect(classifyLabel(VERCEL_LABELS.firstName)).toBe("first_name");
    expect(classifyLabel(VERCEL_LABELS.lastName)).toBe("last_name");
    expect(classifyLabel(VERCEL_LABELS.email)).toBe("email");
    expect(classifyLabel(VERCEL_LABELS.phone)).toBe("phone");
    expect(classifyLabel(VERCEL_LABELS.country)).toBe("country");
  });

  it("classifies the link fields", () => {
    expect(classifyLabel(VERCEL_LABELS.linkedin)).toBe("linkedin");
    expect(classifyLabel(VERCEL_LABELS.github)).toBe("github");
    expect(classifyLabel(VERCEL_LABELS.twitter)).toBe("twitter");
    expect(classifyLabel(VERCEL_LABELS.website)).toBe("website");
  });

  it("distinguishes sponsorship from work authorization", () => {
    expect(classifyLabel(VERCEL_LABELS.sponsorship)).toBe("sponsorship");
    expect(classifyLabel(VERCEL_LABELS.workAuth)).toBe("work_authorization");
  });

  it("reads a country question phrased as a residence question", () => {
    expect(classifyLabel(VERCEL_LABELS.basedIn)).toBe("country");
  });

  it("reads a state question, and is not fooled by 'United States'", () => {
    expect(classifyLabel(VERCEL_LABELS.states)).toBe("state");
    // "United States Armed Forces" is a veteran question, not a state question.
    expect(classifyLabel(VERCEL_LABELS.veteran)).toBe("eeo");
  });

  it("classifies referral source", () => {
    expect(classifyLabel(VERCEL_LABELS.referral)).toBe("referral_source");
  });
});

describe("questions this tool must never answer", () => {
  const eeo = [
    VERCEL_LABELS.gender,
    VERCEL_LABELS.race,
    VERCEL_LABELS.orientation,
    VERCEL_LABELS.transgender,
    VERCEL_LABELS.disability,
    VERCEL_LABELS.veteran,
  ];

  it.each(eeo)("treats demographic question as never-fill: %s", (label) => {
    const intent = classifyLabel(label);
    expect(intent).toBe("eeo");
    expect(isNeverFill(intent)).toBe(true);
    expect(decide(label, intent, ctx).action).toBe("skip");
  });

  it.each([VERCEL_LABELS.privacy, VERCEL_LABELS.doubleCheck])(
    "treats attestation as never-fill: %s",
    (label) => {
      const intent = classifyLabel(label);
      expect(intent).toBe("attestation");
      expect(isNeverFill(intent)).toBe(true);
      const d = decide(label, intent, ctx);
      expect(d.action).toBe("skip");
      // Attestations must surface to the human, not vanish into a quiet list.
      expect(d.action === "skip" && d.consequential).toBe(true);
    },
  );

  it("does not let a demographic question fall through to another rule", () => {
    // "gender identity" contains no other trigger, but "veteran ... United
    // States Armed Forces" and "disability ... communication" overlap with
    // location and contact wording. Ordering must keep them in eeo.
    for (const label of eeo) expect(classifyLabel(label)).toBe("eeo");
  });
});

describe("decide", () => {
  it("fills identity fields from personal.yaml", () => {
    expect(decide("First Name", "first_name", ctx)).toMatchObject({ action: "fill", value: "Ada" });
    expect(decide("Email", "email", ctx)).toMatchObject({ action: "fill", value: "ada@example.com" });
  });

  it("answers sponsorship from the stated fact, not a guess", () => {
    expect(decide(VERCEL_LABELS.sponsorship, "sponsorship", ctx)).toMatchObject({
      action: "select",
      desired: "No",
    });
    const needsSponsor: DecisionContext = {
      personal: { ...personal, work_eligibility: { ...personal.work_eligibility, requires_sponsorship: true } },
      pack: null,
    };
    expect(decide(VERCEL_LABELS.sponsorship, "sponsorship", needsSponsor)).toMatchObject({
      action: "select",
      desired: "Yes",
    });
  });

  it("refuses to answer work eligibility when it was never stated", () => {
    // The dangerous default. An unset value must never collapse to "No" for
    // sponsorship or "authorized" for work status.
    const unstated: DecisionContext = {
      personal: PersonalSchema.parse({
        identity: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
        work_eligibility: {},
      }),
      pack: null,
    };
    for (const intent of ["sponsorship", "work_authorization"] as const) {
      const d = decide("...", intent, unstated);
      expect(d.action).toBe("skip");
      expect(d.action === "skip" && d.consequential).toBe(true);
    }
  });

  it("refuses to invent a phone number when none is configured", () => {
    const noPhone: DecisionContext = {
      personal: PersonalSchema.parse({
        identity: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
        work_eligibility: {},
      }),
      pack: null,
    };
    const d = decide("Phone", "phone", noPhone);
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.consequential).toBe(true);
  });

  it("skips a link that is not configured rather than inventing one", () => {
    const noTwitter = decide("Twitter", "twitter", ctx);
    expect(noTwitter.action).toBe("skip");
  });

  it("leaves desired salary blank by default and flags it as consequential", () => {
    const d = decide("Desired salary", "salary_expectation", ctx);
    expect(d.action).toBe("skip");
    expect(d.action === "skip" && d.consequential).toBe(true);
  });

  it("fills desired salary when the candidate explicitly set one", () => {
    const withSalary: DecisionContext = {
      personal: { ...personal, preferences: { ...personal.preferences, desired_salary: "Open to discussion" } },
      pack: null,
    };
    expect(decide("Desired salary", "salary_expectation", withSalary)).toMatchObject({
      action: "fill",
      value: "Open to discussion",
    });
  });

  it("lets a manual override win, including over a never-fill rule", () => {
    const overridden: DecisionContext = {
      personal: {
        ...personal,
        answers: [{ match: "are you a veteran", answer: "I decline to answer" }],
      },
      pack: null,
    };
    const d = decide(VERCEL_LABELS.veteran, "eeo", overridden);
    // The candidate wrote this answer himself, so it is his statement to make.
    expect(d).toMatchObject({ action: "fill", value: "I decline to answer" });
  });

  it("skips an unrecognized question rather than guessing", () => {
    expect(decide("What is your favorite deployment story?", "unknown", ctx).action).toBe("skip");
  });
});

describe("scoreOption", () => {
  it("scores an exact match as 1", () => {
    expect(scoreOption("United States", "United States")).toBe(1);
  });

  it("penalizes an option whose negation differs from the desired value", () => {
    const yes = scoreOption(
      "authorized to work without sponsorship",
      "I am authorized to work in this country without sponsorship",
    );
    const no = scoreOption(
      "authorized to work without sponsorship",
      "I am not authorized to work in this country",
    );
    expect(yes).toBeGreaterThan(no);
  });

  it("does not confuse yes and no", () => {
    expect(scoreOption("No", "Yes")).toBeLessThan(0.6);
  });
});

describe("chooseOption", () => {
  it("picks an exact country from a long list", () => {
    const countries = ["Canada", "Mexico", "United Kingdom", "United States", "Germany"];
    expect(chooseOption("United States", countries)?.option).toBe("United States");
  });

  it("picks yes/no cleanly", () => {
    expect(chooseOption("No", ["Yes", "No"])?.option).toBe("No");
  });

  it("returns null rather than guessing when nothing is close", () => {
    expect(chooseOption("Texas", ["Alabama", "Alaska", "Arizona"])).toBeNull();
  });

  it("refuses to choose between two nearly identical options", () => {
    // This is the case that matters: getting it wrong is a false statement
    // about work authorization on a real application.
    const options = [
      "I am authorized to work in the US for any employer",
      "I am authorized to work in the US for my current employer only",
    ];
    expect(chooseOption("authorized to work in the US", options)).toBeNull();
  });

  it("honors the confidence threshold", () => {
    expect(chooseOption("Company job board", ["Company job board"], 0.9)?.option).toBe("Company job board");
    expect(chooseOption("Company job board", ["A friend"], 0.9)).toBeNull();
  });
});

describe("isSubmitControl", () => {
  it.each(["Submit application", "SUBMIT", "Send Application", "Apply now", "Complete application"])(
    "recognizes %s",
    (text) => {
      expect(isSubmitControl(text)).toBe(true);
    },
  );

  it.each(["United States", "Yes", "Save draft", "Attach", "Texas", ""])(
    "does not flag ordinary option %s",
    (text) => {
      expect(isSubmitControl(text)).toBe(false);
    },
  );
});

describe("matchPreparedAnswer", () => {
  const prepared = [
    { question: "Why do you want to work at Vercel?", answer: "Because of the frontend cloud." },
    { question: "Describe your experience with Next.js", answer: "Shipped ShroomSpy on it." },
  ];

  it("matches a reworded question", () => {
    const m = matchPreparedAnswer("Why do you want to work at Vercel?", prepared);
    expect(m?.answer).toBe("Because of the frontend cloud.");
  });

  it("returns null when nothing is close enough", () => {
    expect(matchPreparedAnswer("What is your notice period?", prepared)).toBeNull();
  });

  it("returns null for an empty question", () => {
    expect(matchPreparedAnswer("", prepared)).toBeNull();
  });
});

describe("state-list questions", () => {
  // The real one, from the live Vercel form. It is a yes/no question, not a
  // state picker, and the answer is decided by the list in the question text.
  const label =
    "Do you live in one of the following states? Alabama, Alaska, Delaware, Kansas, Maine, " +
    "Mississippi, Montana, Nebraska, New Mexico, North Dakota, South Dakota, Vermont, West Virginia, Wyoming";

  it("recognizes a yes/no option set", () => {
    expect(isYesNoOptions(["Yes", "No"])).toBe(true);
    expect(isYesNoOptions(["Alabama", "Alaska", "Arizona"])).toBe(false);
    expect(isYesNoOptions(["Yes"])).toBe(false);
  });

  it("answers No for a state that is not in the list", () => {
    expect(stateListAnswer(label, "Texas", false)).toBe("No");
  });

  it("answers Yes for a state that is in the list", () => {
    expect(stateListAnswer(label, "Montana", false)).toBe("Yes");
  });

  it("does not mistake West Virginia for Virginia", () => {
    // The list contains "West Virginia" but not "Virginia". A naive word-boundary
    // match says Yes and puts a false statement on the application.
    expect(stateListAnswer(label, "Virginia", false)).toBe("No");
    expect(stateListAnswer(label, "West Virginia", false)).toBe("Yes");
  });

  it("refuses to answer No from a truncated list", () => {
    // The state could be sitting in the part that got cut off.
    expect(stateListAnswer(label, "Texas", true)).toBeNull();
    // A hit is still safe: it was found in the part we did see.
    expect(stateListAnswer(label, "Montana", true)).toBe("Yes");
  });

  it("declines when the question is not actually an enumeration", () => {
    expect(stateListAnswer("What state do you live in?", "Texas", false)).toBeNull();
  });

  it("declines when no state is configured", () => {
    expect(stateListAnswer(label, "", false)).toBeNull();
  });
});

describe("detectChallenge", () => {
  const probes = (visibleSet: string[], presentSet: string[]) => ({
    visible: async (s: string) => visibleSet.includes(s),
    present: async (s: string) => presentSet.includes(s) || visibleSet.includes(s),
  });

  it("does not block on the invisible reCAPTCHA badge every Greenhouse form embeds", async () => {
    // Observed on a live Vercel/Greenhouse posting: an enterprise anchor iframe
    // is always present and challenges nobody. Treating it as a block meant
    // refusing to fill any Greenhouse form at all.
    const p = probes([], ["iframe[src*='recaptcha']"]);
    const c = await detectChallenge(p.visible, p.present);
    expect(c?.kind).toBe("widget");
  });

  it("blocks on an actual challenge popup", async () => {
    const p = probes(["iframe[src*='recaptcha'][src*='bframe']"], []);
    expect((await detectChallenge(p.visible, p.present))?.kind).toBe("blocking");
  });

  it("blocks on a Cloudflare interstitial", async () => {
    const p = probes(["#cf-challenge-running"], []);
    expect((await detectChallenge(p.visible, p.present))?.kind).toBe("blocking");
  });

  it("returns null on an ordinary form", async () => {
    const p = probes([], []);
    expect(await detectChallenge(p.visible, p.present)).toBeNull();
  });

  it("prefers blocking over widget when both are present", async () => {
    const p = probes(["iframe[src*='recaptcha'][src*='bframe']"], ["iframe[src*='recaptcha']"]);
    expect((await detectChallenge(p.visible, p.present))?.kind).toBe("blocking");
  });
});

describe("normalizeLabel", () => {
  it("collapses punctuation and whitespace", () => {
    expect(normalizeLabel("  First   Name?  ")).toBe("first name");
  });

  it("keeps technology-bearing characters", () => {
    expect(normalizeLabel("C++ / C#  and Node.js")).toBe("c++ c# and node.js");
  });
});

/**
 * JOB-13. Two gaps found by running `autofill` against a live Ashby form: an
 * application asks who you currently work for and what your title is, and the
 * master resume has both, but nothing mapped them. Answering from
 * `config/resume.yaml` keeps one source of truth rather than duplicating
 * employer data into `personal.yaml`, where it would drift.
 */
describe("current employer and title", () => {
  const role = (id: string, company: string, title: string, start: string, end: string | null) => ({
    id,
    company,
    title,
    start,
    end,
    location: "",
    context: "",
    employment_type: "full_time" as const,
    bullets: [],
  });

  const withRoles = (roles: ReturnType<typeof role>[]): DecisionContext => ({
    personal,
    pack: null,
    resume: { experience: roles } as never,
  });

  it("classifies the labels a real form uses", () => {
    expect(classifyLabel("Current/Most Recent Company Name")).toBe("current_company");
    expect(classifyLabel("Current Employer")).toBe("current_company");
    expect(classifyLabel("Current/Most Recent Job Title")).toBe("current_title");
    expect(classifyLabel("Current Title")).toBe("current_title");
  });

  it("does not mistake a company question for the employer question", () => {
    // "Why do you want to work at this company" is not asking where you work.
    expect(classifyLabel("Why do you want to work at this company?")).not.toBe("current_company");
  });

  it("prefers an ongoing role, latest start first", () => {
    const ctx = withRoles([
      role("r1", "BaseMyHome", "Lead Application Platform Developer", "2025-11", "2026-05"),
      role("r2", "ShroomSpy", "Founder & Head of Technology", "2023-07", null),
      role("r3", "LoopString", "Founder & Head of Technology", "2022-01", null),
    ]);
    const company = decide("Current/Most Recent Company Name", "current_company", ctx);
    expect(company).toMatchObject({ action: "fill", value: "ShroomSpy" });
    expect(decide("Current/Most Recent Job Title", "current_title", ctx)).toMatchObject({
      action: "fill",
      value: "Founder & Head of Technology",
    });
  });

  it("names the role it used, so a wrong pick is visible in the report", () => {
    const ctx = withRoles([role("r1", "ShroomSpy", "Founder", "2023-07", null)]);
    const d = decide("Current Employer", "current_company", ctx);
    expect(d.action).toBe("fill");
    if (d.action === "fill") expect(d.why).toContain("ShroomSpy");
  });

  it("falls back to the most recently ended role when nothing is ongoing", () => {
    const ctx = withRoles([
      role("r1", "Older Co", "Engineer", "2019-01", "2021-06"),
      role("r2", "Newer Co", "Senior Engineer", "2021-07", "2023-03"),
    ]);
    expect(decide("Current Employer", "current_company", ctx)).toMatchObject({
      action: "fill",
      value: "Newer Co",
    });
  });

  it("breaks a same-start tie deterministically instead of picking arbitrarily", () => {
    const a = withRoles([
      role("r1", "Alpha Co", "Engineer", "2023-07", null),
      role("r2", "Beta Co", "Engineer", "2023-07", null),
    ]);
    const b = withRoles([
      role("r2", "Beta Co", "Engineer", "2023-07", null),
      role("r1", "Alpha Co", "Engineer", "2023-07", null),
    ]);
    const first = decide("Current Employer", "current_company", a);
    // Same roles, different array order, same answer.
    expect(decide("Current Employer", "current_company", b)).toEqual(first);
  });

  it("skips rather than guessing when no resume is available", () => {
    const d = decide("Current Employer", "current_company", { personal, pack: null });
    expect(d.action).toBe("skip");
  });

  it("skips rather than guessing when the resume has no roles", () => {
    expect(decide("Current Employer", "current_company", withRoles([])).action).toBe("skip");
  });
});
