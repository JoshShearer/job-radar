import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import { basename, resolve } from "node:path";
import type { Evidence } from "../../domain/candidate/evidence.js";
import type { Personal } from "../../domain/candidate/personal.js";
import { closedPostingMarker } from "../../domain/catalog/closed.js";
import type { ApplicationBrowser, FieldOutcome as PortOutcome, FillInput, FillSession } from "../../ports/io.js";
import {
  chooseOption,
  classifyLabel,
  decide,
  isSubmitControl,
  isYesNoOptions,
  matchPreparedAnswer,
  stateListAnswer,
  type FieldIntent,
} from "../../domain/browser/fields.js";

/** Progress lines go to stderr so stdout stays the report. */
const log = {
  info: (m: string) => process.stderr.write(`${m}\n`),
  warn: (m: string) => process.stderr.write(`warning: ${m}\n`),
};

interface FieldSnapshot {
  label: string;
  intent: FieldIntent;
  kind: string;
  value: string;
}

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

/** The documents to attach, chosen by the caller from a specific generation. */
export interface Attachments {
  resume: string | null;
  coverLetter: string | null;
}

/**
 * Where the form actually is.
 *
 * A company that embeds its ATS on its own careers domain puts the entire
 * application inside a child frame - measured on Samsara, 42 controls in
 * `grnhse_iframe` and 2 on the host page. `page.locator` and
 * `page.evaluate(document.querySelectorAll ...)` both read the MAIN frame only,
 * so every stage of this file was blind to those 42: the settle wait, the
 * enumeration, the `data-jr-idx` tagging, the combobox scoping, the filling.
 * The run reported "Filled: 0", which is exactly what a form with nothing to
 * fill reports.
 *
 * `Page` and `Frame` share the locator and evaluate API, and `page.mainFrame()`
 * is a `Frame`, so taking a scope rather than a page costs nothing and leaves a
 * direct board on precisely its old code path.
 */
export type FormScope = Page | Frame;

/** `Page` has `mainFrame`; `Frame` does not. That is the whole discriminator. */
export function asFrame(scope: FormScope): Frame {
  return "mainFrame" in scope ? scope.mainFrame() : scope;
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

/**
 * Probe every frame, not just the main one.
 *
 * This was main-frame only, and on an embedded form that silently disabled a
 * refusal rather than degrading it. The reCAPTCHA an ATS embeds - badge AND
 * challenge popup - is a child of the embed frame, so `iframe[src*='recaptcha']
 * [src*='bframe']` could not match from the host page. An active challenge
 * would not have stopped the run.
 *
 * Frames are re-read on every call because a challenge appears by attaching
 * one; a list captured once would be the list from before it showed up.
 *
 * EVERY FRAME QUERY IS BOUNDED, because some frames never answer. Measured: a
 * locator call against a challenge iframe hangs indefinitely - not slowly,
 * indefinitely - while Playwright waits on an initial navigation that frame
 * never completes. Unbounded, one such frame stalls the whole run before a
 * single field is filled.
 *
 * Timing a frame out cannot weaken the refusal, and that is a property of WHERE
 * the markers live, not a hope: every BLOCKING_MARKER is an element in an
 * embedding document - `iframe[src*='recaptcha'][src*='bframe']` is the iframe
 * TAG, which sits in the page or the form frame, both of which answer. The
 * frame that stops answering is the challenge's own content, which is never
 * where the evidence is. A frame that times out is remembered for the rest of
 * the call so it costs one budget total rather than one per selector.
 */
const FRAME_PROBE_MS = 300;

/**
 * Run a frame query with a hard ceiling, returning `fallback` if it overruns.
 *
 * Not a nicety: a frame can hang a locator call forever (see above), and every
 * loop in this file that walks `page.frames()` would inherit that. `Promise.race`
 * rather than a Playwright timeout option because the hang is inside Playwright's
 * own wait for the frame to become usable, which its per-call timeouts do not
 * cut short.
 */
async function withBudget<T>(run: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ timedOut: true }>((res) => {
    timer = setTimeout(() => res({ timedOut: true }), ms);
  });
  try {
    const result = await Promise.race([run().then((value) => ({ value })), budget]);
    return "value" in result ? result.value : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function pageProbes(scope: FormScope) {
  const frames = () => {
    const frame = asFrame(scope);
    // Given a page, look everywhere. Given one frame, that frame is the whole
    // question being asked. Playwright lists the main frame first, so the
    // common case matches before any child frame is touched.
    return "mainFrame" in scope ? scope.frames() : [frame];
  };

  // Frames that blew the budget once. Re-asking them costs the same 300ms and
  // gets the same non-answer.
  const unresponsive = new WeakSet<object>();

  const bounded = async (f: Frame, run: () => Promise<boolean>): Promise<boolean> => {
    if (unresponsive.has(f)) return false;
    const answered = await withBudget(async () => ({ ok: await run() }), FRAME_PROBE_MS, null);
    if (answered === null) {
      unresponsive.add(f);
      return false;
    }
    return answered.ok;
  };

  const visible = async (sel: string) => {
    for (const f of frames()) {
      if (await bounded(f, () => f.locator(sel).first().isVisible({ timeout: 250 }))) return true;
    }
    return false;
  };
  const present = async (sel: string) => {
    for (const f of frames()) {
      if (await bounded(f, async () => (await f.locator(sel).count()) > 0)) return true;
    }
    return false;
  };
  return { visible, present };
}

/**
 * Tag every visible form control with a stable index and read back its label.
 * Done in one pass in the page so we are not making a round trip per element,
 * and so label resolution can use the DOM relationships the browser already
 * has (aria-labelledby, label[for], ancestor <label>).
 *
 * Runs in the frame that holds the form. `document` inside `evaluate` is that
 * frame's document, so the `data-jr-idx` attributes it writes and the locators
 * that later read them are guaranteed to be talking about the same DOM.
 */
async function enumerateControls(scope: FormScope): Promise<ControlInfo[]> {
  return asFrame(scope).evaluate((SELECTOR) => {
    const out: Array<{
      idx: number;
      kind: string;
      label: string;
      truncated: boolean;
      name: string;
      required: boolean;
    }> = [];

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));

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
  }, CONTROL_SELECTOR) as Promise<ControlInfo[]>;
}

