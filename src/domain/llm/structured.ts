import { z } from "zod";

/**
 * One schema definition per model output. The JSON Schema sent to the API is
 * GENERATED from the Zod schema the response is validated against, so the two
 * cannot drift (the old code maintained both by hand).
 *
 * Structured outputs accept a subset of JSON Schema, so numeric/length/pattern
 * constraints are stripped from the request. They are still enforced: the
 * response is validated against the full Zod schema before anything is stored.
 * Each stripped constraint is restated in the field's description, because a
 * limit the model is never told is one it will break (observed live: a dossier
 * with nine strengths against a hidden max of eight).
 */
const UNSUPPORTED = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "default",
]);

export function toStructuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "output", unrepresentable: "any" }) as Record<string, unknown>;
  return sanitize(raw) as Record<string, unknown>;
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    if ((k === "properties" || k === "definitions" || k === "$defs") && v && typeof v === "object") {
      // A map of NAMES to schemas: keep every name, sanitize each schema.
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, sanitize(sub)]));
      continue;
    }
    out[k] = sanitize(v);
  }
  const stated = statedConstraints(node as Record<string, unknown>);
  if (stated) out.description = typeof out.description === "string" && out.description ? `${out.description} ${stated}` : stated;
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties as Record<string, unknown>);
    out.additionalProperties = false;
  }
  return out;
}

/** The stripped constraints of one schema node, in words. */
function statedConstraints(n: Record<string, unknown>): string {
  const num = (k: string) => (typeof n[k] === "number" ? (n[k] as number) : undefined);
  const parts: string[] = [];
  const range = (lo: number | undefined, hi: number | undefined, unit: string) => {
    if (lo !== undefined && hi !== undefined) parts.push(lo === hi ? `Exactly ${lo} ${unit}.` : `${lo} to ${hi} ${unit}.`);
    else if (hi !== undefined) parts.push(`At most ${hi} ${unit}.`);
    else if (lo !== undefined && lo > 0) parts.push(`At least ${lo} ${unit}.`);
  };
  range(num("minItems"), num("maxItems"), "items");
  range(num("minLength"), num("maxLength"), "characters");
  const lo = num("minimum") ?? num("exclusiveMinimum");
  const hi = num("maximum") ?? num("exclusiveMaximum");
  if (lo !== undefined && hi !== undefined) parts.push(`A number between ${lo} and ${hi}.`);
  else if (hi !== undefined) parts.push(`At most ${hi}.`);
  else if (lo !== undefined) parts.push(`At least ${lo}.`);
  if (typeof n.pattern === "string") parts.push(`Must match the pattern ${n.pattern}.`);
  return parts.join(" ");
}

/** Validate a parsed response, returning a readable error list on failure. */
export function validateStructured<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; value: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}
