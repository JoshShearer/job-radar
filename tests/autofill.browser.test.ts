import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capturableAnswers, saveAnswers } from "../src/apply/learn.js";
import {
  fillForm,
  snapshotFields,
  waitForControls,
  settlePage,
  CONTROL_SETTLE_MS,
  type FieldOutcome,
} from "../src/apply/autofill.js";
import { chooseResume, type ResumeChoice } from "../src/apply/resume-file.js";
import { loadPersonal, type Personal } from "../src/config/personal.js";
import type { ApplicationPack } from "../src/analysis/application.js";
import type { Resume } from "../src/resume/schema.js";

/**
 * Stub employment history. Invented, and kept here rather than read from
 * config/resume.yaml for the same reason as the personal stub: a test must not
 * depend on the real person's data, and must not change when they edit it.
 */
const MASTER_RESUME = {
  experience: [
    {
      id: "role-old",
      company: "Analytical Engine Co",
      title: "Engineer",
      start: "2019-01",
      end: "2022-06",
      location: "",
      context: "",
      employment_type: "full_time",
      bullets: [],
    },
    {
      id: "role-current",
      company: "Difference Engine Ltd",
      title: "Head of Computation",
      start: "2022-07",
      end: null,
      location: "",
      context: "",
      employment_type: "full_time",
      bullets: [],
    },
  ],
} as unknown as Resume;

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
  describeProduct: "Describe a product you built from the ground up",
  attestInput: "I acknowledge that the information provided is accurate",
  currentCompany: "Current/Most Recent Company Name",
  currentTitle: "Current/Most Recent Job Title",
} as const;

/**
 * The prepared-pack answers, including four that must never be typed. Shared,
 * because the second pass has to be proved safe on an embedded form too and a
 * second copy would be free to drift away from this one.
 */
const PACK = {
  formAnswers: [
    { question: "Why do you want to work here?", answer: "Drafted answer about the product." },
    {
      question: "I certify that the information above is true and complete",
      answer: "SHOULD NEVER BE TYPED INTO AN ATTESTATION",
    },
    {
      question: "Describe a product you built from the ground up",
      answer: "Drafted answer about a product built from scratch.",
    },
    {
      question: "I acknowledge that the information provided is accurate",
      answer: "SHOULD NEVER BE TYPED INTO AN ATTESTATION",
    },
    { question: "Email", answer: "SHOULD NEVER OVERWRITE A RULE-FILLED FIELD" },
  ],
} as unknown as ApplicationPack;

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
  const outcomes = await fillForm(page, personal, pack, resume, MASTER_RESUME);
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

  it("answers current company and title from the master resume", async () => {
    // These sat blank on a real Ashby form while config/resume.yaml held both.
    expect(find(outcomes, L.currentCompany)).toMatchObject({
      intent: "current_company",
      status: "filled",
    });
    expect(find(outcomes, L.currentTitle)).toMatchObject({ intent: "current_title", status: "filled" });
    // The report names the role it used, so a wrong pick is visible.
    expect(find(outcomes, L.currentCompany)!.detail).toContain("resume.yaml");
    expect(await page.locator("#current_company").inputValue()).not.toBe("");
    expect(await page.locator("#current_title").inputValue()).not.toBe("");
  });

  it("answers the embedded state-list question from the list inside it", () => {
    // "Do you live in one of the following states? Alabama, ..." is a yes/no
    // question whose correct answer depends on the list in the question text.
    const o = find(outcomes, L.states);
    expect(o).toMatchObject({ status: "filled" });
    expect(o!.detail).toMatch(/^No /); // Texas is not in that list
  });
});

