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
 *
 * Divergence between the three stores (ADR 0005). Nothing freezes them at one
 * instant: the database is snapshotted first, then config/, then artifacts/.
 *  - A generation the snapshot does not reference (an orphan: published while
 *    the backup ran, or never recorded) is accepted and listed.
 *  - config/ newer than the snapshot is accepted; both capture windows are
 *    recorded and a restore says so.
 *  - A generation the snapshot references that is not in the set with its
 *    recorded bytes is never accepted silently: it is listed as missing and
 *    the backup and the restore are degraded. The set stays verified, because
 *    everything else in it must remain recoverable.
 */
export const MANIFEST_FILE = "manifest.json";
/**
 * The format written now. Format 1 (no capture times, no reconciliation) stays
 * verifiable and restorable. A change to the manifest's shape, to what a
 * generation's identity is, or to the reconciliation rules is a NEW format;
 * `tests/fixtures/recovery-sets/` pins the sets already on disk.
 */
export const MANIFEST_FORMAT = 2;
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

export const ARTIFACTS_ABSENT: Inclusion = { path: "artifacts/", reason: "absent: the live home had no artifacts/ directory when this set was written, so there was nothing to include (reconciliation lists any generation the database references)" };

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
  if (m.format === 2) problems.push(...captureProblems(m));
  return problems;
}

/**
 * Whether the capture record and the reconciliation state contradict each
 * other. Keyed on structure, never on reason text (wording may change), and
 * never on re-deriving the reconciliation: a derived value must not stop a
 * hash-verified set from being restored. Restore re-derives and reports it.
 */
function captureProblems(m: BackupManifestV2): string[] {
  if (m.reconciliation.state === "checked") return m.capture.artifacts === null ? ["reconciliation is marked checked but artifacts/ was never captured"] : [];
  const problems: string[] = [];
  if (m.capture.artifacts !== null) problems.push("reconciliation is marked not checked but artifacts/ was captured");
  if (Object.keys(m.files).some((f) => f.startsWith(ARTIFACTS.path))) problems.push("reconciliation is marked not checked but the set holds artifacts/ files");
  if (!m.excluded.some((e) => e.path === ARTIFACTS.path)) problems.push("artifacts/ was not captured but is not listed as excluded");
  return problems;
}

const fileEntry = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() });

/** Format 1 exactly as it was written. Frozen. */
const manifestV1 = z
  .object({
    format: z.literal(1),
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

const captureWindow = z.object({ startedAt: z.string().min(1), finishedAt: z.string().min(1) }).strict();

const reconciliationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("checked"),
      /** Artifact rows in the database snapshot. */
      referenced: z.number().int().nonnegative(),
      /** `<opportunity>/<generation>` in the set with every recorded byte. */
      held: z.array(z.string()),
      /** In the set, but not referenced by the snapshot. */
      orphans: z.array(z.object({ generation: z.string(), files: z.number().int().positive() }).strict()),
      /** Referenced by the snapshot, but not (wholly, or checkably) in the set. */
      missing: z.array(z.object({ generation: z.string().nullable(), artifactId: z.string(), problems: z.array(z.string()).min(1) }).strict()),
      /** Files under artifacts/ that belong to no generation directory. */
      otherFiles: z.array(z.string()),
    })
    .strict(),
  z.object({ state: z.literal("not-checked"), referenced: z.number().int().nonnegative(), reason: z.string() }).strict(),
]);

const manifestV2 = manifestV1
  .extend({
    format: z.literal(2),
    /** When each store was read. `artifacts` is null only when they were left out on request. */
    capture: z.object({ database: captureWindow, config: captureWindow, artifacts: captureWindow.nullable() }).strict(),
    reconciliation: reconciliationSchema,
  })
  .strict();

export const manifestSchema = z.discriminatedUnion("format", [manifestV1, manifestV2]);

export type BackupManifest = z.infer<typeof manifestSchema>;
export type BackupManifestV2 = z.infer<typeof manifestV2>;
export type Capture = BackupManifestV2["capture"];
export type Reconciliation = BackupManifestV2["reconciliation"];
export type FileHashes = BackupManifest["files"];

export interface DatabaseSnapshot {
  schemaVersion: number;
  integrityCheck: string;
  tables: number;
  rowCounts: Record<string, number>;
}

