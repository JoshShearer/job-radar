import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fillForm, type FieldOutcome } from "../src/apply/autofill.js";
import { chooseResume, type ResumeChoice } from "../src/apply/resume-file.js";
import { loadPersonal, type Personal } from "../src/config/personal.js";
import type { ApplicationPack } from "../src/analysis/application.js";

/**
 * Regression harness for the browser layer.
 *
 * `src/apply/fields.ts` is pure and well covered, but the refusals are only
 * actually enforced once a Page is involved, and that half had no test. Three
 * shipped defects came out of this gap - options read from the wrong menu,
 * a passive reCAPTCHA badge treated as a block, and a resume path accepted and
 * never read - and all three type-checked and passed the whole unit suite.
 *
 * The form is a saved fixture driven from `file://`. No network, no third-party
 * site touched on every `npm test`, and the assertions are on the returned
 * `FieldOutcome[]` and on the DOM, never on pixels.
 *
 * What this cannot do: the combobox behaviour in the fixture is a shim standing
 * in for react-select. It reproduces the contract observed on the real form, so
 * it cannot notice react-select changing that contract. The live headless run
 * stays part of the ship gate; this supplements it rather than replacing it.
 */

const FIXTURE = resolve(import.meta.dirname, "fixtures", "greenhouse-application.html");
const PERSONAL_STUB = resolve(import.meta.dirname, "fixtures", "personal.stub.yaml");

/** Labels, verbatim from the captured form. */
const L = {
  firstName: "First Name",
  country: "Country*",
  attach: "Attach",
  sponsorship: "Will you require Visa Sponsorship now, or in the future?*",
  workAuth:
    "Your authorization to work in the country where you live. Please choose the option that describes your work authorization. *",
  states:
    "Do you live in one of the following states? Alabama, Alaska, Delaware, Kansas, Maine, Mississippi, Montana, Nebraska, New Mexico, North Dakota, South Dakota, West Virginia, or Wyoming.*",
  referral: "Where did you first hear about this role?*",
  privacy:
    "By submitting my application, I acknowledge that I have read and understand Vercel’s Job Applicant Privacy Notice - https://vercel.com/legal/job-applicant-privacy-notice *",
  doubleCheck:
    "Please double-check all the information provided above. Ensuring accuracy is crucial, as any errors or omissions may impact the review of your application.*",
  consent:
    "I agree to the processing of my personal data as described in the privacy policy",
  whyHere: "Why do you want to work here?",
  attestText: "I certify that the information above is true and complete",
} as const;

const EEO_LABELS = [
  "How would you describe your gender identity? (mark all that apply)",
  "How would you describe your racial/ethnic background? (mark all that apply)",
  "How would you describe your sexual orientation? (mark all that apply)",
  "Do you identify as transgender?",
  "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?",
  "Are you a veteran or active member of the United States Armed Forces?",
];

let browser: Browser;
let personal: Personal;
let resumeDir: string;
let resume: ResumeChoice;

/** Every URL the page asked for. The suite must touch nothing but the fixture. */
let requests: string[] = [];

beforeAll(async () => {
  if (!existsSync(FIXTURE)) throw new Error(`Fixture missing: ${FIXTURE}`);
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    // A silent skip here would be worse than no test: the suite would go green
    // on a machine where the refusals are unverified.
    throw new Error(
      `Could not launch Chromium for the autofill harness. Install the browser with:\n` +
        `  npx playwright install chromium\n\nOriginal error: ${(err as Error).message}`,
    );
  }
  personal = loadPersonal(PERSONAL_STUB);

  resumeDir = mkdtempSync(resolve(tmpdir(), "job-radar-harness-"));
  for (const [name, ageSeconds] of [
    ["Lovelace_Resume_2026.pdf", 10],
    ["Lovelace_Resume_Dev_March2025.pdf", 400 * 24 * 3600],
  ] as const) {
    const p = resolve(resumeDir, name);
    writeFileSync(p, "%PDF-1.4\n", "utf8");
    const when = new Date(Date.UTC(2026, 0, 1) - ageSeconds * 1000);
    utimesSync(p, when, when);
  }
  resume = chooseResume(undefined, resumeDir)!;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (resumeDir) rmSync(resumeDir, { recursive: true, force: true });
});

