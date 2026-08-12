/**
 * Structured-ish console logging. Deliberately tiny: the pipeline's job is to
 * be auditable from a terminal, not to ship logs anywhere.
 */

type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let verbose = false;
export function setVerbose(v: boolean): void {
  verbose = v;
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (level === "debug" && !verbose) return;
  const color = process.stdout.isTTY ? COLORS[level] : "";
  const reset = process.stdout.isTTY ? RESET : "";
  const tag = `${color}${level.padEnd(5)}${reset}`;
  const line = `${tag} ${msg}`;
  if (extra === undefined) console.error(line);
  else console.error(line, extra);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};

/** Counters for an ingestion run, printed as a summary at the end. */
export class RunStats {
  private counts = new Map<string, number>();
  private failures: { source: string; detail: string }[] = [];

  bump(key: string, by = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  fail(source: string, detail: string): void {
    this.failures.push({ source, detail });
  }

  get failureCount(): number {
    return this.failures.length;
  }

  summary(): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.counts.entries()].sort()) {
      lines.push(`  ${k.padEnd(28)} ${v}`);
    }
    if (this.failures.length) {
      lines.push(`  ${"source failures".padEnd(28)} ${this.failures.length}`);
      for (const f of this.failures) lines.push(`    ! ${f.source}: ${f.detail}`);
    }
    return lines.join("\n");
  }
}
