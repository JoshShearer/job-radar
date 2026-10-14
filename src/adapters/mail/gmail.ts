import type { Email, Mailbox } from "../../ports/io.js";
import { htmlToText } from "../../domain/text/html.js";

/**
 * Gmail over its documented REST API, READ-ONLY by construction: scope
 * gmail.readonly, and the only verbs here are GET (plus the OAuth token
 * refresh). There is no code path that sends, labels, archives or deletes.
 *
 * Paginates fully: a window is only reported complete when every page in it
 * has been read, so the scan cursor never skips a backlog.
 */
export class GmailMailbox implements Mailbox {
  readonly name = "gmail";
  private token: { value: string; expires: number } | null = null;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    readonly query: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(query: string): GmailMailbox | null {
    const clientId = process.env.JOB_RADAR_GMAIL_CLIENT_ID;
    const clientSecret = process.env.JOB_RADAR_GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.JOB_RADAR_GMAIL_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    return new GmailMailbox({ clientId, clientSecret, refreshToken }, query);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Gmail token refresh returned no access_token.");
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3000) * 1000 };
    return json.access_token;
  }

  async page(args: { after: string; before: string; pageToken: string | null; pageSize: number }) {
    const auth = { authorization: `Bearer ${await this.accessToken()}` };
    const after = Math.floor(Date.parse(args.after) / 1000);
    const before = Math.ceil(Date.parse(args.before) / 1000);
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", `${this.query} after:${after} before:${before}`);
    url.searchParams.set("maxResults", String(args.pageSize));
    if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
    const listRes = await this.fetchImpl(url, { headers: auth });
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
    const list = (await listRes.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    const messages: Email[] = [];
    for (const m of list.messages ?? []) {
      const res = await this.fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth });
      // An unreadable message fails the page: a window with a hole in it is
      // not complete, and the cursor must not advance past it.
      if (!res.ok) throw new Error(`Gmail could not read message ${m.id}: ${res.status}`);
      messages.push(parseGmailMessage((await res.json()) as GmailMessage));
    }
    return { messages, nextPageToken: list.nextPageToken ?? null };
  }
}

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

export function parseGmailMessage(msg: GmailMessage): Email {
  const headers = msg.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const plain = findPart(msg.payload, "text/plain");
  const html = findPart(msg.payload, "text/html");
  const body = plain ? decode(plain) : html ? htmlToText(decode(html)) : "";
  let receivedAt: string;
  if (msg.internalDate) receivedAt = new Date(Number(msg.internalDate)).toISOString();
  else {
    const d = Date.parse(header("Date"));
    receivedAt = Number.isNaN(d) ? new Date(0).toISOString() : new Date(d).toISOString();
  }
  return { id: msg.id, from: header("From"), subject: header("Subject"), body, receivedAt };
}

function findPart(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const f = findPart(p, mime);
    if (f) return f;
  }
  return null;
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
