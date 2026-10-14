import { describe, expect, it } from "vitest";
import { PoliteTransport, retryAfterMs } from "../src/adapters/http/polite-transport.js";
import { OperationsSchema } from "../src/domain/config/schema.js";
import { testConfig } from "./helpers/context.js";

const base = { delayMs: 500, timeoutMs: 1000, maxRetries: 2, maxRetryAfterMs: 5000, userAgent: "test" };
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("PoliteTransport", () => {
  it("refuses a delay below the floor, at the transport AND in config", () => {
    expect(() => new PoliteTransport({ ...base, delayMs: 0 })).toThrow(/floor/);
    const ops = testConfig().operations;
    expect(OperationsSchema.safeParse({ ...ops, http: { ...ops.http, delay_ms: 0 } }).success).toBe(false);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(retryAfterMs("7", 0)).toBe(7000);
    expect(retryAfterMs(new Date(60_000).toUTCString(), 0)).toBe(60_000);
    expect(retryAfterMs("nonsense", 0)).toBeNull();
  });

  it("waits exactly what the server asked before retrying", async () => {
    const waits: number[] = [];
    let n = 0;
    const t = new PoliteTransport(base, (async () => (++n === 1 ? res(429, {}, { "retry-after": "3" }) : res(200, { ok: true }))) as typeof fetch, async (ms) => {
      waits.push(ms);
    });
    await expect(t.getJson("https://a.example/x")).resolves.toEqual({ ok: true });
    expect(waits).toContain(3000);
  });

  it("gives up rather than retrying sooner than a long Retry-After", async () => {
    let n = 0;
    const t = new PoliteTransport(base, (async () => {
      n++;
      return res(503, {}, { "retry-after": "600" });
    }) as typeof fetch, async () => {});
    await expect(t.getJson("https://b.example/x")).rejects.toThrow(/asked to wait 600s/);
    expect(n).toBe(1);
  });

  it("never retries a 404", async () => {
    let n = 0;
    const t = new PoliteTransport(base, (async () => {
      n++;
      return res(404);
    }) as typeof fetch, async () => {});
    await expect(t.getJson("https://c.example/x")).rejects.toThrow(/404/);
    expect(n).toBe(1);
  });

  it("serializes requests to one host across transport instances, with the delay between them", async () => {
    const log: string[] = [];
    const slowFetch = (async (url: string) => {
      log.push(`start ${url}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${url}`);
      return res(200, {});
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const a = new PoliteTransport(base, slowFetch, wait);
    const b = new PoliteTransport(base, slowFetch, wait);
    await Promise.all([a.getJson("https://same.example/1"), b.getJson("https://same.example/2")]);
    expect(log).toEqual(["start https://same.example/1", "end https://same.example/1", "start https://same.example/2", "end https://same.example/2"]);
    expect(waits.filter((w) => w === 500).length).toBeGreaterThanOrEqual(1);
  });
});
