import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config/load.js";
import { chooseResume, describeResumeChoice, type ResumeChoice } from "./resume-file.js";
import type { Personal } from "../config/personal.js";
import type { ApplicationPack } from "../analysis/application.js";
import type { EnrichedJob } from "../model/job.js";
import { log } from "../lib/log.js";
import {
  chooseOption,
  classifyLabel,
  decide,
  isSubmitControl,
  isYesNoOptions,
  matchPreparedAnswer,
  stateListAnswer,
  type FieldIntent,
} from "./fields.js";

/**
 * Fills a job application form in a real browser and stops at the submit
 * button.
 *
 * What this does NOT do, by construction:
 * - It never clicks submit. It never clicks any control whose text looks like
 *   a submit control. The browser is left open with the form filled so a human
 *   reads it and presses the button.
 * - It never answers demographic questions or attestations. See NEVER_FILL.
 * - It never solves, bypasses, or works around a CAPTCHA or bot check. If one
 *   appears the run stops and hands the browser over.
 *
 * The browser is headed on purpose. Watching it type is the review step.
 */

const BROWSER_PROFILE = resolve(PROJECT_ROOT, ".browser-profile");

export interface FieldOutcome {
  label: string;
  intent: FieldIntent;
  status: "filled" | "skipped" | "needs-you";
  detail: string;
}

export interface AutofillResult {
  url: string;
  outcomes: FieldOutcome[];
  screenshot: string | null;
  context: BrowserContext;
  page: Page;
}

interface ControlInfo {
  idx: number;
  kind: "text" | "textarea" | "file" | "select" | "combobox" | "radio" | "checkbox";
  label: string;
  /** The label was longer than the cap, so any list inside it is incomplete. */
  truncated: boolean;
  name: string;
  required: boolean;
}

/**
 * Bot-protection detection.
 *
 * Two outcomes, and the distinction matters. Nearly every Greenhouse form
 * embeds an invisible reCAPTCHA Enterprise badge that challenges nobody -
 * treating its mere presence as a block means the tool refuses to fill any
 * Greenhouse form at all. An actual interstitial or challenge popup is a
 * different thing and does stop the run.
 *
 * In neither case is the protection touched, scored, solved, or worked around.
 * This drives an ordinary browser, does not mask itself, and leaves submission
 * to a human. If a site's bot scoring rejects that, the answer is to fill the
 * form by hand, not to start faking signals.
 */
export type Challenge = { kind: "blocking" | "widget"; marker: string } | null;

const BLOCKING_MARKERS = [
  "#cf-challenge-running",
  ".cf-browser-verification",
  // The challenge POPUP (bframe), not the badge/checkbox anchor.
  "iframe[src*='recaptcha'][src*='bframe']",
  "iframe[src*='hcaptcha'][src*='challenge']",
  "text=/verify (that )?you are (a )?human/i",
  "text=/checking your browser before accessing/i",
];

const WIDGET_MARKERS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  ".g-recaptcha",
  ".h-captcha",
];

/**
 * Split out from the page so it can be tested without a browser: `visible` and
 * `present` are the only things it needs from the DOM.
 */
export async function detectChallenge(
  visible: (selector: string) => Promise<boolean>,
  present: (selector: string) => Promise<boolean>,
): Promise<Challenge> {
  for (const marker of BLOCKING_MARKERS) {
    if (await visible(marker)) return { kind: "blocking", marker };
  }
  for (const marker of WIDGET_MARKERS) {
    if (await present(marker)) return { kind: "widget", marker };
  }
  return null;
}

function pageProbes(page: Page) {
  const visible = async (sel: string) => {
    try {
      return await page.locator(sel).first().isVisible({ timeout: 250 });
    } catch {
      return false;
    }
  };
  const present = async (sel: string) => {
    try {
      return (await page.locator(sel).count()) > 0;
    } catch {
      return false;
    }
  };
  return { visible, present };
}

/**
 * Tag every visible form control with a stable index and read back its label.
 * Done in one pass in the page so we are not making a round trip per element,
 * and so label resolution can use the DOM relationships the browser already
 * has (aria-labelledby, label[for], ancestor <label>).
 */
