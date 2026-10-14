import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, type YAMLMap } from "yaml";
import { boardKey, configuredBoardKeys, type BoardEntry } from "../../domain/config/sources.js";
import type { SourcesWriter } from "../../ports/io.js";
import { CONFIG_FILES, ConfigError, loadConfig } from "./config-loader.js";
import { writeFileAtomic } from "./yaml-writers.js";

/**
 * Appends boards to `sources.<ats>.boards` in sources.yaml without
 * re-serializing the file. The YAML document locates the list's last entry;
 * the new entry is spliced into the original text on the line after it, in
 * the same style (flow `{ token, company }` or block), indentation and line
 * ending. A round-trip through a YAML serializer would reflow comments and
 * spacing, so every other byte of the file is left exactly as written.
 *
 * Before the atomic write, the edited text must (1) parse to the original
 * data plus exactly the new entries, and (2) load through the full config
 * loader, schema and cross-file coherence. Any failure throws and nothing is
 * written.
 */
export class FsSourcesWriter implements SourcesWriter {
  readonly file: string;

  constructor(private readonly configDir: string) {
    this.file = resolve(configDir, CONFIG_FILES.sources);
  }

  addBoards(entries: readonly BoardEntry[]): { added: BoardEntry[]; file: string } {
    const original = readFileSync(this.file, "utf8");
    const have = configuredBoardKeys(loadConfig(this.configDir, { sources: original }).sources);
    const added: BoardEntry[] = [];
    let text = original;
    for (const e of entries) {
      const key = boardKey(e.ats, e.token);
      if (have.has(key)) continue;
      have.add(key);
      text = insertBoard(text, e);
      added.push(e);
    }
    if (!added.length) return { added, file: this.file };

    const expected = parseYaml(original) as { sources: Record<string, { boards: unknown[] }> };
    for (const e of added) expected.sources[e.ats]!.boards.push({ token: e.token, company: e.company });
    const refuse = (why: string) =>
      new ConfigError(`Inserting into ${this.file} would change more than the new boards (${why}); not written. Add them by hand.`);
    let edited: unknown;
    try {
      edited = parseYaml(text);
    } catch (err) {
      throw refuse(`the edited text does not parse: ${(err as Error).message.split("\n")[0]}`);
    }
    if (!isDeepStrictEqual(edited, expected)) throw refuse("the edited text parses to different data");
    try {
      loadConfig(this.configDir, { sources: text });
    } catch (err) {
      throw new ConfigError(`The edited sources.yaml would not load, so it was not written:\n${(err as Error).message}`);
    }
    writeFileAtomic(this.file, text);
    return { added, file: this.file };
  }
}

/** Splice one board in after the last entry of `sources.<ats>.boards`. */
function insertBoard(text: string, e: BoardEntry): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`sources.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  const list = doc.getIn(["sources", e.ats, "boards"], true);
  const last = isSeq(list) && !list.flow ? list.items.at(-1) : undefined;
  if (!isSeq(list) || !last || !(last as { range?: unknown }).range) {
    throw new ConfigError(`sources.${e.ats}.boards has no existing entry to add after; add ${e.ats}:${e.token} by hand.`);
  }
  const [start, valueEnd] = (last as YAMLMap).range!;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ ]*/.exec(text.slice(lineStart))![0];
  // Keep the file's own line ending: a CRLF file gets CRLF lines.
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  let end = valueEnd;
  if (end > 0 && text[end - 1] === "\n") end--;
  if (end > 0 && text[end - 1] === "\r") end--;
  const eol = text.indexOf("\n", end);
  let at = eol === -1 ? text.length : eol;
  if (at > 0 && text[at - 1] === "\r") at--;

  const flow = isMap(last) && last.flow === true;
  const node = new Document({ token: e.token, company: e.company });
  if (isMap(node.contents)) node.contents.flow = flow;
  const body = node.toString({ lineWidth: 0 }).trimEnd().split("\n");
  const lines = body.map((l, i) => (i === 0 ? `${indent}- ${l}` : `${indent}  ${l}`));
  return `${text.slice(0, at)}${nl}${lines.join(nl)}${text.slice(at)}`;
}