/** Everything `enumerateControls` will look at. Kept in one place so the wait
 * and the enumeration cannot drift apart. */
const CONTROL_SELECTOR = "input, textarea, select, [role='combobox']";

/**
 * Wait for a client-rendered form to finish painting, and report how many
 * controls it settled on.
 *
 * A flat post-navigation delay is a guess, and it was wrong: Ashby renders its
 * application form several seconds after `domcontentloaded`, so a 1.2s wait
 * enumerated an empty document and produced "Filled: 0 / For you: 0" - which
 * reads exactly like a form that had nothing to fill. Silent and plausible is
 * the worst failure this tool has.
 *
 * Settling matters as much as appearing. Controls often arrive in bursts, so
 * returning on the first one enumerates half a form and skips the rest without
 * saying so. This waits for the count to hold steady for `settleMs` before
 * trusting it.
 *
 * `settleMs` is deliberately as long as the fixed delay it replaces: bursts
 * separated by more than that still return early, and no finite wait can rule
 * that out, so the window is generous rather than clever. The cost is the same
 * ~1.2s that was already spent unconditionally after every navigation - now
 * spent measuring the form instead of guessing at it.
 *
 * A page that never renders a control returns 0 at the cap rather than
 * throwing: that is a real answer for a posting whose form lives behind a link,
 * and the caller reports it.
 */
export const CONTROL_SETTLE_MS = 1200;
export const CONTROL_WAIT_MS = 15000;

