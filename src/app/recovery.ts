import type { AppContext } from "./context.js";
import type { RecoveryStore } from "../ports/recovery.js";
import {
  buildManifest,
  compareHashes,
  compareRowCounts,
  DB_PATH,
  holdsGeneration,
  planRetention,
  reconcile,
  reconciliationDifferences,
  restoreTargetRefusal,
  setName,
  type BackupManifestV2,
  type FileHashes,
  type GenerationRef,
  type Reconciliation,
} from "../domain/recovery/recovery-set.js";
import { degraded, ok, refused, type UseCaseResult } from "../kernel/result.js";

export interface BackupResult {
  dir: string | null;
  files: number;
  bytes: number;
  pruned: string[];
  leftovers: string[];
  /** Generations in the set that the database snapshot does not reference. Accepted. */
  orphans: string[];
  /** Generations the database snapshot references that the set does not hold. Degrades the run. */
  missing: string[];
}

/**
 * `jr backup`: one complete, verified recovery set, then retention. A set
 * that fails verification is reported and never counted; retention only
 * prunes verified sets and never the one this run just wrote, nor the last
 * one holding a recorded generation the new set lacks. A set missing a
 * recorded generation is still verified and restorable, but never silent.
 */
export async function backup(
  ctx: Pick<AppContext, "clock">,
  store: RecoveryStore,
  opts: { withArtifacts: boolean; keep: number },
): Promise<UseCaseResult<BackupResult>> {
  const at = ctx.clock.now();
  const name = setName(at);
  const empty: BackupResult = { dir: null, files: 0, bytes: 0, pruned: [], leftovers: [], orphans: [], missing: [] };
  const refusal = store.stagingProblem({ withArtifacts: opts.withArtifacts });
  if (refusal) return refused(empty, [refusal]);
  let dir: string;
  let manifest: BackupManifestV2;
  let generations: GenerationRef[];
  try {
    const staged = await store.stage(name, { withArtifacts: opts.withArtifacts, clock: ctx.clock });
    generations = staged.generations;
    manifest = buildManifest({
      name: staged.name,
      createdAt: at.toISOString(),
      app: store.appInfo(),
      database: staged.database,
      withArtifacts: opts.withArtifacts,
      trees: staged.trees,
      files: staged.files,
      capture: staged.capture,
      generations,
    });
    dir = store.complete(staged, manifest);
  } catch (err) {
    return {
      outcome: "failed",
      value: empty,
      notes: [`Backup failed and is NOT complete: ${err instanceof Error ? err.message : String(err)}`, `Anything written is left in ${store.root} as a .partial directory; it is never counted as a backup.`],
    };
  }
  const check = store.inspect(dir);
  if (!check.manifest || check.problems.length > 0) {
    return { outcome: "failed", value: { ...empty, dir }, notes: [`Backup ${dir} failed verification after writing: ${check.problems.join("; ")}`, "Retention was skipped."] };
  }
  const m = check.manifest;
  const files = Object.keys(m.files).length;
  const bytes = Object.values(m.files).reduce((s, f) => s + f.bytes, 0);
  const notes = [
    `Backed up to ${dir} (database ${(m.files[DB_PATH]!.bytes / 1e6).toFixed(1)} MB, integrity checked; ${files} files, ${(bytes / 1e6).toFixed(1)} MB, every hash verified)`,
    `Not included: ${m.excluded.map((e) => e.path).join(", ")} (reasons in manifest.json)`,
    ...reconciliationNotes(manifest.reconciliation),
  ];
  const orphans = manifest.reconciliation.state === "checked" ? manifest.reconciliation.orphans.map((o) => o.generation) : [];
  const missing = missingLabels(manifest.reconciliation);

  const unheld = generations.filter((g) => !holdsGeneration(g, m.files));
  const plan = planRetention(store.list(), opts.keep, dir.slice(dir.lastIndexOf("/") + 1), unheld);
  for (const k of plan.keptForGenerations) notes.push(`kept ${k.name} beyond --keep: it holds ${k.generations.join(", ")}, which the new set does not.`);
  for (const old of plan.prune) {
    store.remove(old);
    notes.push(`pruned ${old}`);
  }
  for (const l of plan.leftovers) {
    notes.push(`kept, not counted: ${l.name} (${l.state}${l.problems.length ? `: ${l.problems.slice(0, 3).join("; ")}` : ""}). Not a verified backup; delete it by hand once you have checked it.`);
  }
  const value = { dir, files, bytes, pruned: plan.prune, leftovers: plan.leftovers.map((l) => l.name), orphans, missing };
  return plan.leftovers.length > 0 || missing.length > 0 ? degraded(value, notes) : ok(value, notes);
}

