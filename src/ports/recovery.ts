import type { BackupManifest, Capture, DatabaseSnapshot, FileHashes, GenerationRef, SetListing, TreeCopy } from "../domain/recovery/recovery-set.js";
import type { Clock } from "../kernel/clock.js";

/** A recovery set written into `<root>/<name>.partial/`, not yet complete. */
export interface StagedSet {
  name: string;
  dir: string;
  database: DatabaseSnapshot;
  /** Every root the set promises (config/, and artifacts/ when included): copied, or absent from the live home. */
  trees: TreeCopy[];
  files: FileHashes;
  /** When each store was read, in the order they were read: database, config, artifacts. */
  capture: Capture;
  /** What the STAGED database references, never the live one: a row written after the snapshot is not in the set. */
  generations: GenerationRef[];
}

/**
 * Backup sets on local disk. Nothing here uploads anywhere. The live home is
 * only ever read; restore only writes into an empty destination.
 */
export interface RecoveryStore {
  readonly root: string;
  appInfo(): { name: string; version: string };
  /** Why sets cannot be written under this root (it lies inside a tree every backup copies), or null. */
  stagingProblem(opts: { withArtifacts: boolean }): string | null;
  /** Snapshot the database and copy the included trees into `<name>.partial/`. */
  stage(name: string, opts: { withArtifacts: boolean; clock: Clock }): Promise<StagedSet>;
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
  /** Copy exactly the manifest's files into `dest` (exclusive create: never overwrites; throws instead), then re-hash them there. */
  copyOut(dir: string, manifest: BackupManifest, dest: string): FileHashes;
  /** Open the restored database read-only: integrity_check and per-table row counts. */
  probeDatabase(file: string): DatabaseSnapshot;
  /** Every generation a database file references, read-only. */
  generationRefs(file: string): GenerationRef[];
}