export async function waitForControls(
  scope: FormScope,
  opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<number> {
  const found = await findFormFrame(scope, opts);
  return found.count;
}

/**
 * Scroll the whole document, so anything mounted on scroll gets mounted.
 *
 * Samsara's careers page does not create its application iframe until a
 * sentinel enters the viewport. Before scrolling there is no form in the DOM at
 * all - not an empty form, no form - so no amount of waiting finds one. The
 * only report that came out of that run named the footer's language picker.
 *
 * Stepped rather than a single jump to the bottom, because an
 * IntersectionObserver on a sentinel the viewport skips over never fires.
 *
 * IT STOPS AT THE BOTTOM AND STAYS THERE. Returning to the top immediately lost
 * the mount entirely on one live run in eight - the iframe element was never
 * created (`iframeInDom=false`, 3 frames instead of 8). Observer callbacks are
 * asynchronous, and lazy-mount handlers commonly re-check the element's
 * position when the callback runs; scrolling away first makes that check fail.
 * The pause at the bottom gives those callbacks a turn before anything else
 * happens. `autofillApplication` scrolls the form into view afterwards, which
 * is where the human wants to be anyway.
 *
 * Scrolling is ordinary use of an ordinary browser: it is what a person reading
 * the posting does, and it is how the page is designed to be read. Nothing here
 * is hidden from the site or presented as something it is not.
 *
 * THE LOOP RUNS IN NODE, AND EVERY `evaluate` BODY IS A BARE EXPRESSION. That
 * is not style. Under tsx, esbuild's `keepNames` rewrites a named function -
 * including `const sleep = (ms) => ...` - to call a `__name()` helper that does
 * not exist in a browser, so the whole evaluate dies with
 * `ReferenceError: __name is not defined`. The first version of this function
 * did the loop page-side, threw on every real run, and had its error swallowed
 * by a `.catch`, which is precisely how it reached a live posting reporting
 * "Filled: 0". Vitest transpiles differently, so no test could have caught it.
 * Keep page-side code to expressions with no named functions.
 */
export async function revealLazyContent(
  page: Page,
  opts: { stepPx?: number; pauseMs?: number; settleAtBottomMs?: number } = {},
): Promise<void> {
  const stepPx = opts.stepPx ?? 600;
  const pauseMs = opts.pauseMs ?? 100;
  try {
    for (let step = 0; step < 200; step++) {
      const y = step * stepPx;
      // Re-read the height each pass: revealing content makes the page taller,
      // and a bound captured up front stops short of the new bottom.
      const bottom = await page.evaluate(
        () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      );
      if (!bottom || y >= bottom) break;
      await page.evaluate((top: number) => window.scrollTo(0, top), y);
      await page.waitForTimeout(pauseMs);
    }
    // Let observer callbacks fired by the last step actually run.
    await page.waitForTimeout(opts.settleAtBottomMs ?? 600);
  } catch (err) {
    // A page that refuses to be scripted is not a reason to abandon the run -
    // the form may well be in the initial HTML - but it is never something to
    // hide. Silence here is what shipped the bug this function exists to fix.
    log.warn(`Could not scroll the page to reveal lazily-loaded content: ${(err as Error).message}`);
  }
}

export interface FormFrame {
  scope: FormScope;
  count: number;
  /** Every frame that had at least one control, richest first. For the report. */
  counts: Array<{ name: string; url: string; count: number }>;
}

/**
 * Find the frame the form is in, and wait for it to settle.
 *
 * Richest frame wins. A form frame dominates by an order of magnitude - 42
 * against 2 on the measured page - and the alternative rules are worse:
 * filling every frame would type into cookie banners and newsletter widgets,
 * and taking the first non-empty frame would have settled on the host page's
 * "Select region" picker and reported a filled form having filled a language
 * menu. That specific wrong answer is what the fixture's decoy pins.
 *
 * The settle logic is unchanged and now applies to the TOTAL across frames, so
 * an embed that mounts late is still waited for: the count rises from 1 to 33
 * when the iframe paints, which resets the window exactly as a late burst
 * within one document does.
 *
 * Given a bare frame, this is just the old single-scope wait.
 */
export async function findFormFrame(
  scope: FormScope,
  opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<FormFrame> {
  const timeoutMs = opts.timeoutMs ?? CONTROL_WAIT_MS;
  const settleMs = opts.settleMs ?? CONTROL_SETTLE_MS;
  const deadline = Date.now() + timeoutMs;
  const isPage = "mainFrame" in scope;
  const page = isPage ? scope : scope.page();

  const survey = async (): Promise<FormFrame> => {
    // Re-read the frame list every pass. A lazily embedded form arrives as a
    // NEW frame, so a list captured once can never contain it.
    const frames = isPage ? scope.frames() : [scope];
    const counts: FormFrame["counts"] = [];
    let best: FormScope = scope;
    let bestCount = 0;

    for (const f of frames) {
      // Bounded: a frame that never finishes navigating hangs this call
      // forever, and one such frame on the page would mean no form is ever
      // found. A frame that cannot answer contributes nothing.
      const n = await withBudget(() => f.locator(CONTROL_SELECTOR).count(), FRAME_PROBE_MS, 0);
      if (n === 0) continue;
      counts.push({ name: f.name(), url: f.url(), count: n });
      if (n > bestCount) {
        bestCount = n;
        best = f;
      }
    }
    counts.sort((a, b) => b.count - a.count);
    return { scope: best, count: bestCount, counts };
  };

  /**
   * Is every frame done loading?
   *
   * A frame that is still parsing has a steady control count of zero, and the
   * host page around it has a steady count of its own, so the settle window
   * expires on a page whose form has not arrived. Measured live one run in
   * five, where the trace at the moment of the wrong answer read:
   *
   *     frames=4  main:2/complete  grnhse_iframe:40/loading
   *
   * The embed was attached, readable, and openly saying it was not done. That
   * is the signal, and it was being ignored.
   *
   * AN UNREADABLE FRAME COUNTS AS SETTLED. A frame that will not answer must
   * not be able to stall the run - that is the same rule `withBudget` exists
   * for, and it is why a blocking script in a frame is a different case from
   * this one and does not hold the wait open.
   */
  const allFramesLoaded = async (): Promise<boolean> => {
    if (!isPage) return true;
    for (const f of scope.frames()) {
      const state = await withBudget(
        () => f.evaluate(() => document.readyState),
        FRAME_PROBE_MS,
        "complete",
      );
      if (state === "loading") return false;
    }
    return true;
  };

  let last = -1;
  let stableSince = 0;
  let latest: FormFrame = { scope, count: 0, counts: [] };

  while (Date.now() < deadline) {
    let total = -1;
    try {
      latest = await survey();
      total = latest.counts.reduce((sum, c) => sum + c.count, 0);
    } catch {
      total = -1;
    }

    // A steady count is necessary and NOT sufficient: a frame still parsing has
    // a steady count of zero, and the host page around it has a steady count of
    // its own. That combination is what returned a language picker as the
    // application form, one live run in five.
    if (total > 0 && total === last && (await allFramesLoaded())) {
      if (Date.now() - stableSince >= settleMs) return latest;
    } else {
      last = total;
      stableSince = Date.now();
    }
    await page.waitForTimeout(150);
  }

  return latest;
}

/**
 * Read back what is currently in the form.
 *
 * Called repeatedly while the human has the browser open, so that what they
 * type by hand can be offered back to `personal.yaml` and reused next time.
 * Read-only: it inspects values and touches nothing.
 *
 * Polling rather than reading once at the end is deliberate. If they submit the
 * form, the page navigates and the answers are gone; the last good read taken
 * before that is exactly the snapshot worth keeping.
 *
 * Given a page this reads EVERY frame, because the `data-jr-idx` marks it looks
 * for were written wherever the form turned out to be. Reading only the main
 * frame would have quietly stopped answer-learning on embedded forms - the
 * feature would still run, still succeed, and never capture anything.
 */
export async function snapshotFields(scope: FormScope): Promise<FieldSnapshot[]> {
  const frames = "mainFrame" in scope ? scope.frames() : [scope];
  const raw: Array<{ label: string; kind: string; value: string }> = [];
  for (const f of frames) {
    // Bounded for the same reason as everywhere else a frame list is walked:
    // this is called on a poll while the human types, so a frame that hangs
    // would stall every subsequent read, not just this one.
    raw.push(...(await withBudget(() => readTaggedFields(f), FRAME_PROBE_MS, [])));
  }
  return raw.map((r) => ({ ...r, intent: classifyLabel(r.label) }));
}

function readTaggedFields(frame: Frame): Promise<Array<{ label: string; kind: string; value: string }>> {
  return frame.evaluate(() => {
    const out: Array<{ label: string; kind: string; value: string }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-jr-idx]"))) {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const kind =
        el.getAttribute("role") === "combobox"
          ? "combobox"
          : tag === "textarea"
            ? "textarea"
            : tag === "select"
              ? "select"
              : type === "file"
                ? "file"
                : type === "radio" || type === "checkbox"
                  ? type
                  : "text";

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
        label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() || "";
      }
      if (!label) label = el.closest("label")?.textContent?.trim() || "";
      if (!label) label = el.getAttribute("placeholder") || el.getAttribute("name") || "";

      out.push({ label: label.replace(/\s+/g, " ").slice(0, 400), kind, value: input.value || "" });
    }
    return out;
  });
}

