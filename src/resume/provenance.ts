import { canonicalSkill, containsSkill, extractNumericClaims } from "../lib/text.js";
import type { Resume } from "./schema.js";
import { allBullets } from "./schema.js";

/**
 * Provenance checking.
 *
 * A tailored resume is a selection from the master plus light rephrasing. This
 * module is what makes that a guarantee instead of an instruction in a prompt.
 * Every generated line names the master bullet it came from, and these checks
 * confirm the source exists and still says what the line claims.
 *
 * The two rules that matter, both deterministic:
 *
 * 1. A rewrite may not introduce a technology the master resume does not
 *    claim. This is how "tailoring" turns into a lie - the posting wants
 *    Kubernetes, the bullet is about deployment, and a helpful rewrite quietly
 *    adds the word.
 * 2. A rewrite may not introduce or inflate a number. "200+ experiments" must
 *    not become "500+", and a bullet with no metric must not acquire one.
 */

export interface Violation {
  bulletId: string;
  kind: "unknown_bullet" | "unverified_bullet" | "invented_skill" | "invented_metric" | "wrong_role";
  detail: string;
}

/** Skill spellings the candidate legitimately claims, plus common tech terms. */
export function buildVocabulary(resume: Resume): string[] {
  const v = new Set<string>();
  for (const s of resume.skills) {
    for (const spelling of [s.name, ...s.aliases]) {
      const c = canonicalSkill(spelling);
      if (c) v.add(c);
    }
  }
  return [...v];
}

/**
 * Terms that would be a claim if they appeared. Deliberately a fixed list
 * rather than "any capitalized word": the point is to catch technology claims,
 * and a company name or a product noun is not one.
 */
const CLAIMABLE_TECH = [
  "rust", "golang", "go", "kubernetes", "k8s", "terraform", "kafka", "spark", "scala", "elixir",
  "ruby", "rails", "django", "flask", "java", "kotlin", "swift", "c++", "c#", "net", "php",
  "laravel", "graphql", "grpc", "redis", "elasticsearch", "snowflake", "databricks", "dbt",
  "airflow", "tensorflow", "pytorch", "langchain", "llamaindex", "mcp", "rag", "pinecone",
  "docker", "gcp", "azure", "salesforce", "hubspot", "segment", "amplitude", "kubeflow",
  "microservices", "micro frontends", "webassembly", "wasm", "solidity", "blockchain",
];

/**
 * Check a rewritten bullet against its source.
 *
 * On violation the caller must fall back to the original text. Degrading to
 * the truth is always available and always correct; there is no case where
 * shipping the rewrite is better than shipping the accurate original.
 */
export function checkRewrite(
  bulletId: string,
  original: string,
  rewritten: string,
  vocabulary: string[],
): Violation[] {
  const out: Violation[] = [];
  const origCanon = canonicalSkill(original);
  const newCanon = canonicalSkill(rewritten);

  const allowed = new Set(vocabulary);
  for (const term of CLAIMABLE_TECH) {
    const c = canonicalSkill(term);
    if (!containsSkill(newCanon, c)) continue;
    if (containsSkill(origCanon, c)) continue; // already in the source
    if (allowed.has(c)) continue; // the candidate genuinely claims this skill
    out.push({
      bulletId,
      kind: "invented_skill",
      detail: `rewrite introduces "${term}", which is not in the source bullet or the master skill list`,
    });
  }

  const originalNumbers = new Set(extractNumericClaims(original));
  for (const n of extractNumericClaims(rewritten)) {
    if (!originalNumbers.has(n)) {
      out.push({
        bulletId,
        kind: "invented_metric",
        detail: `rewrite introduces the figure "${n}", which does not appear in the source bullet`,
      });
    }
  }

  return out;
}

/**
 * Confirm every cited bullet id exists in the master, is verified, and - when
 * `expectedOwnerId` is given - belongs to the role/project it is cited under.
 *
 * That last check is what stops a plan citing role B's bullet under role A: a
 * bullet that legitimately exists and is verified is still wrong evidence if
 * it renders under an employer who never made that claim.
 */
export function checkSelection(resume: Resume, bulletIds: string[], expectedOwnerId?: string): Violation[] {
  const index = new Map(allBullets(resume).map((b) => [b.bullet.id, b]));
  const out: Violation[] = [];
  for (const id of bulletIds) {
    const entry = index.get(id);
    if (!entry) {
      out.push({ bulletId: id, kind: "unknown_bullet", detail: "no bullet with this id exists in the master resume" });
      continue;
    }
    if (!entry.bullet.verified) {
      out.push({
        bulletId: id,
        kind: "unverified_bullet",
        detail: "bullet is marked verified: false and must not be used",
      });
      continue;
    }
    if (expectedOwnerId && entry.sourceId !== expectedOwnerId) {
      out.push({
        bulletId: id,
        kind: "wrong_role",
        detail: `bullet belongs to "${entry.sourceLabel}" (${entry.sourceId}), not "${expectedOwnerId}"`,
      });
    }
  }
  return out;
}
