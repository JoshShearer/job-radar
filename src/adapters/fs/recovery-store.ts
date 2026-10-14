import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { RecoveryStore, StagedSet } from "../../ports/recovery.js";
import {
  compareHashes,
  DB_PATH,
  MANIFEST_FILE,
  manifestSchema,
  PARTIAL_SUFFIX,
  SET_PREFIX,
  type BackupManifest,
  type DatabaseSnapshot,
  type FileHashes,
  type SetListing,
} from "../../domain/recovery/recovery-set.js";
import { backupDatabase, probeDatabase, type DB } from "../sqlite/db.js";
import { writeFileAtomic } from "./yaml-writers.js";
import { PACKAGE_ROOT } from "./paths.js";

export interface RecoverySources {
  db: DB;
  config: string;
  artifacts: string;
}

/** Recovery sets as directories under one local root. Never uploads anything. */
export class FsRecoveryStore implements RecoveryStore {
  readonly root: string;
  constructor(root: string, private readonly live: RecoverySources | null) {
    this.root = resolve(root);
  }

  appInfo() {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { name?: string; version?: string };
    return { name: pkg.name ?? "job-radar", version: pkg.version ?? "unknown" };
  }

  stagingProblem(opts: { withArtifacts: boolean }): string | null {
    if (!this.live) return null;
    const root = this.canonical(this.root);
    const trees: [string, string][] = [["config/", this.live.config]];
    if (opts.withArtifacts) trees.push(["artifacts/", this.live.artifacts]);
    for (const [label, tree] of trees) {
      if (!existsSync(tree)) continue;
      const t = this.canonical(tree);
      if (within(root, t)) return `refusing to write backups to ${root}: it is inside ${label} (${t}), which every backup copies. Choose an --out outside the included trees.`;
    }
    return null;
  }

  async stage(name: string, opts: { withArtifacts: boolean }): Promise<StagedSet> {
    if (!this.live) throw new Error("no live data to back up");
    const refusal = this.stagingProblem(opts);
    if (refusal) throw new Error(refusal);
    let finalName = name;
    for (let i = 2; existsSync(join(this.root, finalName)) || existsSync(join(this.root, finalName + PARTIAL_SUFFIX)); i++) finalName = `${name}-${i}`;
    const dir = join(this.root, finalName + PARTIAL_SUFFIX);
    mkdirSync(dir, { recursive: true });
    await backupDatabase(this.live.db, join(dir, DB_PATH));
    const database = probeDatabase(join(dir, DB_PATH));
    // Symlinks are followed: the set holds the real bytes, so it never depends on (or dangles into) the live tree.
    const forbidden = this.canonical(this.root);
    if (existsSync(this.live.config)) copyTree(this.live.config, join(dir, "config"), "config", { skip: () => false, forbidden, ancestors: [] });
    if (opts.withArtifacts && existsSync(this.live.artifacts)) {
      // A `.tmp-*` sibling is a generation still being written (or abandoned): never part of the set.
      copyTree(this.live.artifacts, join(dir, "artifacts"), "artifacts", { skip: (n) => n.startsWith(".tmp-"), forbidden, ancestors: [] });
    }
    return { name: finalName, dir, database, files: hashTree(dir) };
  }

