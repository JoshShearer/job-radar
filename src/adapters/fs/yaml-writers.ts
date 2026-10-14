import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument, stringify, YAMLSeq } from "yaml";
import type { Evidence } from "../../domain/candidate/evidence.js";

/** Write atomically: a crash never leaves a half-written config file. */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

function backupName(file: string, at: string): string {
  return `${file}.${at.replace(/[:.]/g, "-").slice(0, 19)}.bak`;
}

export function saveEvidence(file: string, e: Evidence, at: string): string | null {
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = backupName(file, at);
    copyFileSync(file, backup);
  }
  writeFileAtomic(file, stringify(e, { lineWidth: 0 }));
  return backup;
}

/**
 * Append learned answers to personal.yaml through the YAML document, so the
 * candidate's comments and formatting survive. The original is copied aside
 * first: it is a statement of fact and software is never its only copy.
 */
export function appendAnswers(file: string, entries: ReadonlyArray<{ match: string; answer: string }>, at: string): string | null {
  if (!entries.length) return null;
  const original = readFileSync(file, "utf8");
  const backup = backupName(file, at);
  copyFileSync(file, backup);
  const doc = parseDocument(original);
  let list = doc.get("answers");
  if (!(list instanceof YAMLSeq)) {
    list = new YAMLSeq();
    doc.set("answers", list);
  }
  for (const e of entries) (list as YAMLSeq).add(doc.createNode({ match: e.match, answer: e.answer }));
  writeFileAtomic(file, doc.toString({ lineWidth: 0 }));
  return backup;
}
