import { z } from "zod";
import { EvidenceSchema, type Evidence } from "./evidence.js";
import { extractNumbers, extractTechnology, extractNames } from "../materials/verify.js";

/**
 * Model output for `evidence import`: the ledger in strict, model-friendly
 * form. Whatever comes back is checked against the SOURCE text before it is
 * written: a claim containing a number, technology or name the source does
 * not contain is marked verified: false, so an importer that embellishes
 * produces an unverified claim, never a usable one.
 */
const ImportClaim = z.object({ id: z.string(), text: z.string(), skills: z.array(z.string()), verified: z.boolean() }).strict();

export const ImportSchema = z
  .object({
    basics: z
      .object({ name: z.string(), location: z.string(), headline: z.string(), summary: z.string() })
      .strict(),
    skills: z
      .array(z.object({ name: z.string(), aliases: z.array(z.string()), level: z.enum(["expert", "strong", "working", "familiar"]) }).strict()),
    experience: z.array(
      z
        .object({
          id: z.string(),
          company: z.string(),
          title: z.string(),
          start: z.string(),
          end: z.string().nullable(),
          location: z.string(),
          claims: z.array(ImportClaim),
        })
        .strict(),
    ),
    projects: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), claims: z.array(ImportClaim) }).strict()),
    education: z.array(z.object({ id: z.string(), school: z.string(), credential: z.string(), year: z.string() }).strict()),
    uncertain: z.array(z.string()),
  })
  .strict();
export type ImportResult = z.infer<typeof ImportSchema>;

export function checkImport(result: ImportResult, source: string): { evidence: Evidence; uncertain: string[] } {
  const sourceNumbers = extractNumbers(source);
  const sourceTech = extractTechnology(source, []);
  const sourceLower = source.toLowerCase();
  const uncertain = [...result.uncertain];
  const check = (owner: string, c: z.infer<typeof ImportClaim>) => {
    const novel = [
      ...[...extractNumbers(c.text)].filter((n) => !sourceNumbers.has(n)).map((n) => `figure ${n}`),
      ...[...extractTechnology(c.text, [])].filter((t) => !sourceTech.has(t)).map((t) => `technology ${t}`),
      ...[...extractNames(c.text)].filter((n) => !sourceLower.includes(n)).map((n) => `name ${n}`),
    ];
    if (novel.length && c.verified) {
      uncertain.push(`${owner}/${c.id}: not in the source (${novel.join(", ")}); marked verified: false`);
      return { ...c, verified: false };
    }
    return c;
  };
  const evidence = EvidenceSchema.parse({
    basics: result.basics,
    skills: result.skills,
    experience: result.experience.map((r) => ({ ...r, claims: r.claims.map((c) => check(r.id, c)) })),
    projects: result.projects.map((p) => ({ ...p, claims: p.claims.map((c) => check(p.id, c)) })),
    education: result.education,
  });
  return { evidence, uncertain };
}