async function openFixture(): Promise<Page> {
  const page = await browser.newPage();
  requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(pathToFileURL(FIXTURE).href, { waitUntil: "load" });
  return page;
}

async function run(pack: ApplicationPack | null = null): Promise<{ page: Page; outcomes: FieldOutcome[] }> {
  const page = await openFixture();
  const outcomes = await fillForm(page, personal, pack, resume);
  return { page, outcomes };
}

const find = (outcomes: FieldOutcome[], label: string): FieldOutcome | undefined =>
  outcomes.find((o) => o.label.trim() === label.trim());

describe("autofill against a saved application form", () => {
  let page: Page;
  let outcomes: FieldOutcome[];

  beforeAll(async () => {
    ({ page, outcomes } = await run());
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  it("makes no network request", () => {
    expect(requests.length).toBeGreaterThan(0); // the fixture itself
    const offsite = requests.filter((u) => !u.startsWith("file://"));
    expect(offsite).toEqual([]);
  });

  it("fills the identity fields it was given", () => {
    expect(find(outcomes, L.firstName)).toMatchObject({ status: "filled" });
    expect(find(outcomes, L.firstName)?.detail).toContain("Ada");
  });

  // --- Refusal 1: demographic questions ------------------------------------
  //
  // The ticket said EEO resolves to `needs-you`. It does not, and the
  // difference is deliberate: `decide` marks only attestations `consequential`
  // (src/apply/fields.ts), so an optional EEO question lands in `skipped` and
  // is reported under "Left alone". That is the right bucket - disclosing is
  // the candidate's choice, and "You need to handle these" is where the
  // load-bearing items live. The invariant worth pinning is that it is never
  // filled and always carries the refusal reason.
  it("never answers a demographic question, and says why", () => {
    for (const label of EEO_LABELS) {
      const o = find(outcomes, label);
      expect(o, `no outcome for EEO question: ${label}`).toBeDefined();
      expect(o!.intent).toBe("eeo");
      expect(o!.status).not.toBe("filled");
      expect(o!.detail).toContain("demographic self-identification is yours");
    }
  });

  it("leaves every demographic control empty in the DOM", async () => {
    for (const id of ["4015790004", "4015786004", "4015785004", "4015783004", "4015781004", "4015780004"]) {
      expect(await page.locator(`[id="${id}"]`).inputValue()).toBe("");
    }
  });

  // --- Refusal 2: attestations ---------------------------------------------
  it("never affirms an attestation, and marks it as needing a human", () => {
    for (const label of [L.privacy, L.doubleCheck, L.attestText]) {
      const o = find(outcomes, label);
      expect(o, `no outcome for attestation: ${label}`).toBeDefined();
      expect(o!.intent).toBe("attestation");
      expect(o!.status).toBe("needs-you");
      expect(o!.detail).toContain("software must not affirm it for you");
    }
  });

  it("leaves attestation controls empty in the DOM", async () => {
    expect(await page.locator("#question_14827952004").inputValue()).toBe("");
    expect(await page.locator("#question_14827953004").inputValue()).toBe("");
    expect(await page.locator("#attest_text").inputValue()).toBe("");
  });

  // --- Refusal 3: checkboxes ------------------------------------------------
  it("ticks no checkbox anywhere on the page", async () => {
    expect(await page.locator("input[type=checkbox]:checked").count()).toBe(0);
    const o = find(outcomes, L.consent);
    expect(o).toMatchObject({ status: "needs-you" });
    expect(o!.detail).toContain("consents and attestations are yours to give");
  });

  // --- Refusal 4: submit ----------------------------------------------------
  it("never submits the form", async () => {
    expect(await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted)).toBe(false);
  });

  it("does not fill the submit input, even though the loop enumerates it", async () => {
    // `type="submit"` is not excluded by enumerateControls, so it falls through
    // to kind "text" and genuinely enters the decision loop. What keeps it safe
    // is that no label rule matches it - one rule change away from `el.fill()`
    // being called on a submit control.
    expect(await page.locator("#submit_input").inputValue()).toBe("Submit application");
    const submitOutcome = outcomes.find((o) => o.detail.includes("Submit application") && o.status === "filled");
    expect(submitOutcome).toBeUndefined();
  });

  // --- Refusal 5: unset means unknown --------------------------------------
  it("refuses the sponsorship question because personal.yaml leaves it unset", () => {
    const o = find(outcomes, L.sponsorship);
    expect(o).toMatchObject({ intent: "sponsorship", status: "needs-you" });
    expect(o!.detail).toContain("requires_sponsorship is unset");
  });

  it("answers work authorization, which the stub does state", () => {
    const o = find(outcomes, L.workAuth);
    expect(o).toMatchObject({ intent: "work_authorization", status: "filled" });
    expect(o!.detail).toContain("I am authorized to work in the country due to my nationality");
  });

  // --- The file attachment (GitHub #11, and the join JOB-10 left open) ------
  it("attaches exactly the resume it was handed", async () => {
    const attached = await page.locator("#resume").evaluate((el) => {
      const files = (el as HTMLInputElement).files;
      return { count: files?.length ?? 0, name: files?.[0]?.name ?? null };
    });
    // The DOM only ever sees the basename - browsers do not expose the path to
    // script - so the full path is asserted on the outcome detail instead.
    expect(attached.count).toBe(1);
    expect(attached.name).toBe(basename(resume.path));

    const o = find(outcomes, L.attach);
    expect(o).toMatchObject({ intent: "resume", status: "filled" });
    expect(o!.detail).toContain(basename(resume.path));
  });

  it("names the resume it passed over", () => {
    // JOB-10 shipped this join unpinned because it needs a live Page.
    expect(resume.passedOver.length).toBe(1);
    expect(find(outcomes, L.attach)!.detail).toContain(basename(resume.passedOver[0]!));
  });

  // --- Menu scoping (GitHub #6) --------------------------------------------
  it("reads combobox options only from that combobox's own listbox", () => {
    // 244 phone dial-code options sit mounted in the DOM before anything is
    // clicked. A global [role=option] query returns those instead, which is
    // exactly how every Greenhouse form broke.
    const o = find(outcomes, L.referral);
    expect(o?.detail).toContain("Offered:");
    expect(o!.detail).toContain("Built In");
    expect(o!.detail).not.toMatch(/Afghanistan|\+93|Åland/);
  });

  it("sees the mounted phone-country list it must ignore", async () => {
    // If this ever stops being true the scoping test above is no longer
    // testing anything, so the hazard is asserted rather than assumed.
    expect(await page.locator("#iti-0__country-listbox [role=option]").count()).toBe(244);
  });

  it("still matches within its own list when the answer is there", () => {
    const o = find(outcomes, L.country);
    expect(o).toMatchObject({ status: "filled" });
    expect(o!.detail).toContain("United States");
  });

  // --- Refusal 6: report what was offered, do not guess ---------------------
  it("reports the options rather than guessing when nothing matches", async () => {
    const o = find(outcomes, L.referral);
    expect(o).toMatchObject({ intent: "referral_source", status: "needs-you" });
    expect(o!.detail).toContain('no confident match for "Company job board"');
    for (const opt of ["Events", "Built In", "LinkedIn"]) expect(o!.detail).toContain(opt);
    expect(await page.locator("#question_17703233004").inputValue()).toBe("");
  });

  it("answers the embedded state-list question from the list inside it", () => {
    // "Do you live in one of the following states? Alabama, ..." is a yes/no
    // question whose correct answer depends on the list in the question text.
    const o = find(outcomes, L.states);
    expect(o).toMatchObject({ status: "filled" });
    expect(o!.detail).toMatch(/^No /); // Texas is not in that list
  });
});

describe("bot protection", () => {
  // GitHub #8: nearly every Greenhouse form embeds an invisible reCAPTCHA
  // Enterprise badge that challenges nobody. Treating its presence as a block
  // meant the tool refused to fill any Greenhouse form at all. The badge is
  // reported and the run continues; an actual challenge stops it. Neither is
  // touched, scored, solved, or worked around.
  it("reports a passive widget and keeps filling the form", async () => {
    const page = await openFixture();
    try {
      await page.evaluate(() => {
        const d = document.createElement("div");
        d.className = "g-recaptcha";
        document.body.appendChild(d);
      });

      const outcomes = await fillForm(page, personal, null, resume);
      const widget = outcomes.find((o) => o.label === "Bot protection on this page");
      expect(widget).toMatchObject({ status: "needs-you" });
      expect(widget!.detail).toContain("It is not touched");
      // The point of the fix: the rest of the form still got filled.
      expect(find(outcomes, L.firstName)).toMatchObject({ status: "filled" });
    } finally {
      await page.close();
    }
  }, 60_000);

  it("stops the run on an active challenge instead of working around it", async () => {
    const page = await openFixture();
    try {
      await page.evaluate(() => {
        const f = document.createElement("iframe");
        // Matches the blocking marker without loading anything: the selector
        // keys on the src substrings, and about: makes no request.
        f.src = "about:blank#recaptcha-bframe";
        f.style.width = "300px";
        f.style.height = "200px";
        document.body.appendChild(f);
      });

      await expect(fillForm(page, personal, null, resume)).rejects.toThrow(/active bot challenge/i);
      // Nothing was typed before it stopped.
      expect(await page.locator("#first_name").inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("when there is no resume to attach", () => {
  // GitHub #11: `opts.resumeFile` was accepted and never read, so the report
  // said "no resume file found" while the file sat on disk. The inverse is
  // pinned here - with genuinely nothing to attach, the field is reported, and
  // nothing is invented.
  it("reports the file input instead of attaching something arbitrary", async () => {
    const page = await openFixture();
    try {
      const outcomes = await fillForm(page, personal, null, null);
      const o = find(outcomes, L.attach);
      expect(o).toMatchObject({ intent: "resume", status: "needs-you" });
      expect(o!.detail).toContain("no resume file found");

      const count = await page
        .locator("#resume")
        .evaluate((el) => (el as HTMLInputElement).files?.length ?? 0);
      expect(count).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("the prepared-pack second pass", () => {
  let page: Page;
  let outcomes: FieldOutcome[];

  const pack = {
    formAnswers: [
      { question: "Why do you want to work here?", answer: "Drafted answer about the product." },
      {
        question: "I certify that the information above is true and complete",
        answer: "SHOULD NEVER BE TYPED INTO AN ATTESTATION",
      },
    ],
  } as unknown as ApplicationPack;

  beforeAll(async () => {
    ({ page, outcomes } = await run(pack));
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  it("fills a free-text question from the pack and tells you to read it", async () => {
    expect(await page.locator("#why_vercel").inputValue()).toBe("Drafted answer about the product.");
    expect(find(outcomes, L.whyHere)).toMatchObject({ status: "filled" });
    expect(find(outcomes, L.whyHere)!.detail).toContain("READ IT");
  });

  it("refuses to type a prepared answer into an attestation, even an exact match", async () => {
    // The pack answer's question string is character-for-character the label.
    // The guard is the intent check, not the match score.
    expect(await page.locator("#attest_text").inputValue()).toBe("");
    expect(find(outcomes, L.attestText)).toMatchObject({ status: "needs-you" });
  });
});