  complete(staged: StagedSet, manifest: BackupManifest): string {
    const problems = compareHashes(manifest.files, hashTree(staged.dir));
    if (problems.length > 0) throw new Error(`staged files changed before the manifest was written: ${problems.join("; ")}`);
    // The manifest is the completion marker: written last, then the directory is renamed into place.
    writeFileAtomic(join(staged.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    const final = join(this.root, staged.name);
    renameSync(staged.dir, final);
    return final;
  }

  list(): SetListing[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((f) => f.startsWith(SET_PREFIX) && statSync(join(this.root, f)).isDirectory())
      .map((name): SetListing => {
        if (name.endsWith(PARTIAL_SUFFIX)) return { name, state: "partial", problems: ["incomplete: the backup that wrote it did not finish"] };
        const { manifest, problems } = this.inspect(join(this.root, name));
        if (!manifest) return { name, state: "no-manifest", problems };
        return { name, state: problems.length === 0 ? "verified" : "unverified", problems };
      });
  }

  remove(name: string): void {
    if (name.includes("/") || name.includes("..") || !name.startsWith(SET_PREFIX)) throw new Error(`refusing to remove ${name}`);
    rmSync(join(this.root, name), { recursive: true, force: true });
  }

  canonical(path: string): string {
    const abs = resolve(path);
    const rest: string[] = [];
    let cur = abs;
    while (!existsSync(cur)) {
      rest.unshift(basename(cur));
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    return rest.length ? join(realpathSync(cur), ...rest) : realpathSync(cur);
  }

  locate(ref: string): string | null {
    for (const p of [resolve(ref), join(this.root, ref)]) if (existsSync(p) && statSync(p).isDirectory()) return p;
    return null;
  }

  inspect(dir: string): { manifest: BackupManifest | null; problems: string[] } {
    if (basename(dir).endsWith(PARTIAL_SUFFIX)) return { manifest: null, problems: ["a .partial directory is an unfinished backup"] };
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) return { manifest: null, problems: [`no ${MANIFEST_FILE} (unfinished, damaged, or written before backups had manifests)`] };
    let manifest: BackupManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      return { manifest: null, problems: [`${MANIFEST_FILE} is not a valid completed manifest: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`] };
    }
    return { manifest, problems: compareHashes(manifest.files, hashTree(dir)) };
  }

  destinationProblem(dest: string): string | null {
    if (!existsSync(dest)) return null;
    if (!statSync(dest).isDirectory()) return `refusing to restore into ${dest}: it exists and is not a directory`;
    const entries = readdirSync(dest);
    return entries.length === 0 ? null : `refusing to restore into ${dest}: it is not empty (${entries.length} entries). Restore never overwrites; choose an empty or new directory.`;
  }

  copyOut(dir: string, manifest: BackupManifest, dest: string): FileHashes {
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) mkdirSync(dest);
    for (const rel of Object.keys(manifest.files)) {
      const target = resolve(dest, rel);
      if (!target.startsWith(dest + sep)) throw new Error(`manifest path escapes the destination: ${rel}`);
      mkdirSync(dirname(target), { recursive: true });
      try {
        // Exclusive create: anything that appeared after the emptiness check is never overwritten.
        copyFileSync(join(dir, rel), target, constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${rel} appeared in ${dest} after it was checked; restore never overwrites, so it stopped`);
        throw err;
      }
    }
    return hashTree(dest);
  }

  probeDatabase(file: string): DatabaseSnapshot {
    return probeDatabase(file);
  }
}

/** sha256 and size of every file under `dir`, keyed by `/`-separated relative path. The manifest itself is not hashed. */
export function hashTree(dir: string): FileHashes {
  const out: FileHashes = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = relative(dir, p).split(sep).join("/");
        if (rel === MANIFEST_FILE) continue;
        out[rel] = hashFile(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** sha256 and size of one file, read in chunks so memory stays flat however large the file. */
function hashFile(path: string): { sha256: string; bytes: number } {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      h.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: h.digest("hex"), bytes };
}

/**
 * Copy a tree as real files: symlinks (to files or directories) are followed
 * and their targets' bytes copied. A dangling link, a link loop, a special
 * file, or a link leading to a directory that holds the backup root fails the
 * backup rather than silently leaving something out.
 */
function copyTree(src: string, dest: string, label: string, opts: { skip: (name: string) => boolean; forbidden: string; ancestors: string[] }): void {
  const real = realpathSync(src);
  if (opts.ancestors.includes(real)) throw new Error(`${label} is a symlink loop (it leads back to ${real})`);
  if (within(opts.forbidden, real)) throw new Error(`${label} leads to ${real}, which contains the backup root ${opts.forbidden}; refusing to copy backups into themselves`);
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (opts.skip(name)) continue;
    const from = join(src, name);
    const rel = `${label}/${name}`;
    let st;
    try {
      st = statSync(from);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(`${rel} is a dangling symlink (its target does not exist)`);
      if (code === "ELOOP") throw new Error(`${rel} is a symlink loop`);
      throw err;
    }
    if (st.isDirectory()) copyTree(from, join(dest, name), rel, { ...opts, ancestors: [...opts.ancestors, real] });
    else if (st.isFile()) copyFileSync(from, join(dest, name), constants.COPYFILE_EXCL);
    else throw new Error(`${rel} is not a regular file or directory, so it cannot be backed up`);
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

