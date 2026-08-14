import { advanceStatus, type Status } from "../model/status.js";

/**
 * What `autofill` may record after the browser has been closed.
 *
 * This is the whole decision, extracted from the CLI on purpose. The refusal it
 * encodes is load-bearing - `autofill` fills a form and stops, and the only
 * thing it is allowed to record afterwards is an answer a human gave out loud -
 * so the decision lives somewhere a test can reach it rather than inside a
 * command body that nothing exercises.
 *
 * `confirmed` is the human's explicit yes. Anything that is not an explicit yes
 * arrives here as `false`: a no, an empty line, a closed stdin, a timeout, a
 * non-interactive run. All of them mean the same thing, and it is not "yes".
 *
 * Returns the status to write, or null to write nothing at all.
 */
export function statusAfterAutofill(current: Status, confirmed: boolean): Status | null {
  // Ordered before the transition check so no combination of statuses can ever
  // produce a write on the No branch.
  if (!confirmed) return null;
  return advanceStatus(current, "APPLIED");
}
