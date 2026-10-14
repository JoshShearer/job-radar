import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic JSON: object keys sorted at every depth, `undefined` dropped.
 * Two structurally equal inputs always serialize to the same bytes, which is
 * what makes `hashInput` usable as a content address.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortDeep(val);
    }
    return out;
  }
  return v;
}

/** The single content-address function every derivation input goes through. */
export function hashInput(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function shortId(input: string, len = 12): string {
  return sha256(input).slice(0, len);
}
