import { MIN_TRANSPORT_DELAY_MS } from "../../domain/config/schema.js";
import type { Transport } from "../../ports/io.js";

export interface TransportOptions {
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs: number;
  userAgent: string;
}

/**
 * Per-host serialized fetch with an enforced floor between requests.
 *
 * Load-bearing, not tunable down: these are other people's free endpoints.
 * The floor is checked HERE, at the transport, so no config path can bypass
 * it. Host queues are process-wide, so two transports cannot double the rate.
 * `Retry-After` (seconds or HTTP date) is honored exactly: if the server asks
 * for longer than `maxRetryAfterMs`, the request gives up rather than retrying
 * early.
 */
const hostQueues = new Map<string, Promise<unknown>>();

export class HttpError extends Error {
  override name = "HttpError";
  constructor(message: string, readonly status: number, readonly url: string) {
    super(`${message} (${url})`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse Retry-After as delta-seconds or an HTTP date. Null when absent or invalid. */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - nowMs);
}

export class PoliteTransport implements Transport {
  private readonly opts: TransportOptions;

  constructor(opts: TransportOptions, private readonly fetchImpl: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = sleep) {
    if (!(opts.delayMs >= MIN_TRANSPORT_DELAY_MS)) {
      throw new Error(`PoliteTransport: delayMs ${opts.delayMs} is below the ${MIN_TRANSPORT_DELAY_MS}ms floor`);
    }
    this.opts = opts;
  }

  private schedule<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = hostQueues.get(host) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    hostQueues.set(
      host,
      next.then(
        () => this.wait(this.opts.delayMs),
        () => this.wait(this.opts.delayMs),
      ),
    );
    return next;
  }

  async getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return this.schedule(hostOf(url), async () => {
      let last: Error | null = null;
      for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
        if (attempt > 0) await this.wait(this.opts.delayMs * 2 ** attempt);
        let res: Response;
        try {
          res = await this.request(url, headers);
        } catch (err) {
          last = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        if (res.ok) return (await res.json()) as T;
        const err = new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
        if (!(res.status === 429 || res.status >= 500)) throw err;
        last = err;
        const ra = retryAfterMs(res.headers.get("retry-after"), Date.now());
        if (ra !== null) {
          if (ra > this.opts.maxRetryAfterMs) {
            throw new HttpError(`server asked to wait ${Math.round(ra / 1000)}s; not retrying sooner`, res.status, url);
          }
          await this.wait(ra);
        }
      }
      throw last ?? new Error(`request failed: ${url}`);
    });
  }

  async status(url: string): Promise<number> {
    return this.schedule(hostOf(url), async () => {
      try {
        return (await this.request(url, {})).status;
      } catch {
        return 0;
      }
    });
  }

  private async request(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": this.opts.userAgent, accept: "application/json, text/plain, */*", ...headers },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
