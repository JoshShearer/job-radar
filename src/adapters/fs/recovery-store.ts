import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
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

  async stage(name: string, opts: { withArtifacts: boolean }): Promise<StagedSet> {
    if (!this.live) throw new Error("no live data to back up");
    let finalName = name;
    for (let i = 2; existsSync(join(this.root, finalName)) || existsSync(join(this.root, finalName + PARTIAL_SUFFIX)); i++) finalName = `${name}-${i}`;
    const dir = join(this.root, finalName + PARTIAL_SUFFIX);
    mkdirSync(dir, { recursive: true });
    await backupDatabase(this.live.db, join(dir, DB_PATH));
    const database = probeDatabase(join(dir, DB_PATH));
    if (existsSync(this.live.config)) cpSync(this.live.config, join(dir, "config"), { recursive: true });
    if (opts.withArtifacts && existsSync(this.live.artifacts)) {
      // A `.tmp-*` sibling is a generation still being written (or abandoned): never part of the set.
      cpSync(this.live.artifacts, join(dir, "artifacts"), { recursive: true, filter: (src) => !basename(src).startsWith(".tmp-") });
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
    mkdirSync(dest, { recursive: true });
    for (const rel of Object.keys(manifest.files)) {
      const target = resolve(dest, rel);
      if (!target.startsWith(dest + sep)) throw new Error(`manifest path escapes the destination: ${rel}`);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(dir, rel), target);
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
        const buf = readFileSync(p);
        out[rel] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
      }
    }
  };
  walk(dir);
  return out;
}