/** One row of the snapshot's `artifact` table, as far as recovery is concerned. */
export interface GenerationRef {
  artifactId: string;
  /** `<opportunity>/<generation>`, or null when the recorded directory does not name one. */
  generation: string | null;
  /** The recorded files by name, or null when the row's file list cannot be read or is empty. */
  files: Record<string, { sha256: string }> | null;
}

const recordedManifest = z.object({ files: z.record(z.string(), z.object({ sha256: fileEntry.shape.sha256 })) });

/** The files an artifact row records, or null when there is nothing that can be checked. */
export function recordedFiles(manifestJson: string): GenerationRef["files"] {
  let json: unknown;
  try {
    json = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  const parsed = recordedManifest.safeParse(json);
  return parsed.success && Object.keys(parsed.data.files).length > 0 ? parsed.data.files : null;
}

const pathOf = (generation: string, file = "") => `${ARTIFACTS.path}${generation}/${file}`;

/** Why `ref` is not held by a set with these files, or empty. */
function generationProblems(ref: GenerationRef, files: FileHashes): string[] {
  if (ref.generation === null) return ["the recorded directory names no <opportunity>/<generation>"];
  if (ref.files === null) return ["the recorded file list is unreadable, so it could not be checked"];
  const problems: string[] = [];
  for (const [name, want] of Object.entries(ref.files)) {
    const got = files[pathOf(ref.generation, name)];
    if (!got) problems.push(`${name}: not in the set`);
    else if (got.sha256 !== want.sha256) problems.push(`${name}: its sha256 is not the recorded one`);
  }
  return problems;
}

/** Whether a set with these files holds `ref`: the recorded bytes of every file, or any file of it when no readable list says which. */
export function holdsGeneration(ref: GenerationRef, files: FileHashes): boolean {
  const { generation } = ref;
  if (generation !== null && ref.files === null) return Object.keys(files).some((f) => f.startsWith(pathOf(generation)));
  return generationProblems(ref, files).length === 0;
}

/**
 * The database snapshot's generation references held against the files in the
 * set (what a restore reproduces), not against a directory listing. An empty
 * generation directory has no files, so a restore would not reproduce it and
 * it is not listed.
 */
export function reconcileGenerations(refs: readonly GenerationRef[], files: FileHashes): Extract<Reconciliation, { state: "checked" }> {
  const inSet = new Map<string, number>();
  const otherFiles: string[] = [];
  for (const f of Object.keys(files)) {
    if (!f.startsWith(ARTIFACTS.path)) continue;
    const [opportunity, generation, ...rest] = f.slice(ARTIFACTS.path.length).split("/");
    if (rest.length === 0) otherFiles.push(f);
    else inSet.set(`${opportunity}/${generation}`, (inSet.get(`${opportunity}/${generation}`) ?? 0) + 1);
  }
  const missing = refs.map((r) => ({ generation: r.generation, artifactId: r.artifactId, problems: generationProblems(r, files) })).filter((r) => r.problems.length > 0);
  const referenced = new Set(refs.flatMap((r) => (r.generation === null ? [] : [r.generation])));
  const notHeld = new Set(missing.map((r) => r.generation));
  return {
    state: "checked",
    referenced: refs.length,
    held: [...referenced].filter((g) => !notHeld.has(g)).sort(),
    orphans: [...inSet].filter(([g]) => !referenced.has(g)).map(([generation, n]) => ({ generation, files: n })).sort((a, b) => (a.generation < b.generation ? -1 : 1)),
    missing,
    otherFiles: otherFiles.sort(),
  };
}

/** `not-checked` when artifacts/ was left out on request: there is nothing to check against. */
export function reconcile(refs: readonly GenerationRef[], files: FileHashes, artifactsCaptured: boolean): Reconciliation {
  if (artifactsCaptured) return reconcileGenerations(refs, files);
  return { state: "not-checked", referenced: refs.length, reason: "artifacts/ was left out on request (--without-artifacts), so no generation could be checked against this set" };
}

/** Where a recorded reconciliation and a re-derived one disagree. Order and wording (problems, reasons) are not differences. */
export function reconciliationDifferences(recorded: Reconciliation, derived: Reconciliation): string[] {
  const facts = (r: Reconciliation): Record<string, string[]> => ({
    state: [r.state],
    referenced: [String(r.referenced)],
    ...(r.state === "checked"
      ? {
          held: r.held,
          orphans: r.orphans.map((o) => `${o.generation} (${o.files} files)`),
          missing: r.missing.map((m) => `${m.generation ?? "unnamed"} (artifact ${m.artifactId})`),
          otherFiles: r.otherFiles,
        }
      : {}),
  });
  const [a, b] = [facts(recorded), facts(derived)];
  const out: string[] = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const only = (x: string[] = [], y: string[] = []) => x.filter((v) => !y.includes(v));
    const [gone, added] = [only(a[field], b[field]), only(b[field], a[field])];
    if (gone.length > 0 || added.length > 0) out.push(`${field}: manifest only [${gone.join(", ")}], re-derived only [${added.join(", ")}]`);
  }
  return out;
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
  capture: Capture;
  generations: readonly GenerationRef[];
}): BackupManifestV2 {
  if (input.database.integrityCheck !== "ok") throw new Error(`database snapshot failed integrity_check: ${input.database.integrityCheck}`);
  if (!input.files[DB_PATH]) throw new Error(`the recovery set has no ${DB_PATH}`);
  const problems = treeProblems(input.withArtifacts, input.trees, input.files);
  if (problems.length > 0) throw new Error(`the set is not complete: ${problems.slice(0, 10).join("; ")}`);
  const artifactsCopied = input.trees.some((t) => t.path === "artifacts/" && t.state === "copied");
  const manifest = manifestV2.parse({
    format: MANIFEST_FORMAT,
    completed: true,
    name: input.name,
    createdAt: input.createdAt,
    app: input.app,
    database: { path: DB_PATH, ...input.database, integrityCheck: "ok" },
    included: artifactsCopied ? [...INCLUDED, ARTIFACTS] : [...INCLUDED],
    excluded: !input.withArtifacts ? [...EXCLUDED, ARTIFACTS_EXCLUDED] : artifactsCopied ? [...EXCLUDED] : [...EXCLUDED, ARTIFACTS_ABSENT],
    files: input.files,
    capture: input.capture,
    reconciliation: reconcile(input.generations, input.files, input.withArtifacts),
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
  /** The files of a verified set, by its manifest (and re-hashed against it). */
  files?: FileHashes;
}

export interface RetentionPlan {
  prune: string[];
  keptVerified: string[];
  /** Kept beyond the quota, each with the generations that would otherwise be lost. */
  keptForGenerations: { name: string; generations: string[] }[];
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
 *
 * `unheld` are the generations the database references that the new set does
 * not hold. The newest verified set holding each is kept beyond the quota, so
 * retention never prunes the last copy of one. When no set holds the whole of
 * one, the newest holder of each of its recorded files is kept instead.
 */
export function planRetention(sets: readonly SetListing[], keep: number, protect?: string, unheld: readonly GenerationRef[] = []): RetentionPlan {
  const verified = sets.filter((s) => s.state === "verified").map((s) => s.name).sort();
  const n = Math.max(1, Math.floor(keep));
  const kept = new Set(protect !== undefined && verified.includes(protect) ? [protect] : []);
  for (const name of [...verified].reverse()) if (kept.size < n) kept.add(name);
  const filesOf = new Map(sets.filter((s) => s.state === "verified").map((s) => [s.name, s.files ?? {}]));
  const extra = new Map<string, Set<string>>();
  for (const ref of unheld) {
    const { generation } = ref;
    if (generation === null) continue;
    const whole = (name: string) => holdsGeneration(ref, filesOf.get(name)!);
    const parts = Object.entries(ref.files ?? {}).map(([file, want]) => (name: string) => filesOf.get(name)![pathOf(generation, file)]?.sha256 === want.sha256);
    for (const holds of verified.some(whole) ? [whole] : parts) {
      if ([...kept].some(holds)) continue;
      const newest = [...verified].reverse().find(holds);
      if (newest === undefined) continue;
      kept.add(newest);
      extra.set(newest, (extra.get(newest) ?? new Set()).add(generation));
    }
  }
  return {
    prune: verified.filter((v) => !kept.has(v)),
    keptVerified: verified.filter((v) => kept.has(v)),
    keptForGenerations: [...extra].map(([name, generations]) => ({ name, generations: [...generations].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
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