const label = (m: { generation: string | null; artifactId: string }) => m.generation ?? `artifact ${m.artifactId}`;

function missingLabels(r: Reconciliation): string[] {
  return r.state === "checked" ? [...new Set(r.missing.map(label))] : [];
}

/** One line per missing generation, and what to do about them. */
function missingNotes(r: Reconciliation): string[] {
  if (r.state !== "checked" || r.missing.length === 0) return [];
  return [
    ...r.missing.map((m) => `MISSING generation ${label(m)}: ${m.problems.slice(0, 3).join("; ")}${m.problems.length > 3 ? `; and ${m.problems.length - 3} more` : ""}`),
    "The database references it but this set does not hold it as recorded. If an older set holds it, restore that set elsewhere and copy its artifacts/<opportunity>/<generation> back; if it is only at its recorded old location, copy it under artifacts/.",
  ];
}

function reconciliationNotes(r: Reconciliation): string[] {
  if (r.state === "not-checked") {
    return r.referenced === 0 ? [] : [`The database references ${r.referenced} generation${r.referenced === 1 ? "" : "s"}, not checked and NOT recoverable from this set (--without-artifacts).`];
  }
  const notes = [`Generations: ${r.referenced} referenced by the database snapshot, ${r.held.length} held in the set with their recorded bytes`];
  if (r.orphans.length > 0) notes.push(`In the set but not in the database snapshot (published after it, or never recorded): ${r.orphans.map((o) => o.generation).join(", ")}`);
  return [...notes, ...missingNotes(r)];
}

export interface RestoreResult {
  from: string | null;
  to: string;
  files: number;
  rowCounts: Record<string, number>;
  /** Generations the restored database references that the set does not hold. Degrades the restore. */
  missing: string[];
}

/**
 * `jr restore <set> --to <dir>`: copy a verified set into an empty directory
 * outside the live home. Every manifest hash is checked before and after
 * copying, and the restored database is opened and integrity-checked. Restore
 * copies files; it never edits a row or touches the live data.
 *
 * The reconciliation of a format-2 set is re-derived from the restored
 * database and files, and that result is the one reported. Reconciliation is a
 * derived value, so a manifest that disagrees, or a missing generation,
 * degrades the restore; it never refuses files and rows that verified.
 */
