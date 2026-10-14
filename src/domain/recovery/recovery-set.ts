import { z } from "zod";

/**
 * The recovery set: what `jr backup` copies, what it deliberately leaves out,
 * and the manifest that says so. A set is a directory laid out like a Job
 * Radar home (`data/jr.sqlite`, `config/`, `artifacts/`), so a restored copy
 * can be used directly as `JR_HOME`.
 *
 * Completion protocol: everything is written into `<name>.partial/`, the
 * manifest is written LAST with `completed: true`, then the directory is
 * renamed to `<name>`. A directory without that manifest (a crash, a full
 * disk, a backup from before manifests existed) is never a recovery set.
 */
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_FORMAT = 1;
export const PARTIAL_SUFFIX = ".partial";
export const SET_PREFIX = "jr-";
export const DB_PATH = "data/jr.sqlite";

export interface Inclusion {
  path: string;
  reason: string;
}

/** Always in the set. */
export const INCLUDED: readonly Inclusion[] = [
  { path: DB_PATH, reason: "every fact and its history: postings, sweeps, events, applications, model-call receipts (online-backup snapshot, integrity-checked)" },
  { path: "config/", reason: "search strategy, preferences, policy, sources, and the candidate's evidence.yaml and personal.yaml (irreplaceable: the only source of claims and form answers)" },
];

export const ARTIFACTS: Inclusion = {
  path: "artifacts/",
  reason: "saved application generations: the exact documents reviewed, and possibly sent; regenerating them is not the same document",
};

/** Never in the set, and why. Named in every manifest so the omission is a decision, not an accident. */
export const EXCLUDED: readonly Inclusion[] = [
  { path: ".env", reason: "credentials (API key, mail OAuth secrets) are never copied into a backup; re-enter them by hand after a restore" },
  { path: ".browser-profile/", reason: "browser cookies and sessions for employer sites: operational state that holds logins, never copied; sign in again after a restore" },
  { path: "reports/", reason: "rebuildable from the database: run `jr report`" },
  { path: "data/backups/", reason: "other backups are not copied into a backup" },
];

export const ARTIFACTS_EXCLUDED: Inclusion = { path: "artifacts/", reason: "left out on request (--without-artifacts); saved generations are NOT recoverable from this set" };

export const ARTIFACTS_ABSENT: Inclusion = { path: "artifacts/", reason: "absent: the live home had no artifacts/ directory when this set was written (no generation had been saved yet), so there was nothing to include" };

export type TreePath = "config/" | "artifacts/";

/**
 * What the adapter found at one included root of the live home and copied.
 * `absent` means the root did not exist at all (lstat: no entry); a root that
 * exists but cannot be followed or read never becomes `absent`, it fails.
 * `files` are the set-relative paths the walker copied, so they can be held
 * against what was actually hashed.
 */
export interface TreeCopy {
  path: TreePath;
  state: "copied" | "absent";
  files: string[];
}

/**
 * Why the copied trees do not add up to a complete set, or empty. Every tree
 * the set promises must be accounted for; config/ must be present and
 * non-empty (a set without it can never restore a working home); and every
 * file the walker copied must be exactly what was hashed under that tree.
 */
export function treeProblems(withArtifacts: boolean, trees: readonly TreeCopy[], files: FileHashes): string[] {
  const problems: string[] = [];
  const expected: TreePath[] = withArtifacts ? ["config/", "artifacts/"] : ["config/"];
  for (const t of trees) if (!expected.includes(t.path)) problems.push(`${t.path} was copied but is not part of this set`);
  for (const path of expected) {
    const found = trees.filter((t) => t.path === path);
    if (found.length !== 1) {
      problems.push(`${path} was ${found.length === 0 ? "never checked" : "checked more than once"}, so the set cannot say whether it is complete`);
      continue;
    }
    const tree = found[0]!;
    const hashed = Object.keys(files).filter((f) => f.startsWith(path)).sort();
    if (tree.state === "absent") {
      if (path === "config/") problems.push("config/ is missing from the live home; a set without config can never restore a working home");
      if (hashed.length > 0) problems.push(`${path} was reported absent but ${hashed.length} files were hashed under it`);
      continue;
    }
    if (path === "config/" && tree.files.length === 0) problems.push("config/ has no files; a set without config can never restore a working home");
    const copied = new Set(tree.files);
    for (const f of tree.files) if (!(f in files)) problems.push(`${f} was copied but is not in the set`);
    for (const f of hashed) if (!copied.has(f)) problems.push(`${f} is in the set but the walker never copied it`);
  }
  return problems;
}

/** Why a parsed manifest cannot describe a complete set, or empty. Checked on every inspect, so a set missing its config is never counted as verified. */
export function manifestProblems(m: BackupManifest): string[] {
  const problems: string[] = [];
  if (!m.files[DB_PATH]) problems.push(`no ${DB_PATH} in the manifest`);
  if (!m.included.some((i) => i.path === "config/")) problems.push("config/ is not listed as included");
  if (!Object.keys(m.files).some((f) => f.startsWith("config/"))) problems.push("the set holds no config/ files; it can never restore a working home");
  for (const i of m.included) if (m.excluded.some((e) => e.path === i.path)) problems.push(`${i.path} is listed as both included and not included`);
  return problems;
}

const fileEntry = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() });