async function enumerateControls(page: Page): Promise<ControlInfo[]> {
  return page.evaluate(() => {
    const out: Array<{
      idx: number;
      kind: string;
      label: string;
      truncated: boolean;
      name: string;
      required: boolean;
    }> = [];

    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("input, textarea, select, [role='combobox']"),
    );

    let idx = 0;
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const role = el.getAttribute("role") || "";

      if (type === "hidden") continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      // File inputs are routinely visually hidden behind a styled button, so
      // they are exempt from the visibility check.
      if (type !== "file" && el.offsetParent === null && el.getBoundingClientRect().height === 0) continue;

      let kind: string;
      if (role === "combobox") kind = "combobox";
      else if (tag === "select") kind = "select";
      else if (tag === "textarea") kind = "textarea";
      else if (type === "file") kind = "file";
      else if (type === "radio") kind = "radio";
      else if (type === "checkbox") kind = "checkbox";
      else if (tag === "input") kind = "text";
      else continue;

      // Resolve a human label the same way a screen reader would.
      let label = el.getAttribute("aria-label") || "";
      if (!label) {
        const lb = el.getAttribute("aria-labelledby");
        if (lb) {
          label = lb
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ")
            .trim();
        }
      }
      if (!label && el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        label = forLabel?.textContent?.trim() || "";
      }
      if (!label) {
        const anc = el.closest("label");
        label = anc?.textContent?.trim() || "";
      }
      if (!label) label = el.getAttribute("placeholder") || el.getAttribute("name") || "";

      el.setAttribute("data-jr-idx", String(idx));
      const flat = label.replace(/\s+/g, " ");
      // The cap is generous because some questions embed the data needed to
      // answer them (a list of states, a list of countries). Truncation is
      // reported so a caller can refuse to answer from a partial list.
      const CAP = 2000;
      out.push({
        idx,
        kind,
        label: flat.slice(0, CAP),
        truncated: flat.length > CAP,
        name: el.getAttribute("name") || el.id || "",
        required: el.getAttribute("aria-required") === "true" || el.hasAttribute("required"),
      });
      idx++;
    }
    return out;
  }) as Promise<ControlInfo[]>;
}

/**
 * Open a react-select combobox and return a locator scoped to ITS menu.
 *
 * Scoping is not a nicety. A Greenhouse page has ~244 `[role=option]` elements
 * sitting in the DOM before anything is clicked, because the phone-number
 * country picker keeps its whole dial-code list mounted. A global option query
 * therefore returns a country list no matter which dropdown you opened, and
 * happily "matches" against it. react-select points `aria-controls` at the
 * correct listbox once the menu opens; that is the only reliable handle.
 */
async function openMenu(page: Page, control: Locator): Promise<Locator | null> {
  await control.click({ timeout: 5000 });
  for (let i = 0; i < 20; i++) {
    const id = await control.getAttribute("aria-controls").catch(() => null);
    if (id) return page.locator(`[id="${id}"]`);
    await page.waitForTimeout(100);
  }
  return null;
}

async function readOptions(menu: Locator): Promise<string[]> {
  const options = menu.locator("[role='option'], .select__option");
  try {
    await options.first().waitFor({ state: "visible", timeout: 1500 });
  } catch {
    return [];
  }
  const texts = await options.allInnerTexts();
  return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(80);
}

/**
 * Choose an option in a combobox. Returns the chosen text, or null when
 * nothing matched confidently enough to be worth putting on a real
 * application. `onOptions` sees the real option list, which lets a caller
 * answer a question whose correct response depends on what is offered.
 */
async function selectFromCombobox(
  page: Page,
  control: Locator,
  desired: string,
  onOptions?: (options: string[]) => string | null,
): Promise<SelectResult> {
  const menu = await openMenu(page, control);
  if (!menu) {
    await closeMenu(page);
    return { chosen: null, options: [] };
  }

  const seen = await readOptions(menu);
  let options = seen;
  const want = (onOptions && options.length ? onOptions(options) : null) ?? desired;

  // Long lists filter as you type. If the first read had no confident match,
  // narrow it and look again in the same (still correctly scoped) menu.
  let match = options.length ? chooseOption(want, options) : null;
  if (!match) {
    await control.fill(want.split(/\s+/).slice(0, 2).join(" ")).catch(() => {});
    await page.waitForTimeout(350);
    options = await readOptions(menu);
    match = options.length ? chooseOption(want, options) : null;
  }

  if (!match || isSubmitControl(match.option)) {
    await control.fill("").catch(() => {});
    await closeMenu(page);
    return { chosen: null, options: seen.length ? seen : options };
  }

  const target = menu.locator("[role='option'], .select__option").filter({ hasText: match.option }).first();
  try {
    await target.click({ timeout: 3000 });
  } catch {
    await closeMenu(page);
    return { chosen: null, options: seen };
  }
  await page.waitForTimeout(120);
  return { chosen: match.option, options: seen };
}

interface SelectResult {
  chosen: string | null;
  options: string[];
}

/**
 * When nothing matched, the report should say what WAS on offer. A bare "could
 * not match" makes the human go dig through the form; the option list lets
 * them paste the right phrase straight into personal.yaml and never see the
 * question again.
 */
function offered(options: string[], limit = 8): string {
  if (!options.length) return "";
  const shown = options.slice(0, limit).map((o) => `"${o.length > 60 ? `${o.slice(0, 59)}...` : o}"`);
  const more = options.length > limit ? `, +${options.length - limit} more` : "";
  return ` Offered: ${shown.join(", ")}${more}`;
}

