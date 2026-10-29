import type { IncomingHttpHeaders } from "node:http";

/**
 * Who may reach the web UI. The server only ever binds 127.0.0.1, so a request
 * arrives either from this machine directly or through a reverse proxy on it
 * (`tailscale serve`). Each is admitted on its own terms:
 *
 *   direct   the Host must be a loopback name (a DNS-rebinding page cannot
 *            drive the UI by pointing its own name at 127.0.0.1)
 *   proxied  the Host must be listed in operations.yaml `web.allowed_hosts`
 *            AND the proxy must vouch for a tailnet login listed in
 *            `web.allowed_logins`
 *
 * A request is treated as proxied when it carries any forwarding or Tailscale
 * header, so a proxy that rewrites Host to 127.0.0.1 still has to present an
 * identity. `tailscale serve` strips client-supplied Tailscale-User-* headers
 * and replaces X-Forwarded-For (checked against the live proxy), so its login
 * header can be trusted. A public Funnel request carries no login, and is
 * refused outright when it is marked as one.
 */
export interface AccessPolicy {
  allowedHosts: readonly string[];
  allowedLogins: readonly string[];
}

export type Admission =
  | { ok: true; via: "loopback"; host: string }
  | { ok: true; via: "tailnet"; host: string; login: string; name: string | null }
  | { ok: false; why: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "tailscale-user-login", "tailscale-headers-info", "tailscale-funnel-request"];

function one(h: IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v.length === 1 ? v[0]! : null) : v;
}

/** The hostname in a Host header, lowercased and without its port; null when malformed. */
export function hostnameOf(host: string | null | undefined): string | null {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec((host ?? "").trim().toLowerCase());
  return m ? m[1]! : null;
}

export function admit(h: IncomingHttpHeaders, policy: AccessPolicy): Admission {
  const host = hostnameOf(one(h, "host"));
  if (!host) return { ok: false, why: "missing or malformed Host header" };
  if (h["tailscale-funnel-request"] !== undefined) return { ok: false, why: "public Funnel requests are refused" };
  const proxied = PROXY_HEADERS.some((k) => h[k] !== undefined);
  if (!proxied) {
    return LOOPBACK.has(host) ? { ok: true, via: "loopback", host } : { ok: false, why: `Host "${host}" is not a loopback name` };
  }
  if (!policy.allowedHosts.includes(host)) return { ok: false, why: `Host "${host}" is not in web.allowed_hosts` };
  const login = one(h, "tailscale-user-login")?.trim().toLowerCase() ?? "";
  if (!login) return { ok: false, why: "the proxy did not identify a tailnet user" };
  if (!policy.allowedLogins.some((l) => l.trim().toLowerCase() === login)) return { ok: false, why: `tailnet login "${login}" is not in web.allowed_logins` };
  return { ok: true, via: "tailnet", host, login, name: one(h, "tailscale-user-name") };
}

/**
 * A write must come from a page this server rendered. Browsers send Origin on
 * every form POST; when present it must name the very host the request came
 * in on. Sec-Fetch-Site, when present, must not say cross-site. The CSRF token
 * is checked separately.
 */
export function sameOrigin(h: IncomingHttpHeaders): boolean {
  const site = one(h, "sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = one(h, "origin");
  if (origin === null) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.host.toLowerCase() === (one(h, "host") ?? "").trim().toLowerCase();
}