export const manifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    completed: z.literal(true),
    name: z.string().min(1),
    createdAt: z.string().min(1),
    app: z.object({ name: z.string(), version: z.string() }).strict(),
    database: z
      .object({
        path: z.literal(DB_PATH),
        schemaVersion: z.number().int().nonnegative(),
        integrityCheck: z.literal("ok"),
        tables: z.number().int().positive(),
        rowCounts: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    included: z.array(z.object({ path: z.string(), reason: z.string() }).strict()),
    excluded: z.array(z.object({ path: z.string(), reason: z.string() }).strict()),
    files: z.record(z.string(), fileEntry),
  })
  .strict();

export type BackupManifest = z.infer<typeof manifestSchema>;
export type FileHashes = BackupManifest["files"];

export interface DatabaseSnapshot {
  schemaVersion: number;
  integrityCheck: string;
  tables: number;
  rowCounts: Record<string, number>;
}

/** `jr-2026-10-14T21-40-21-123Z`: sortable, filesystem-safe. */
export function setName(at: Date): string {
  return `${SET_PREFIX}${at.toISOString().replace(/[:.]/g, "-")}`;
}

export function buildManifest(input: {
  name: string;
  createdAt: string;
  app: { name: string; version: string };
  database: DatabaseSnapshot;
  withArtifacts: boolean;
  trees: readonly TreeCopy[];
  files: FileHashes;
}): BackupManifest {
  if (input.database.integrityCheck !== "ok") throw new Error(`database snapshot failed integrity_check: ${input.database.integrityCheck}`);
  if (!input.files[DB_PATH]) throw new Error(`the recovery set has no ${DB_PATH}`);
  const problems = treeProblems(input.withArtifacts, input.trees, input.files);
  if (problems.length > 0) throw new Error(`the set is not complete: ${problems.slice(0, 10).join("; ")}`);
  const artifactsCopied = input.trees.some((t) => t.path === "artifacts/" && t.state === "copied");
  const manifest = manifestSchema.parse({
    format: MANIFEST_FORMAT,
    completed: true,
    name: input.name,
    createdAt: input.createdAt,
    app: input.app,
    database: { path: DB_PATH, ...input.database, integrityCheck: "ok" },
    included: artifactsCopied ? [...INCLUDED, ARTIFACTS] : [...INCLUDED],
    excluded: !input.withArtifacts ? [...EXCLUDED, ARTIFACTS_EXCLUDED] : artifactsCopied ? [...EXCLUDED] : [...EXCLUDED, ARTIFACTS_ABSENT],
    files: input.files,
  });
  const after = manifestProblems(manifest);
  if (after.length > 0) throw new Error(`the set is not complete: ${after.join("; ")}`);
  return manifest;
}

/** Every difference between what the manifest promises and what is on disk. Empty means verified. */
export function compareHashes(expected: FileHashes, actual: FileHashes): string[] {
  const problems: string[] = [];
  for (const [path, want] of Object.entries(expected)) {
    const got = actual[path];
    if (!got) problems.push(`missing ${path}`);
    else if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) problems.push(`hash mismatch ${path}`);
  }
  for (const path of Object.keys(actual)) if (!(path in expected)) problems.push(`not in manifest ${path}`);
  return problems;
}

export function compareRowCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const table of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[table] !== actual[table]) problems.push(`table ${table}: manifest ${expected[table] ?? "absent"}, restored ${actual[table] ?? "absent"}`);
  }
  return problems;
}

export type SetState = "verified" | "unverified" | "partial" | "no-manifest";

export interface SetListing {
  name: string;
  state: SetState;
  /** Why it is not verified, when it is not. */
  problems: string[];
}

export interface RetentionPlan {
  prune: string[];
  keptVerified: string[];
  /** Reported every run, never counted, never deleted. */
  leftovers: SetListing[];
}

/**
 * Keep `keep` verified sets (at least one). `protect`, the set the current
 * run just wrote, is always kept and counted first, so a clock that went
 * backwards can never prune it; the rest of the quota goes to the newest
 * other verified sets. Without `protect` the newest verified set is never
 * pruned. Only verified sets are counted or pruned; partial, unverified and
 * manifest-less directories are reported and left for a human to delete.
 */
export function planRetention(sets: readonly SetListing[], keep: number, protect?: string): RetentionPlan {
  const verified = sets.filter((s) => s.state === "verified").map((s) => s.name).sort();
  const n = Math.max(1, Math.floor(keep));
  const kept = new Set(protect !== undefined && verified.includes(protect) ? [protect] : []);
  for (const name of [...verified].reverse()) if (kept.size < n) kept.add(name);
  return {
    prune: verified.filter((v) => !kept.has(v)),
    keptVerified: verified.filter((v) => kept.has(v)),
    leftovers: sets.filter((s) => s.state !== "verified").sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Restore never writes into the live home (or anything inside it) or into the
 * set it reads. Paths must already be absolute and canonical.
 */
export function restoreTargetRefusal(dest: string, protectedRoots: Record<string, string>): string | null {
  for (const [label, root] of Object.entries(protectedRoots)) {
    if (within(dest, root)) return `refusing to restore into ${dest}: it is ${dest === root ? "" : "inside "}the ${label} (${root}). Restore into an empty directory elsewhere.`;
    if (within(root, dest)) return `refusing to restore into ${dest}: it contains the ${label} (${root}). Restore into an empty directory elsewhere.`;
  }
  return null;
}

function within(child: string, parent: string): boolean {
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(p);
}
