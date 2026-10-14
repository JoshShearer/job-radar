import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Email, Mailbox } from "../../ports/io.js";

/**
 * A directory of .eml files, for exercising the whole mail path without
 * credentials. Honors the same window and pagination contract as Gmail.
 */
export class EmlMailbox implements Mailbox {
  readonly name = "eml";
  readonly query = "eml-directory";
  constructor(private readonly dir: string) {}

  async page(args: { after: string; before: string; pageToken: string | null; pageSize: number }) {
    if (!existsSync(this.dir)) return { messages: [], nextPageToken: null };
    const all = readdirSync(this.dir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort()
      .map((f) => parseEml(f, readFileSync(resolve(this.dir, f), "utf8")))
      .filter((m) => m.receivedAt >= args.after && m.receivedAt < args.before);
    const start = args.pageToken ? Number(args.pageToken) : 0;
    const messages = all.slice(start, start + args.pageSize);
    const next = start + args.pageSize < all.length ? String(start + args.pageSize) : null;
    return { messages, nextPageToken: next };
  }
}

export function parseEml(id: string, raw: string): Email {
  const norm = raw.replace(/\r\n/g, "\n");
  const split = norm.indexOf("\n\n");
  const headerBlock = split === -1 ? norm : norm.slice(0, split);
  const body = split === -1 ? "" : norm.slice(split + 2);
  const unfolded = headerBlock.replace(/\n[ \t]+/g, " ");
  const header = (name: string) => unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
  const d = Date.parse(header("Date"));
  return {
    id: header("Message-ID") || id,
    from: header("From"),
    subject: header("Subject"),
    body,
    receivedAt: Number.isNaN(d) ? new Date(0).toISOString() : new Date(d).toISOString(),
  };
}