export async function restore(
  store: RecoveryStore,
  opts: { set: string; to: string; liveHome: string; liveDb: string },
): Promise<UseCaseResult<RestoreResult>> {
  const to = store.canonical(opts.to);
  const none: RestoreResult = { from: null, to, files: 0, rowCounts: {}, missing: [] };
  const from = store.locate(opts.set);
  if (!from) return refused(none, [`No backup set at ${opts.set} (looked for a directory, then for a set of that name in ${store.root}).`]);
  const src = store.canonical(from);
  const value = { ...none, from: src };

  const target = restoreTargetRefusal(to, { "live Job Radar home": store.canonical(opts.liveHome), "live database's directory": store.canonical(dirOf(opts.liveDb)), "backup set being restored": src });
  if (target) return refused(value, [target]);
  const dest = store.destinationProblem(to);
  if (dest) return refused(value, [dest]);

  const before = store.inspect(src);
  if (!before.manifest) return refused(value, [`${src} is not a complete backup set: ${before.problems.join("; ")}`]);
  if (before.problems.length > 0) return refused(value, [`${src} does not match its manifest, so it was not restored:`, ...before.problems.map((p) => `  ${p}`)]);
  const m = before.manifest;

  let copied;
  try {
    copied = store.copyOut(src, m, to);
  } catch (err) {
    return { outcome: "failed", value, notes: [`Restore into ${to} stopped: ${err instanceof Error ? err.message : String(err)}`, `Nothing already in ${to} was overwritten; what was copied is incomplete, so delete it (after checking your own files) before trying again.`] };
  }
  const after = compareHashes(m.files, copied);
  if (after.length > 0) return { outcome: "failed", value, notes: [`The copy in ${to} does not match the manifest:`, ...after.map((p) => `  ${p}`), `${to} is incomplete; delete it before trying again.`] };

  let db;
  try {
    db = store.probeDatabase(`${to}/${DB_PATH}`);
  } catch (err) {
    return { outcome: "failed", value, notes: [`The restored database in ${to} could not be opened: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const rows = compareRowCounts(m.database.rowCounts, db.rowCounts);
  if (db.integrityCheck !== "ok" || rows.length > 0) {
    return { outcome: "failed", value: { ...value, rowCounts: db.rowCounts }, notes: [`The restored database in ${to} failed verification: integrity_check ${db.integrityCheck}`, ...rows.map((p) => `  ${p}`)] };
  }
  const files = Object.keys(m.files).length;
  const generations = m.format === 2 ? checkRestoredGenerations(store, m, `${to}/${DB_PATH}`, copied) : { notes: [FORMAT_1_NOTE], missing: [], clean: true };
  const result: RestoreResult = { from: src, to, files, rowCounts: db.rowCounts, missing: generations.missing };
  const notes = [
    `Restored ${files} files from ${src} into ${to}; every hash matched before and after copying.`,
    `Database: integrity_check ok, schema version ${m.database.schemaVersion}, row counts match the manifest (${Object.values(db.rowCounts).reduce((a, b) => a + b, 0)} rows in ${Object.keys(db.rowCounts).length} tables).`,
    `Not in the set: ${m.excluded.map((e) => e.path).join(", ")}. Re-create .env by hand; sign in again for \`jr fill\`.`,
    `To use it: JR_HOME=${to} npm run cli -- check. Your live data was not touched.`,
    ...generations.notes,
  ];
  return generations.clean ? ok(result, notes) : degraded(result, notes);
}

const FORMAT_1_NOTE = "This set is format 1: it records neither capture times nor a reconciliation, so whether config/ is newer than the database, and whether every recorded generation is in it, was not checked.";

function checkRestoredGenerations(store: RecoveryStore, m: BackupManifestV2, dbFile: string, copied: FileHashes): { notes: string[]; missing: string[]; clean: boolean } {
  const window = (w: { startedAt: string; finishedAt: string }) => `${w.startedAt} to ${w.finishedAt}`;
  const notes = [`config/ was copied after the database snapshot (database ${window(m.capture.database)}, config ${window(m.capture.config)}), so it may be newer than the database.`];
  let derived: Reconciliation;
  try {
    derived = reconcile(store.generationRefs(dbFile), copied, m.capture.artifacts !== null);
  } catch (err) {
    notes.push(`The generations the restored database references could not be re-checked: ${err instanceof Error ? err.message : String(err)}`);
    return { notes, missing: missingLabels(m.reconciliation), clean: false };
  }
  notes.push(...reconciliationNotes(derived));
  const differences = reconciliationDifferences(m.reconciliation, derived);
  if (differences.length > 0) notes.push("The manifest's reconciliation differs from what the restored database and files say; the restored result above is the one to trust:", ...differences.map((d) => `  ${d}`));
  const missing = missingLabels(derived);
  return { notes, missing, clean: missing.length === 0 && differences.length === 0 };
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}
