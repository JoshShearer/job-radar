import type { AppContext } from "./context.js";
import type { RecoveryStore } from "../ports/recovery.js";
import { buildManifest, compareHashes, compareRowCounts, DB_PATH, planRetention, restoreTargetRefusal, setName } from "../domain/recovery/recovery-set.js";
import { degraded, ok, refused, type UseCaseResult } from "../kernel/result.js";

export interface BackupResult {
  dir: string | null;
  files: number;
  bytes: number;
  pruned: string[];
  leftovers: string[];
}

/**
 * `jr backup`: one complete, verified recovery set, then retention. A set
 * that fails verification is reported and never counted; retention only
 * prunes verified sets and never the one this run just wrote.
 */
export async function backup(
  ctx: Pick<AppContext, "clock">,
  store: RecoveryStore,
  opts: { withArtifacts: boolean; keep: number },
): Promise<UseCaseResult<BackupResult>> {
  const at = ctx.clock.now();
  const name = setName(at);
  const empty: BackupResult = { dir: null, files: 0, bytes: 0, pruned: [], leftovers: [] };
  const refusal = store.stagingProblem({ withArtifacts: opts.withArtifacts });
  if (refusal) return refused(empty, [refusal]);
  let dir: string;
  try {
    const staged = await store.stage(name, { withArtifacts: opts.withArtifacts });
    const manifest = buildManifest({ name: staged.name, createdAt: at.toISOString(), app: store.appInfo(), database: staged.database, withArtifacts: opts.withArtifacts, files: staged.files });
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
  ];

  const plan = planRetention(store.list(), opts.keep, dir.slice(dir.lastIndexOf("/") + 1));
  for (const old of plan.prune) {
    store.remove(old);
    notes.push(`pruned ${old}`);
  }
  for (const l of plan.leftovers) {
    notes.push(`kept, not counted: ${l.name} (${l.state}${l.problems.length ? `: ${l.problems.slice(0, 3).join("; ")}` : ""}). Not a verified backup; delete it by hand once you have checked it.`);
  }
  const value = { dir, files, bytes, pruned: plan.prune, leftovers: plan.leftovers.map((l) => l.name) };
  return plan.leftovers.length > 0 ? degraded(value, notes) : ok(value, notes);
}

export interface RestoreResult {
  from: string | null;
  to: string;
  files: number;
  rowCounts: Record<string, number>;
}

/**
 * `jr restore <set> --to <dir>`: copy a verified set into an empty directory
 * outside the live home. Every manifest hash is checked before and after
 * copying, and the restored database is opened and integrity-checked. Restore
 * copies files; it never edits a row or touches the live data.
 */
export async function restore(
  store: RecoveryStore,
  opts: { set: string; to: string; liveHome: string; liveDb: string },
): Promise<UseCaseResult<RestoreResult>> {
  const to = store.canonical(opts.to);
  const none: RestoreResult = { from: null, to, files: 0, rowCounts: {} };
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

  const db = store.probeDatabase(`${to}/${DB_PATH}`);
  const rows = compareRowCounts(m.database.rowCounts, db.rowCounts);
  if (db.integrityCheck !== "ok" || rows.length > 0) {
    return { outcome: "failed", value: { ...value, rowCounts: db.rowCounts }, notes: [`The restored database in ${to} failed verification: integrity_check ${db.integrityCheck}`, ...rows.map((p) => `  ${p}`)] };
  }
  const files = Object.keys(m.files).length;
  return ok({ from: src, to, files, rowCounts: db.rowCounts }, [
    `Restored ${files} files from ${src} into ${to}; every hash matched before and after copying.`,
    `Database: integrity_check ok, schema version ${m.database.schemaVersion}, row counts match the manifest (${Object.values(db.rowCounts).reduce((a, b) => a + b, 0)} rows in ${Object.keys(db.rowCounts).length} tables).`,
    `Not in the set: ${m.excluded.map((e) => e.path).join(", ")}. Re-create .env by hand; sign in again for \`jr fill\`.`,
    `To use it: JR_HOME=${to} npm run cli -- check. Your live data was not touched.`,
  ]);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}
