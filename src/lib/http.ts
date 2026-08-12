import { log } from "./log.js";

export interface HttpOptions {
  delayMs: number;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
}

export const DEFAULT_HTTP: HttpOptions = {
  delayMs: 1200,
  timeoutMs: 20000,
  maxRetries: 2,
  userAgent: "job-radar/0.1 (personal job search)",
};

/**
 * Per-host serialized fetch with a fixed delay between requests.
 *
 * Rate limiting here is deliberate and not configurable down to zero: these are
 * other people's free public endpoints. If a host returns 429 or 503 we back
 * off and retry a bounded number of times, then give up on that source rather
 * than hammering it. We never retry a 4xx other than 429.
 */
export class PoliteFetcher {
  private readonly opts: HttpOptions;
  private hostQueues = new Map<string, Promise<unknown>>();

  constructor(opts: Partial<HttpOptions> = {}) {
    this.opts = { ...DEFAULT_HTTP, ...opts };
  }

  /** Queue work behind any in-flight request to the same host. */
  private schedule<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.hostQueues.get(host) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but do not let a rejection poison later requests.
    this.hostQueues.set(
      host,
      next.then(
        () => sleep(this.opts.delayMs),
        () => sleep(this.opts.delayMs),
      ),
    );
    return next;
  }

  async getJson<T = unknown>(url: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const host = safeHost(url);
    return this.schedule(host, async () => {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
        if (attempt > 0) {
          const backoff = this.opts.delayMs * 2 ** attempt;
          log.debug(`retry ${attempt} for ${url} after ${backoff}ms`);
          await sleep(backoff);
        }
        try {
          const res = await this.request(url, extraHeaders);
          if (res.ok) return (await res.json()) as T;

          const retryable = res.status === 429 || res.status >= 500;
          const detail = `HTTP ${res.status} ${res.statusText}`;
          if (!retryable) throw new HttpError(detail, res.status, url);
          lastError = new HttpError(detail, res.status, url);

          // Honor Retry-After when the server sends one.
          const retryAfter = Number(res.headers.get("retry-after"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) {
            await sleep(Math.min(retryAfter * 1000, 30_000));
          }
        } catch (err) {
          if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
      throw lastError ?? new Error(`request failed: ${url}`);
    });
  }

  async getText(url: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const host = safeHost(url);
    return this.schedule(host, async () => {
      const res = await this.request(url, extraHeaders);
      if (!res.ok) throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
      return res.text();
    });
  }

  private async request(url: string, extraHeaders: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": this.opts.userAgent,
          accept: "application/json, text/plain, */*",
          ...extraHeaders,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(`${message} (${url})`);
    this.name = "HttpError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
