import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { htmlToText } from "../lib/html.js";
import { log } from "../lib/log.js";

/**
 * Where application mail comes from.
 *
 * An interface with two implementations, because the two jobs are genuinely
 * different: reading Gmail needs credentials and a network, and testing the
 * pipeline needs neither. Everything downstream - classify, match, the status
 * transitions - works on `Email` and cannot tell which produced it.
 */
export interface Email {
  /** Stable id from the source. Stored on the status change for traceability. */
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface MailSource {
  readonly name: string;
  /** Most recent first. `since` is an ISO date the source may use to narrow. */
  fetch(opts: { since: string | null; limit: number }): Promise<Email[]>;
}

/* -------------------------------------------------------------------------
 * Gmail, read-only
 * ---------------------------------------------------------------------- */

/**
 * Gmail over its documented REST API, with no SDK.
 *
 * Hand-rolled for the same reason the job-board adapters are: it is one token
 * refresh and two GETs, against a public documented endpoint, and the
 * alternative is a large dependency tree for the sake of three calls.
 *
 * READ-ONLY, and structurally so. The scope requested is
 * `gmail.readonly`, and there is no code path here that sends, replies,
 * labels, archives or deletes anything - the only verbs used are GET. This
 * feature reads mail; the tool never sends anything on the user's behalf.
 *
 * Credentials come from the environment, never from a config file, because
 * config files in this repo are read by commands that print their contents.
 */
export class GmailSource implements MailSource {
  readonly name = "gmail";

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly query: string,
  ) {}

  static fromEnv(query: string): GmailSource | null {
    const clientId = process.env.JOB_RADAR_GMAIL_CLIENT_ID;
    const clientSecret = process.env.JOB_RADAR_GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.JOB_RADAR_GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return new GmailSource({ clientId, clientSecret, refreshToken }, query);
  }

  private async accessToken(): Promise<string> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Gmail token refresh returned no access_token.");
    return json.access_token;
  }

  async fetch(opts: { since: string | null; limit: number }): Promise<Email[]> {
    const token = await this.accessToken();
    const auth = { authorization: `Bearer ${token}` };

    const q = [this.query, opts.since ? `after:${opts.since.slice(0, 10).replace(/-/g, "/")}` : ""]
      .filter(Boolean)
      .join(" ");

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", q);
    listUrl.searchParams.set("maxResults", String(Math.min(opts.limit, 100)));

    const listRes = await fetch(listUrl, { headers: auth });
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status} ${await listRes.text()}`);
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> };

    const out: Email[] = [];
    for (const m of list.messages ?? []) {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: auth,
      });
      if (!res.ok) {
        // One unreadable message must not abort the scan, the same rule the
        // ingest path holds to for a failing job board.
        log.warn(`gmail: could not read message ${m.id}: ${res.status}`);
        continue;
      }
      out.push(parseGmailMessage((await res.json()) as GmailMessage));
    }
    return out;
  }
}

/** The shape Gmail returns, pinned here so a field rename surfaces as a test failure. */
export interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}
interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPart[];
}

/**
 * Flatten a Gmail message into the shape the rest of the pipeline uses.
 *
 * Exported so it can be tested against a real captured payload without a
 * network or credentials - the same rule `tests/sources.test.ts` applies to
 * every job-board adapter.
 */
export function parseGmailMessage(msg: GmailMessage): Email {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string): string =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const plain = findPart(msg.payload, "text/plain");
  const html = findPart(msg.payload, "text/html");
  const body = plain ? decodeB64Url(plain) : html ? htmlToText(decodeB64Url(html)) : "";

  const received = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : (() => {
        const d = Date.parse(header("Date"));
        return Number.isNaN(d) ? new Date(0).toISOString() : new Date(d).toISOString();
      })();

  return { id: msg.id, from: header("From"), subject: header("Subject"), body, receivedAt: received };
}

function findPart(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/* -------------------------------------------------------------------------
 * Local .eml files
 * ---------------------------------------------------------------------- */

/**
 * A directory of `.eml` files.
 *
 * Exists so the whole pipeline can be exercised without credentials - by a
 * test, and by a person who wants to check what the classifier would do to
 * their mail before pointing it at their real mailbox. A deliberately naive
 * RFC-822 reader: headers to the first blank line, everything after is body.
 */
export class EmlDirectorySource implements MailSource {
  readonly name = "eml";
  constructor(private readonly dir: string) {}

  async fetch(opts: { since: string | null; limit: number }): Promise<Email[]> {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => f.toLowerCase().endsWith(".eml"))
      .sort()
      .slice(0, opts.limit);
    return files.map((f) => parseEml(f, readFileSync(resolve(this.dir, f), "utf8")));
  }
}

export function parseEml(id: string, raw: string): Email {
  const split = raw.indexOf("\n\n");
  const headerBlock = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 2);

  // Unfold continuation lines before reading headers, or a wrapped Subject
  // loses everything after the first line.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const header = (name: string): string => {
    const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
    return m ? m[1]!.trim() : "";
  };

  const d = Date.parse(header("Date"));
  return {
    id: header("Message-ID") || id,
    from: header("From"),
    subject: header("Subject"),
    body,
    receivedAt: Number.isNaN(d) ? new Date(0).toISOString() : new Date(d).toISOString(),
  };
}
