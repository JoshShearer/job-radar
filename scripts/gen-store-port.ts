/**
 * Regenerate src/ports/store.ts from the SQLite store's declarations, so the
 * port and its implementation cannot drift:   npm run gen:port
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(tmpdir(), "jr-dts-"));
execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", root, "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--outDir", out], {
  stdio: "inherit",
});
const d = readFileSync(join(out, "src/adapters/sqlite/store.d.ts"), "utf8");
const marker = "export declare class SqliteStore implements Store {";
const body = d
  .slice(d.indexOf(marker) + marker.length, d.lastIndexOf("}"))
  .replace("    readonly db: DB;\n", "")
  .replace("    constructor(db: DB);\n", "");
const imports = d
  .split("\n")
  .filter((l) => l.startsWith("import type") && !l.includes("ports/store") && !l.includes("./db.js"))
  .map((l) => l.replace("../../ports/records.js", "./records.js").replace("../../domain/", "../domain/").replace("../../kernel/", "../kernel/"));
const header = `/**
 * The persistence port. The application layer depends on this interface
 * only; \`adapters/sqlite/store.ts\` implements it.
 *
 * GENERATED from the implementation's declarations by \`npm run gen:port\`, so
 * the two cannot drift; \`implements Store\` makes the compiler hold them
 * together. Edit the implementation, then regenerate.
 */
`;
writeFileSync(resolve(root, "src/ports/store.ts"), `${header}${imports.join("\n")}\n\nexport interface Store {${body}}\n`);
console.log("regenerated src/ports/store.ts");
