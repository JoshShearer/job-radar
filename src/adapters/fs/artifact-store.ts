import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ArtifactExpectation, ArtifactResolution, ArtifactStore } from "../../ports/io.js";

/**
 * Generations are immutable directories: artifacts/<opportunity>/<generation>/.
 * Written into a temporary sibling and renamed into place in one step, so a
 * reader (or a crash) never sees half a generation, and an old generation that
 * may already have been sent is never overwritten.
 */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  publish(opportunityId: string, generationId: string, files: Record<string, string | Uint8Array>) {
    const parent = resolve(this.root, safe(opportunityId));
    const final = join(parent, safe(generationId));
    if (existsSync(final)) throw new Error(`generation ${generationId} already exists; generations are immutable`);
    const tmp = join(parent, `.tmp-${safe(generationId)}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const manifest: Record<string, { sha256: string; bytes: number }> = {};
    try {
      for (const [name, content] of Object.entries(files)) {
        if (name.includes("/") || name.includes("..")) throw new Error(`invalid artifact file name ${name}`);
        const buf = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
        writeFileSync(join(tmp, name), buf);
        manifest[name] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
      }
      renameSync(tmp, final);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    return { dir: final, files: manifest };
  }

  path(dir: string, file: string, expect?: ArtifactExpectation): string {
    return this.resolve(dir, file, expect).path;
  }

  /** The text of a file, or null when it exists nowhere. Throws when a manifest hash is given and no copy matches it. */
  read(dir: string, file: string, expect?: ArtifactExpectation): string | null {
    const r = this.resolve(dir, file, expect);
    if (r.mismatch) throw new Error(r.mismatch);
    return existsSync(r.path) ? readFileSync(r.path, "utf8") : null;
  }

  /**
   * The generation's logical identity is <opportunity>/<generation>, the last
   * two segments of the recorded directory. The copy under the ACTIVE root is
   * authoritative; the recorded absolute directory is a legacy fallback (an old
   * installation's data directory can still be on disk after a restore, with
   * different bytes). With a manifest hash, the bytes decide: a legacy copy is
   * read only when the active one fails and it matches (with a warning), and
   * when neither matches the mismatch is reported, never silently resolved.
   */
  resolve(dir: string, file: string, expect?: ArtifactExpectation): ArtifactResolution {
    const active = join(this.root, basename(dirname(dir)), basename(dir), file);
    const legacy = join(dir, file);
    const hasActive = existsSync(active);
    const hasLegacy = !samePath(active, legacy) && existsSync(legacy);
    if (!expect) {
      if (hasActive) return { path: active, source: "active" };
      return { path: legacy, source: hasLegacy ? "legacy" : "missing" };
    }
    const ok = (p: string) => hashOf(p) === expect.sha256;
    if (hasActive && ok(active)) return { path: active, source: "active" };
    if (hasLegacy && ok(legacy)) {
      return {
        path: legacy,
        source: "legacy",
        warning: hasActive
          ? `${file}: the copy under ${this.root} does not match the generation manifest; read the recorded copy at ${dir} instead`
          : `${file}: read from the recorded location ${dir}, which is outside the active root ${this.root}`,
      };
    }
    if (!hasActive && !hasLegacy) return { path: active, source: "missing" };
    const tried = [hasActive ? active : null, hasLegacy ? legacy : null].filter(Boolean).join(" and ");
    return {
      path: hasActive ? active : legacy,
      source: hasActive ? "active" : "legacy",
      mismatch: `${file}: neither copy matches the generation manifest (${tried})`,
    };
  }
}

function hashOf(p: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}
