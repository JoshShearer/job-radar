import type { Period } from "../../domain/text/salary.js";

export function mapInterval(interval: string | null | undefined): Period | null {
  if (!interval) return null;
  const i = interval.toUpperCase();
  if (i.includes("YEAR") || i === "ANNUAL" || i === "ANNUALLY") return "year";
  if (i.includes("MONTH")) return "month";
  if (i.includes("WEEK")) return "week";
  if (i.includes("DAY")) return "day";
  if (i.includes("HOUR")) return "hour";
  return null;
}

export function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Fetch one posting's detail for a two-call provider. Any failure fails the
 * whole board: a board with a hole in it must never be recorded as a complete
 * sweep, because absence from a complete sweep means the posting closed.
 */
export async function detailOrFail<T>(transport: { getJson<U>(url: string): Promise<U> }, url: string, postingId: string): Promise<T> {
  try {
    const d = await transport.getJson<T>(url);
    if (!d || typeof d !== "object") throw new Error("unexpected payload: not an object");
    return d;
  } catch (err) {
    throw new Error(`detail ${postingId}: ${(err as Error).message ?? String(err)}`);
  }
}

/** A posting is never emitted without a description: a missing one would read as a material change. */
export function requireDescription(html: string, postingId: string): string {
  if (html.replace(/<[^>]*>/g, "").trim() === "") throw new Error(`detail ${postingId}: empty description`);
  return html;
}
