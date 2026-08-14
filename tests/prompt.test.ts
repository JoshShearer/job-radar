import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { confirmYesNo } from "../src/lib/prompt.js";

/**
 * The prompt sits directly next to a load-bearing refusal: `autofill` fills a
 * form and never submits one, and the only thing it records afterwards is an
 * explicit human yes. Everything else - a no, a blank line, a closed stream, a
 * timeout, a pipe - has to mean No, so each of those is a case here.
 */
function tty(): PassThrough & { isTTY?: boolean } {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

function sink(): PassThrough & { text: () => string } {
  const chunks: string[] = [];
  const s = new PassThrough() as PassThrough & { text: () => string };
  s.on("data", (c: Buffer) => chunks.push(c.toString()));
  s.text = () => chunks.join("");
  return s;
}

async function ask(typed: string | null, timeoutMs = 5000): Promise<{ answer: boolean; asked: string }> {
  const input = tty();
  const output = sink();
  const pending = confirmYesNo("Record it?", { input, output, timeoutMs });
  if (typed === null) input.end();
  else input.write(`${typed}\n`);
  const answer = await pending;
  return { answer, asked: output.text() };
}

describe("confirmYesNo", () => {
  it("accepts an explicit yes", async () => {
    for (const typed of ["y", "Y", "yes", "YES", "  yes  "]) {
      expect((await ask(typed)).answer, typed).toBe(true);
    }
  });

  it("treats everything that is not an explicit yes as No", async () => {
    for (const typed of ["n", "N", "no", "", "   ", "yeah", "yep", "maybe", "ye", "sure", "1", "true"]) {
      expect((await ask(typed)).answer, `"${typed}"`).toBe(false);
    }
  });

  it("treats a closed stream with no answer as No", async () => {
    expect((await ask(null)).answer).toBe(false);
  });

  it("treats an unanswered prompt as No once the window elapses", async () => {
    const input = tty();
    const output = sink();
    // Never written to: this is the walked-away-from-the-terminal case.
    const answer = await confirmYesNo("Record it?", { input, output, timeoutMs: 20 });
    expect(answer).toBe(false);
    expect(output.text()).toContain("recording nothing");
  });

  it("does not ask at all when nothing is attached to answer", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const output = sink();
    const answer = await confirmYesNo("Record it?", { input, output, timeoutMs: 20 });
    expect(answer).toBe(false);
    // A question printed into a log no one can reply to is worse than silence,
    // and a scripted run must not block on it.
    expect(output.text()).toBe("");
  });

  it("shows the default in the prompt itself", async () => {
    expect((await ask("n")).asked).toContain("[y/N]");
  });
});