/**
 * Get a freshly navigated page ready to be read, and report how many controls
 * it settled on.
 *
 * A page showing an active challenge will never paint an application form, so
 * waiting the full control timeout on one just delays the refusal by fifteen
 * seconds. `fillForm` re-checks and is what actually stops the run; this only
 * avoids pausing before it does.
 */
export async function settlePage(page: Page): Promise<FormFrame> {
  const { visible, present } = pageProbes(page);
  const challenge = await detectChallenge(visible, present);
  if (challenge?.kind === "blocking") return { scope: page, count: 0, counts: [] };

  // Before waiting, make sure there is something to wait FOR. A form mounted on
  // scroll does not exist until the page is scrolled, so polling a document
  // that will never change on its own just burns the full 15s cap and then
  // reports an empty form.
  await revealLazyContent(page);
  return findFormFrame(page);
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
 *
 * The menu is looked up in the SAME scope as the control. An embedded form
 * renders its listbox inside the embed frame, so resolving `aria-controls`
 * against the host page finds nothing at all.
 */
async function openMenu(scope: FormScope, control: Locator): Promise<Locator | null> {
  const frame = asFrame(scope);
  await control.click({ timeout: 5000 });
  for (let i = 0; i < 20; i++) {
    const id = await control.getAttribute("aria-controls").catch(() => null);
    if (id) return frame.locator(`[id="${id}"]`);
    await frame.page().waitForTimeout(100);
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

async function closeMenu(scope: FormScope): Promise<void> {
  // Keyboard input is page-level and goes to whatever is focused, which is the
  // control we just clicked, in whichever frame it lives.
  const page = asFrame(scope).page();
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
  scope: FormScope,
  control: Locator,
  desired: string,
  onOptions?: (options: string[]) => string | null,
): Promise<SelectResult> {
  const page = asFrame(scope).page();
  const menu = await openMenu(scope, control);
  if (!menu) {
    await closeMenu(scope);
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
    await closeMenu(scope);
    return { chosen: null, options: seen.length ? seen : options };
  }

  const target = menu.locator("[role='option'], .select__option").filter({ hasText: match.option }).first();
  try {
    await target.click({ timeout: 3000 });
  } catch {
    await closeMenu(scope);
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
  /**
   * The page, or the frame the form was found in. Given a page this reads its
   * main frame, which is what a direct ATS board needs; given the frame that
   * `findFormFrame` chose, it reads the embedded form.
   */
  scope: FormScope,
  personal: Personal,
  /** Verified answers from an APPROVED pack generation. Empty means none. */
  answers: ReadonlyArray<{ question: string; answer: string }>,
  attachments: Attachments,
  /** Evidence ledger, for the fields answered from employment history. */
  evidence?: Evidence,
): Promise<FieldOutcome[]> {
  const resume = attachments.resume;
  const coverLetter = attachments.coverLetter ?? undefined;
  const frame = asFrame(scope);
  // Challenge detection asks about the whole page even when filling one frame:
  // a challenge that appears anywhere stops the run, and on an embedded form
  // the reCAPTCHA is a sibling of the form rather than inside it.
  const { visible, present } = pageProbes("mainFrame" in scope ? scope : frame.page());
  const challenge = await detectChallenge(visible, present);
  if (challenge?.kind === "blocking") {
    throw new Error(
      `This page is showing an active bot challenge (${challenge.marker}). Stopping - I will not work around it.\n` +
        `Run without --headless, solve it yourself, then re-run this command.`,
    );
  }

  const controls = await enumerateControls(frame);
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
  // Every option label of each named radio group, so each radio is judged
  // against its siblings rather than alone.
  const radioGroups = new Map<string, string[]>();
  for (const c of controls) {
    if (c.kind !== "radio" || !c.name) continue;
    radioGroups.set(c.name, [...(radioGroups.get(c.name) ?? []), c.label]);
  }
  for (const c of controls) {
    // File inputs are usually labelled by their styled button ("Attach"), which
    // says nothing. Their id does: `resume`, `cover_letter`.
    let intent = classifyLabel(c.label);
    if (intent === "unknown" && c.name) intent = classifyLabel(c.name);

    const el = frame.locator(`[data-jr-idx="${c.idx}"]`);
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

    const decision = decide(c.label, intent, { personal, ...(evidence ? { evidence } : {}) });

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
              detail: "no tailored resume for this posting. Run `jr tailor <id>`, or attach one yourself",
            });
            continue;
          }
          await el.setInputFiles(resume);
          outcomes.push({ label, intent, status: "filled", detail: `attached ${basename(resume)} (tailored to this posting)` });
        } else if (coverLetter) {
          // The prepared note is a real document now, so a form asking for one
          // can be given it rather than told to wait for a human with a
          // clipboard.
          await el.setInputFiles(coverLetter);
          outcomes.push({
            label,
            intent,
            status: "filled",
            detail: `attached ${coverLetter.split("/").pop()} - READ IT before you submit`,
          });
        } else {
          outcomes.push({
            label,
            intent,
            status: "needs-you",
            detail: "no approved cover letter for this posting",
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
              : await selectFromCombobox(frame, el, decision.value);
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
          const r = await selectFromCombobox(frame, el, decision.desired, resolve);
          chosen = r.chosen;
          seenOptions = r.options;
        } else if (c.kind === "radio") {
          // Scored against its whole group, so the tie refusal applies: two
          // options that both fully cover the desired answer ("...for any
          // employer" / "...for my current employer only") leave the group
          // unanswered instead of checking whichever comes last.
          const group = radioGroups.get(c.name) ?? [c.label];
          const m = chooseOption(decision.desired, group);
          seenOptions = group;
          if (m && m.option === c.label && !isSubmitControl(c.label)) {
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
  //
  // Single-line inputs count. Ashby renders "describe a product you built from
  // the ground up" as an <input type="text">, so restricting this to <textarea>
  // meant every drafted answer in the pack was unreachable on those forms -
  // loaded, and never used. The guards below do the work of keeping this safe,
  // not the element type: an EEO or attestation field is refused whatever tag
  // it happens to be, and nothing a rule already filled is touched.
  if (answers.length) {
    for (const c of controls) {
      if (c.kind !== "textarea" && c.kind !== "text") continue;
      const already = outcomes.find((o) => o.label === (c.label || `(unlabelled ${c.kind})`));
      if (already && already.status === "filled") continue;
      // Only a question no rule owns. A field a rule owns but left unfilled
      // (sponsorship or salary unset in personal.yaml) is UNKNOWN, and a
      // drafted answer is not the candidate's statement: typing one there is
      // the default the unknown rule forbids. Demographics and attestations
      // are owned by their refusals.
      const intent = classifyLabel(c.label);
      if (intent !== "unknown") continue;
      if (already && already.status === "needs-you") continue;

      const m = matchPreparedAnswer(c.label, answers);
      if (!m) continue;
      try {
        await frame.locator(`[data-jr-idx="${c.idx}"]`).fill(m.answer);
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
  input: FillInput,
  profileDir: string,
): Promise<AutofillResult> {
  const url = input.url;
  if (!url) throw new Error("This posting has no application URL.");
  const opts = { headless: input.headless, screenshotDir: input.screenshotDir };

  const context = await chromium.launchPersistentContext(profileDir, {
    // Headed by default: watching it type IS the review step. Headless exists
    // to verify field classification against a live form without opening a
    // window, and is useless for actually applying - the filled form dies with
    // the process.
    headless: opts.headless === true,
    // `null` means "track the real window", and that matters only in headed
    // mode - which is the mode a HUMAN then types into.
    //
    // A fixed viewport installs a device-metrics override, so the page is
    // rendered at exactly 1280x1000 and scaled into whatever the window's
    // content area actually is. Measured here: 1280x1000 emulated inside
    // ~1288x1021 real, so every real click is scaled by ~1.02 vertically. Near
    // the top of a page that is a pixel or two; on an application form several
    // thousand pixels down, it is tens of pixels - enough to land beside the
    // field being aimed at.
    //
    // Headless keeps the fixed size, because a dry run should measure the same
    // form every time and nobody is clicking in it.
    viewport: opts.headless === true ? { width: 1280, height: 1000 } : null,
    args: ["--window-size=1300,1050"],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  log.info(`Opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // Boards that render the form client-side paint their controls seconds after
  // this point, so the page is polled until the control count settles rather
  // than guessed at with a fixed delay. `fillForm` re-reads the DOM itself, and
  // detectChallenge runs inside it before anything is typed, so waiting here
  // does not let a challenge page slip past - it only stops us reading a form
  // that has not been drawn yet.
  const form = await settlePage(page);

  // A closed posting is not an empty form. Greenhouse redirects a dead job to
  // the board root, which renders a real listings page and enumerates like one
  // - so without this the run reports a form it never found and hands over a
  // browser window showing a job list. Direct evidence from the page, so it
  // does not depend on the freshness inference being right.
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
  const closed = closedPostingMarker(page.url(), bodyText);
  if (closed) {
    throw new Error(
      `This posting is no longer open - ${closed}.\n` +
        `Landed on: ${page.url()}\n` +
        `Nothing was filled. Re-check the board with \`jr sweep\`.`,
    );
  }

  if (form.count === 0) {
    log.warn("No form controls appeared on this page. It may render the form behind a link or button.");
  } else if (form.counts.length > 1) {
    // Say which frame was picked and what the alternatives were. Choosing the
    // richest frame is a heuristic, and a heuristic that picks wrong in silence
    // is how "Filled: 1" ends up meaning "filled a language picker".
    const [chosen, ...rest] = form.counts;
    if (chosen) {
      log.info(`Form found in ${describeFrame(chosen)}; also saw ${rest.map(describeFrame).join(", ")}`);
    }
  }

  // Land the human on the form. `revealLazyContent` deliberately stops at the
  // bottom of the page, and on a careers page that is the footer - several
  // thousand pixels past the fields they are here to check.
  if (form.count > 0) {
    await asFrame(form.scope)
      .locator(CONTROL_SELECTOR)
      .first()
      .scrollIntoViewIfNeeded({ timeout: 3000 })
      .catch(() => {
        // Cosmetic. Never a reason to fail a run that filled a form.
      });
  }

  // A resume tailored to THIS posting wins over anything generic in resumes/.
  // The caller normally decides and hands over the whole choice; the fallback
  // is for programmatic callers, never a re-derivation of one that was passed.
  let outcomes: FieldOutcome[];
  try {
    outcomes = await fillForm(
      form.scope,
      input.personal,
      input.answers,
      { resume: input.resumePath, coverLetter: input.coverLetterPath },
      input.evidence ?? undefined,
    );
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }

  let screenshot: string | null = null;
  if (opts.screenshotDir) {
    screenshot = resolve(opts.screenshotDir, `autofill-${stamp()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {
      screenshot = null;
    });
  }

  return { url, outcomes, screenshot, context, page };
}

/** "grnhse_iframe (32 controls)", or the file name when a frame has no name. */
function describeFrame(c: { name: string; url: string; count: number }): string {
  const who = c.name || c.url.split("/").pop()?.split("?")[0] || "the page";
  return `${who} (${c.count} control${c.count === 1 ? "" : "s"})`;
}

function truncate(s: string, n = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}...` : flat;
}

function stamp(): string {
  // A file name only; nothing is decided from this value.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}


/**
 * The port implementation: open, fill, hand the window to the human, and
 * report. Never submits; the session only reads the form back while the human
 * works, so answers they type by hand can be offered for personal.yaml.
 */
export class PlaywrightApplicationBrowser implements ApplicationBrowser {
  constructor(private readonly profileDir: string) {}

  async fill(input: FillInput): Promise<FillSession> {
    const result = await autofillApplication(input, this.profileDir);
    const outcomes: PortOutcome[] = result.outcomes.map((o) => ({
      label: o.label,
      intent: o.intent,
      status: o.status === "filled" ? "filled" : o.status === "needs-you" ? "needs_you" : "left_alone",
      why: o.detail,
    }));
    return {
      outcomes,
      stoppedFor: null,
      notes: [],
      screenshot: result.screenshot,
      close: () => result.context.close(),
      waitForClose: async () => {
        let snapshot: FieldSnapshot[] = [];
        const timer = setInterval(() => {
          void snapshotFields(result.page)
            .then((s) => {
              if (s.length) snapshot = s;
            })
            .catch(() => {
              /* navigating or gone: keep the last good read */
            });
        }, 2000);
        const interrupted = await new Promise<boolean>((done) => {
          const onSigint = () => done(true);
          result.context.on("close", () => {
            process.removeListener("SIGINT", onSigint);
            done(false);
          });
          process.once("SIGINT", onSigint);
        });
        clearInterval(timer);
        return { interrupted, snapshot };
      },
    };
  }
}
