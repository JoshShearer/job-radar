import type { BackupManifest, DatabaseSnapshot, FileHashes, SetListing } from "../domain/recovery/recovery-set.js";

/** A recovery set written into `<root>/<name>.partial/`, not yet complete. */
export interface StagedSet {
  name: string;
  dir: string;
  database: DatabaseSnapshot;
  files: FileHashes;
}

/**
 * Backup sets on local disk. Nothing here uploads anywhere. The live home is
 * only ever read; restore only writes into an empty destination.
 */
export interface RecoveryStore {
  readonly root: string;
  appInfo(): { name: string; version: string };
  /** Snapshot the database and copy the included trees into `<name>.partial/`. */
  stage(name: string, opts: { withArtifacts: boolean }): Promise<StagedSet>;
  /** Write the manifest last, then rename `<name>.partial` to `<name>`. Returns the final directory. */
  complete(staged: StagedSet, manifest: BackupManifest): string;
  /** Every `jr-*` directory under the root, each re-hashed against its manifest. */
  list(): SetListing[];
  remove(name: string): void;
  /** Absolute, symlink-resolved form of a path that may not exist yet. */
  canonical(path: string): string;
  /** Resolve a set by path or by name under the root; null when it is not a directory. */
  locate(ref: string): string | null;
  /** The manifest of a set and every difference between it and the files on disk. */
  inspect(dir: string): { manifest: BackupManifest | null; problems: string[] };
  /** Null when the destination does not exist or is an empty directory; otherwise why it cannot be used. */
  destinationProblem(dest: string): string | null;
  /** Copy exactly the manifest's files into `dest`, then re-hash them there. */
  copyOut(dir: string, manifest: BackupManifest, dest: string): FileHashes;
  /** Open the restored database read-only: integrity_check and per-table row counts. */
  probeDatabase(file: string): DatabaseSnapshot;
}