describe("waiting for a client-rendered form", () => {
  // A flat post-navigation delay read the Vanta/Ashby form before it existed:
  // 0 controls at 1.2s, 32 by 4s. `enumerateControls` then ran against an empty
  // document and the report said "Filled: 0 / For you: 0", which is
  // indistinguishable from a form that had nothing to fill.
  const latePage = (delayMs: number, count = 3) => `
    <!doctype html><html><body><form id="f"></form>
    <script>
      setTimeout(() => {
        const f = document.getElementById("f");
        for (let i = 0; i < ${count}; i++) {
          const l = document.createElement("label");
          l.setAttribute("for", "c" + i);
          l.textContent = "Email";
          const el = document.createElement("input");
          el.type = "text"; el.id = "c" + i; el.name = "c" + i;
          f.appendChild(l); f.appendChild(el);
        }
      }, ${delayMs});
    </script></body></html>`;

  it("finds controls that appear well after the page loads", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(latePage(800), { waitUntil: "load" });
      expect(await page.locator("input").count()).toBe(0); // not there yet

      const found = await waitForControls(page, { settleMs: 300 });
      expect(found).toBe(3);
      expect(await page.locator("input").count()).toBe(3);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("waits for the count to settle rather than grabbing the first control", async () => {
    // Controls arriving in two bursts 300ms apart. Returning as soon as
    // something appeared would enumerate a partial form and silently skip the
    // rest. Bursts further apart than the settle window cannot be caught by any
    // finite wait, which is why that window is generous.
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body><form id="f"></form>
        <script>
          const add = (n) => { const f = document.getElementById("f");
            for (let i = 0; i < n; i++) { const el = document.createElement("input");
              el.type = "text"; el.name = "x" + f.children.length + "-" + i; f.appendChild(el); } };
          setTimeout(() => add(2), 200);
          setTimeout(() => add(4), 500);
        </script></body></html>`,
        { waitUntil: "load" },
      );
      expect(await waitForControls(page, { settleMs: 400 })).toBe(6);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("returns instead of hanging when a page never renders a control", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><html><body><p>No form here.</p></body></html>", {
        waitUntil: "load",
      });
      const started = Date.now();
      expect(await waitForControls(page, { timeoutMs: 1500 })).toBe(0);
      // Bounded by the cap, not by the default.
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("defaults to a settle window at least as long as the fixed delay it replaced", () => {
    // The behavioural tests above pass short windows to stay fast, so the
    // default is pinned separately. It must stay generous: bursts further apart
    // than this window return early, and shrinking it to speed up a run would
    // reintroduce the partial-form read this whole function exists to prevent.
    expect(CONTROL_SETTLE_MS).toBeGreaterThanOrEqual(1200);
  });

  it("returns immediately for a form that is already painted", async () => {
    const page = await openFixture();
    try {
      const started = Date.now();
      const n = await waitForControls(page, { settleMs: 300 });
      expect(n).toBeGreaterThan(20);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("learning an answer from what the human typed", () => {
  // The whole point of the tool: answer a question once, never again. The
  // `answers` list in personal.yaml has always been checked before every
  // built-in rule, and nothing ever wrote to it.
  it("captures a hand-typed answer, saves it, and fills it on the next run", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "job-radar-learn-e2e-"));
    const configFile = resolve(dir, "personal.yaml");
    writeFileSync(configFile, readFileSync(PERSONAL_STUB, "utf8"), "utf8");

    const first = await openFixture();
    try {
      const outcomes = await fillForm(first, personal, null, resume, MASTER_RESUME);
      // Nothing matched this question, so the tool leaves it alone...
      expect(find(outcomes, L.whyHere)!.status).not.toBe("filled");

      // ...who types an answer into the browser.
      await first.locator("#why_vercel").fill("Because I use the product every day.");

      const snapshot = await snapshotFields(first);
      const learned = capturableAnswers(snapshot, outcomes, loadPersonal(configFile).answers);
      expect(learned).toContainEqual({
        match: L.whyHere,
        answer: "Because I use the product every day.",
      });

      saveAnswers(configFile, learned);
    } finally {
      await first.close();
    }

    // Next application: the same question now answers itself.
    const second = await openFixture();
    try {
      const outcomes = await fillForm(second, loadPersonal(configFile), null, resume, MASTER_RESUME);
      expect(find(outcomes, L.whyHere)).toMatchObject({ status: "filled" });
      expect(await second.locator("#why_vercel").inputValue()).toBe(
        "Because I use the product every day.",
      );
    } finally {
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("never learns a demographic answer, even when the human typed one", async () => {
    // A human may choose to disclose on one form. Storing that choice would
    // make the tool disclose it on every later form without being asked.
    const page = await openFixture();
    try {
      const outcomes = await fillForm(page, personal, null, resume, MASTER_RESUME);
      await page.locator('[id="4015790004"]').fill("Man");
      await page.locator("#attest_text").fill("I agree to all of it");

      const learned = capturableAnswers(await snapshotFields(page), outcomes, []);
      expect(learned.map((l) => l.match)).not.toContain(EEO_LABELS[0]);
      expect(learned.map((l) => l.answer)).not.toContain("Man");
      expect(learned.map((l) => l.answer)).not.toContain("I agree to all of it");
    } finally {
      await page.close();
    }
  }, 60_000);
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

  it("does not spend the control-wait on a page that is showing a challenge", async () => {
    // A challenge page never paints an application form, so waiting the full
    // 15s cap on one only delays the refusal. `fillForm` is still what stops
    // the run; this just gets there promptly.
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<!doctype html><html><body>
         <iframe src="about:blank#recaptcha-bframe" style="width:300px;height:200px"></iframe>
         </body></html>`,
        { waitUntil: "load" },
      );
      const started = Date.now();
      expect((await settlePage(page)).count).toBe(0);
      expect(Date.now() - started).toBeLessThan(8000); // not the 15s cap
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

describe("the cover letter", () => {
  // It was generated for every application and then buried in a markdown pack,
  // so every cover-letter input on every form was left for a human with a
  // clipboard. It is a document now.
  it("is attached to a cover letter input when one has been generated", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "job-radar-cover-"));
    const cover = resolve(dir, "Ada_Lovelace_Cover_Letter_Acme.pdf");
    writeFileSync(cover, "%PDF-1.4\n", "utf8");
    const page = await openFixture();
    try {
      const outcomes = await fillForm(page, personal, null, resume, MASTER_RESUME, cover);
      const o = outcomes.find((x) => x.intent === "cover_letter");
      expect(o).toMatchObject({ status: "filled" });
      expect(o!.detail).toContain("Ada_Lovelace_Cover_Letter_Acme.pdf");
      expect(o!.detail).toContain("READ IT");

      const attached = await page.locator("#cover_letter").evaluate((el) => {
        const f = (el as HTMLInputElement).files;
        return { n: f?.length ?? 0, name: f?.[0]?.name ?? null };
      });
      expect(attached).toEqual({ n: 1, name: "Ada_Lovelace_Cover_Letter_Acme.pdf" });
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("still asks the human when no cover letter was generated", async () => {
    const page = await openFixture();
    try {
      const outcomes = await fillForm(page, personal, null, resume, MASTER_RESUME);
      const o = outcomes.find((x) => x.intent === "cover_letter");
      expect(o!.status).toBe("needs-you");
      const n = await page.locator("#cover_letter").evaluate((el) => (el as HTMLInputElement).files?.length ?? 0);
      expect(n).toBe(0);
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

  beforeAll(async () => {
    ({ page, outcomes } = await run(PACK));
  }, 60_000);

  afterAll(async () => {
    await page?.close();
  });

  it("fills a free-text question from the pack and tells you to read it", async () => {
    expect(await page.locator("#why_vercel").inputValue()).toBe("Drafted answer about the product.");
    expect(find(outcomes, L.whyHere)).toMatchObject({ status: "filled" });
    expect(find(outcomes, L.whyHere)!.detail).toContain("READ IT");
  });

  it("fills a single-line text question from the pack, as Ashby renders them", async () => {
    // The second pass used to consider <textarea> only, so on a board that
    // renders long-form questions as <input type="text"> every drafted answer
    // in the pack was unreachable - loaded, and never used.
    expect(await page.locator("#describe_product").inputValue()).toBe(
      "Drafted answer about a product built from scratch.",
    );
    expect(find(outcomes, L.describeProduct)).toMatchObject({ status: "filled" });
    expect(find(outcomes, L.describeProduct)!.detail).toContain("READ IT");
  });

  it("refuses an attestation rendered as a text input, not just as a textarea", async () => {
    expect(await page.locator("#attest_input").inputValue()).toBe("");
    expect(find(outcomes, L.attestInput)).toMatchObject({ intent: "attestation", status: "needs-you" });
  });

  it("never lets a pack answer overwrite a field a rule already filled", async () => {
    // The pack carries an answer whose question is literally "Email".
    expect(await page.locator("#email").inputValue()).toBe("ada@example.invalid");
  });

  it("refuses to type a prepared answer into an attestation, even an exact match", async () => {
    // The pack answer's question string is character-for-character the label.
    // The guard is the intent check, not the match score.
    expect(await page.locator("#attest_text").inputValue()).toBe("");
    expect(find(outcomes, L.attestText)).toMatchObject({ status: "needs-you" });
  });
});

// ---------------------------------------------------------------------------
// JOB-18: a form the host page lazy-mounts into an iframe.
//
// Measured on https://www.samsara.com/company/careers/roles/7847219 :
//   before scrolling: 3 frames, 2 main-frame controls, no Greenhouse frame
//   after  scrolling: 8 frames, grnhse_iframe -> 42 controls
//
// The run against that page reported "Filled: 0 / For you: 0" and listed one
// field, "Select region" - the host page's footer language picker. That output
// is indistinguishable from a form with nothing to fill.
//
// These tests drive the same shape from file://, and they are not a rerun of
// the direct-board suite for its own sake: every refusal is re-asserted HERE
// because each one was reached through `page.locator` / `page.evaluate`, and
// all of those now resolve against a different document.
// ---------------------------------------------------------------------------
describe("a form the page lazy-mounts into an iframe", () => {
  const HOST = resolve(import.meta.dirname, "fixtures", "embedded-host.html");

  let page: Page;
  let outcomes: FieldOutcome[];
  let form: Awaited<ReturnType<typeof settlePage>>;
  /** The frame the form is in - what every assertion below must read. */
  let formFrame: ReturnType<Page["frames"]>[number];

  beforeAll(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(pathToFileURL(HOST).href, { waitUntil: "load" });
    form = await settlePage(page);
    outcomes = await fillForm(form.scope, personal, PACK, resume, MASTER_RESUME);
    formFrame = page.frames().find((f) => f.name() === "grnhse_iframe")!;
  }, 90_000);

  afterAll(async () => {
    await page?.close();
  });

  it("mounts the form only after the page is scrolled", async () => {
    // Pins the premise. If the fixture ever stopped being lazy, every test
    // below would still pass while testing nothing about lazy mounting.
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await fresh.goto(pathToFileURL(HOST).href, { waitUntil: "load" });
      await fresh.waitForTimeout(2000);
      expect(fresh.frames().some((f) => f.name() === "grnhse_iframe")).toBe(false);
      expect(await fresh.locator("input, textarea, select, [role='combobox']").count()).toBe(1);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("finds the embedded form rather than the host page's decoy control", () => {
    // The host page has exactly one control, "Select region". Settling on it is
    // the failure this whole issue is about, so "found something" is not the
    // assertion - "found the RIGHT something" is.
    expect(form.count).toBeGreaterThan(20);
    expect(form.counts.map((c) => c.name)).toContain("grnhse_iframe");
    expect(form.counts[0]!.name).toBe("grnhse_iframe");
  });

  it("reports the host page it passed over, so a wrong pick is visible", () => {
    const host = form.counts.find((c) => c.name !== "grnhse_iframe");
    expect(host).toBeDefined();
    expect(host!.count).toBe(1); // the "Select region" decoy
  });

  it("fills the identity fields inside the frame", async () => {
    expect(await formFrame.locator("#first_name").inputValue()).toBe("Ada");
    expect(find(outcomes, L.firstName)).toMatchObject({ status: "filled" });
  });

  it("does not type into the host page", async () => {
    // The decoy is still on its default. A driver that "found a form" on the
    // host page would have changed this.
    expect(await page.locator("#region").inputValue()).toBe("en-us");
  });

  it("attaches the resume through the frame", () => {
    expect(find(outcomes, L.attach)).toMatchObject({ status: "filled" });
  });

  // --- The refusals, re-asserted against the embedded document -------------

  it("never answers a demographic question, and says why", async () => {
    // Asserted at the same strength as the direct-board suite, deliberately.
    // A weaker version of this test - status alone, no intent, no reason -
    // survived a mutant that answers EEO questions, because those controls are
    // comboboxes and an unmatched combobox also fails to fill. "Not filled" and
    // "refused" are different facts, and only the second one is the refusal.
    for (const label of EEO_LABELS) {
      const o = find(outcomes, label);
      expect(o, `missing outcome for ${label}`).toBeDefined();
      expect(o!.intent).toBe("eeo");
      expect(o!.status).not.toBe("filled");
      expect(o!.detail).toContain("demographic self-identification is yours");
    }
    // And nothing is selected in the DOM either.
    const checked = await formFrame.locator("input[type=radio]:checked, input[type=checkbox]:checked").count();
    expect(checked).toBe(0);
    for (const id of ["4015790004", "4015786004", "4015785004", "4015783004", "4015781004", "4015780004"]) {
      expect(await formFrame.locator(`[id="${id}"]`).inputValue()).toBe("");
    }
  });

  it("never ticks a checkbox", async () => {
    const consent = find(outcomes, L.consent);
    expect(consent).toMatchObject({ status: "needs-you" });
    expect(await formFrame.locator("#consent").isChecked()).toBe(false);
  });

  it("never affirms an attestation", async () => {
    expect(find(outcomes, L.privacy)).toMatchObject({ status: "needs-you" });
    expect(await formFrame.locator("#attest_text").inputValue()).toBe("");
    expect(await formFrame.locator("#attest_input").inputValue()).toBe("");
  });

  it("never submits", async () => {
    // The fixture's submit button records its own clicks.
    expect(await formFrame.evaluate(() => (window as never as { __submitted?: boolean }).__submitted ?? false)).toBe(
      false,
    );
  });

  it("scopes each combobox to its own listbox inside the frame", () => {
    // The phone-country picker keeps ~244 options mounted. A global option
    // query returns that list whichever menu was opened. Getting a real
    // country back here means aria-controls resolved in the right document.
    const country = find(outcomes, L.country);
    expect(country).toMatchObject({ status: "filled" });
    expect(country!.detail).toContain("United States");
  });

  it("still reaches the prepared-pack second pass through the frame", async () => {
    expect(await formFrame.locator("#describe_product").inputValue()).toBe(
      "Drafted answer about a product built from scratch.",
    );
  });

  it("captures what was typed, so answer-learning is not silently dead", async () => {
    // snapshotFields reads [data-jr-idx], which is now written in the frame.
    // Reading only the main frame would return an empty list forever: the
    // feature would keep running, keep succeeding, and never learn anything.
    const snapshot = await snapshotFields(page);
    expect(snapshot.length).toBeGreaterThan(20);
    expect(snapshot.find((f) => f.label.includes("First Name"))?.value).toBe("Ada");
  });
});

describe("a bot challenge inside the embedded frame", () => {
  const HOST = resolve(import.meta.dirname, "fixtures", "embedded-host.html");

  it("stops the run even though the challenge is not in the main frame", async () => {
    // Before JOB-18 the probes were main-frame only, so a challenge inside the
    // embed could not match any BLOCKING_MARKER. The refusal did not weaken -
    // it stopped existing, on exactly the boards that embed an ATS.
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.goto(pathToFileURL(HOST).href, { waitUntil: "load" });
      const form = await settlePage(page);
      const frame = page.frames().find((f) => f.name() === "grnhse_iframe")!;

      await frame.evaluate(() => {
        const f = document.createElement("iframe");
        // Matches the blocking marker without loading anything.
        f.src = "about:blank#recaptcha-bframe";
        f.style.width = "300px";
        f.style.height = "200px";
        document.body.appendChild(f);
      });

      await expect(fillForm(form.scope, personal, null, resume)).rejects.toThrow(/active bot challenge/i);
      expect(await frame.locator("#first_name").inputValue()).toBe("");
    } finally {
      await page.close();
    }
  }, 90_000);
});
