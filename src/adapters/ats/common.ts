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
