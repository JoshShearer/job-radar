import { createInterface } from "node:readline/promises";
import type { Prompter } from "../ports/io.js";

/**
 * Yes/no on a real terminal. Anything but an explicit "y"/"yes" is no, and so
 * is the absence of a terminal: a piped or scheduled run never records a
 * submission or saves an answer by default.
 */
export const terminalPrompter: Prompter = {
  async confirm(question: string): Promise<boolean> {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  },
};
