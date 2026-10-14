import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactStore } from "../../ports/io.js";

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

  path(dir: string, file: string): string {
    return join(dir, file);
  }

  read(dir: string, file: string): string | null {
    const p = join(dir, file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}
