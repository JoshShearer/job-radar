import { createInterface } from "node:readline";

/**
 * A yes/no question with the answer biased all the way to No.
 *
 * Extracted from the commands that ask so the defaulting can be tested: the
 * caller that uses this drives a browser, and a rule that only exists inside a
 * browser-driving command body is a rule nothing checks.
 *
 * The bias is the point. Every path that is not a human typing "y" - a "n", an
 * empty line, a word that merely starts with y, EOF, a stream error, a timeout,
 * a pipe with no terminal on the other end - resolves false. An unanswered
 * question is not a yes, in the same way an unset value in personal.yaml is
 * unknown rather than a default.
 */
export interface ConfirmOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; pause?: () => unknown };
  output?: NodeJS.WritableStream;
  /** No answer within this window is a No. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function confirmYesNo(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Nothing is attached to answer. Asking would print a question into a log
  // that no one can reply to, and waiting on it would hang a scripted run.
  if (input.isTTY !== true) return false;

  const rl = createInterface({ input, output });

  return new Promise<boolean>((settle) => {
    let done = false;
    const finish = (answer: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      // readline resumes stdin to read the line, and a resumed stdin keeps the
      // event loop alive. Without this the command answers correctly and then
      // sits there instead of exiting.
      input.pause?.();
      settle(answer);
    };

    const timer = setTimeout(() => {
      output.write("\nNo answer - recording nothing.\n");
      finish(false);
    }, timeoutMs);
    // A pending question must not be the reason the process stays alive.
    timer.unref?.();

    rl.on("close", () => finish(false));
    rl.on("error", () => finish(false));

    rl.question(`${question} [y/N] `, (raw) => {
      const answer = raw.trim().toLowerCase();
      finish(answer === "y" || answer === "yes");
    });
  });
}