/**
 * Decide and fill, given a page that is already open on the form.
 *
 * Split from `autofillApplication` for the same reason `detectChallenge` was
 * split from the page: this is the half that carries the refusals, and it is
 * worth being able to run it against a saved form instead of only against a
 * live posting. Launching a browser a human watches is a separate concern from
 * deciding what belongs in each field, and only the second one can make a false
 * statement on an application.
 *
 * Everything here is reported, never silently skipped. The return value is the
 * whole record of what happened.
 */
export async function fillForm(
  page: Page,
  personal: Personal,
  pack: ApplicationPack | null,
  resume: ResumeChoice | null,
): Promise<FieldOutcome[]> {
  const { visible, present } = pageProbes(page);
  const challenge = await detectChallenge(visible, present);
  if (challenge?.kind === "blocking") {
    throw new Error(
      `This page is showing an active bot challenge (${challenge.marker}). Stopping - I will not work around it.\n` +
        `Run without --headless, solve it yourself, then re-run this command.`,
    );
  }

  const controls = await enumerateControls(page);
  log.info(`Found ${controls.length} form controls`);

  const outcomes: FieldOutcome[] = [];

  if (challenge?.kind === "widget") {
    outcomes.push({
      label: "Bot protection on this page",
      intent: "unknown",
      status: "needs-you",
      detail:
        "there is a CAPTCHA widget here. It is not touched. If it shows a checkbox, tick it yourself before submitting",
    });
  }
  for (const c of controls) {
    // File inputs are usually labelled by their styled button ("Attach"), which
    // says nothing. Their id does: `resume`, `cover_letter`.
    let intent = classifyLabel(c.label);
    if (intent === "unknown" && c.name) intent = classifyLabel(c.name);

    const el = page.locator(`[data-jr-idx="${c.idx}"]`);
    const label = c.label || `(unlabelled ${c.kind})`;

    // Checkboxes on application forms are almost always consent or
    // attestation. Ticking one is a statement by the candidate, so they are
    // always left alone and reported.
    if (c.kind === "checkbox") {
      outcomes.push({
        label,
        intent,
        status: "needs-you",
        detail: "checkbox left unticked - consents and attestations are yours to give",
      });
      continue;
    }

    const decision = decide(c.label, intent, { personal, pack });

    if (decision.action === "skip") {
      outcomes.push({
        label,
        intent,
        status: decision.consequential || c.required ? "needs-you" : "skipped",
        detail: decision.why,
      });
      continue;
    }

    try {
      if (decision.action === "file") {
        if (decision.kind === "resume") {
          if (!resume) {
            outcomes.push({
              label,
              intent,
              status: "needs-you",
              detail:
              "no resume file found. Generate one with `resume tailor <job-id>`, " +
              "or drop a PDF in resumes/, or attach it yourself",
            });
            continue;
          }
          await el.setInputFiles(resume.path);
          outcomes.push({ label, intent, status: "filled", detail: describeResumeChoice(resume) });
        } else {
          // Cover letter: prefer typing the prepared note over uploading a file.
          outcomes.push({
            label,
            intent,
            status: "needs-you",
            detail: pack
              ? "cover note is in the pack - paste it after reading it"
              : "no prepared cover note",
          });
        }
        continue;
      }

      if (decision.action === "fill") {
        if (c.kind === "combobox" || c.kind === "select") {
          const r: SelectResult =
            c.kind === "select"
              ? await el
                  .selectOption({ label: decision.value })
                  .then(() => ({ chosen: decision.value, options: [] }))
                  .catch(() => ({ chosen: null, options: [] }))
              : await selectFromCombobox(page, el, decision.value);
          outcomes.push(
            r.chosen
              ? { label, intent, status: "filled", detail: `${r.chosen} (${decision.why})` }
              : {
                  label,
                  intent,
                  status: "needs-you",
                  detail: `could not match "${decision.value}".${offered(r.options)}`,
                },
          );
        } else {
          await el.fill(decision.value);
          outcomes.push({ label, intent, status: "filled", detail: `${truncate(decision.value)} (${decision.why})` });
        }
        continue;
      }

      if (decision.action === "select") {
        let chosen: string | null = null;

        // "Do you live in one of the following states? Alabama, Alaska, ..."
        // is a yes/no question, not a state picker. Which answer is correct
        // depends on the list inside the question text, so it can only be
        // resolved once the real options are visible.
        const resolve =
          intent === "state"
            ? (options: string[]) =>
                isYesNoOptions(options) ? stateListAnswer(c.label, personal.identity.state, c.truncated) : null
            : undefined;

        let seenOptions: string[] = [];
        if (c.kind === "select") {
          seenOptions = (await el.locator("option").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
          const want = resolve?.(seenOptions) ?? decision.desired;
          const m = chooseOption(want, seenOptions);
          if (m) chosen = await el.selectOption({ label: m.option }).then(() => m.option).catch(() => null);
        } else if (c.kind === "combobox") {
          const r = await selectFromCombobox(page, el, decision.desired, resolve);
          chosen = r.chosen;
          seenOptions = r.options;
        } else if (c.kind === "radio") {
          const m = chooseOption(decision.desired, [c.label]);
          if (m && !isSubmitControl(c.label)) {
            await el.check();
            chosen = c.label;
          }
        }
        outcomes.push(
          chosen
            ? { label, intent, status: "filled", detail: `${chosen} (${decision.why})` }
            : {
                label,
                intent,
                status: "needs-you",
                detail: `no confident match for "${decision.desired}".${offered(seenOptions)}`,
              },
        );
      }
    } catch (err) {
      outcomes.push({ label, intent, status: "needs-you", detail: `could not fill: ${(err as Error).message}` });
    }
  }

  // Second pass: free-text boxes that no rule claimed, matched against the
  // answers already drafted in the application pack.
  if (pack?.formAnswers?.length) {
    for (const c of controls) {
      if (c.kind !== "textarea") continue;
      const already = outcomes.find((o) => o.label === (c.label || `(unlabelled ${c.kind})`));
      if (already && already.status === "filled") continue;
      const intent = classifyLabel(c.label);
      if (intent === "eeo" || intent === "attestation") continue;

      const m = matchPreparedAnswer(c.label, pack.formAnswers);
      if (!m) continue;
      try {
        await page.locator(`[data-jr-idx="${c.idx}"]`).fill(m.answer);
        const entry = outcomes.find((o) => o.label === c.label);
        const detail = `drafted answer to "${truncate(m.matched)}" - READ IT`;
        if (entry) {
          entry.status = "filled";
          entry.detail = detail;
        } else {
          outcomes.push({ label: c.label, intent, status: "filled", detail });
        }
      } catch {
        // Leave it for the human; the pack has the text.
      }
    }
  }

  return outcomes;
}

export async function autofillApplication(
  job: EnrichedJob,
  personal: Personal,
  pack: ApplicationPack | null,
  opts: { screenshotDir?: string; headless?: boolean; resume?: ResumeChoice } = {},
): Promise<AutofillResult> {
  const url = job.applicationUrl ?? job.sourceUrl;
  if (!url) throw new Error("This job has no application URL.");

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    // Headed by default: watching it type IS the review step. Headless exists
    // to verify field classification against a live form without opening a
    // window, and is useless for actually applying - the filled form dies with
    // the process.
    headless: opts.headless === true,
    viewport: { width: 1280, height: 1000 },
    args: ["--window-size=1300,1050"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  log.info(`Opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1200);

  // A resume tailored to THIS posting wins over anything generic in resumes/.
  // The caller normally decides and hands over the whole choice; the fallback
  // is for programmatic callers, never a re-derivation of one that was passed.
  const outcomes = await fillForm(page, personal, pack, opts.resume ?? chooseResume());

  let screenshot: string | null = null;
  if (opts.screenshotDir) {
    screenshot = resolve(opts.screenshotDir, `autofill-${stamp()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {
      screenshot = null;
    });
  }

  return { url, outcomes, screenshot, context, page };
}

function truncate(s: string, n = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}...` : flat;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Human-readable summary of what happened. */
export function renderOutcomes(job: EnrichedJob, result: AutofillResult): string {
  const L: string[] = [];
  const filled = result.outcomes.filter((o) => o.status === "filled");
  const needs = result.outcomes.filter((o) => o.status === "needs-you");
  const skipped = result.outcomes.filter((o) => o.status === "skipped");

  L.push(`# Autofill report - ${job.title}, ${job.company}`);
  L.push("");
  L.push("```");
  L.push(`Form   : ${result.url}`);
  L.push(`Filled : ${filled.length}`);
  L.push(`For you: ${needs.length}`);
  L.push(`Status : NOT SUBMITTED - the submit button was never touched`);
  L.push("```");
  L.push("");

  if (needs.length) {
    L.push("## You need to handle these");
    L.push("");
    for (const o of needs) L.push(`- **${truncate(o.label, 90)}** - ${o.detail}`);
    L.push("");
  }

  L.push("## Filled");
  L.push("");
  for (const o of filled) L.push(`- ${truncate(o.label, 70)} = ${o.detail}`);
  L.push("");

  if (skipped.length) {
    L.push("## Left alone");
    L.push("");
    for (const o of skipped) L.push(`- ${truncate(o.label, 70)} - ${o.detail}`);
    L.push("");
  }

  if (result.screenshot) {
    L.push(`Screenshot of the filled form: ${result.screenshot}`);
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("Read every field before you submit. Nothing here was sent.");
  return L.join("\n");
}
