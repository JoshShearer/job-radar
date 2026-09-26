#!/usr/bin/env node
/**
 * Minimal Linear MCP client for automation (used by /run-tickets and friends).
 *
 * Talks directly to https://mcp.linear.app/mcp over HTTP using the OAuth
 * token Claude Code already cached in ~/.claude/.credentials.json, refreshing
 * it via the documented OAuth refresh-grant endpoint when it's expired.
 *
 * This exists so automation does not depend on whether the *current*
 * session's tool list happens to include a Linear MCP tool — that binding is
 * per-client (Claude Code vs. opencode vs. a spawned subagent) and has been
 * observed to be absent even when Linear is authenticated. This script is
 * the fallback that always works: it speaks the MCP HTTP protocol itself.
 *
 * PROJECT-AGNOSTIC BY DESIGN: this script is meant to be copied into any
 * project alongside `/run-tickets`. It does not hardcode which Linear
 * workspace or OAuth key applies — different projects in this portfolio use
 * different Linear teams under different MCP server names (e.g. `linear-vl`
 * for venture-lab, `linear-jr` for job-radar, `linear-loopstring` for
 * LoopStringRoot, plain `linear` for others). On every run it auto-discovers
 * the right key by reading the *current* project's own `.mcp.json` (Claude
 * Code) or `opencode.json`/`opencode.jsonc` (opencode) — walking up from cwd
 * to the nearest git root, same as those tools do — and picking whichever
 * configured MCP server's `url` points at `mcp.linear.app`. Override with
 * `LINEAR_MCP_SERVER_KEY` if a project has more than one such entry (not
 * observed so far) or none at all.
 *
 * Requires: that discovered (or overridden) OAuth entry to already exist in
 * ~/.claude/.credentials.json — i.e. Linear has been authenticated at least
 * once via Claude Code, for this project's server name, before this script
 * is used. If the project has no Linear MCP entry at all (e.g. it tracks
 * work in GitHub Issues instead), this script does not apply — see
 * `run-tickets.md`'s Tracker Compatibility note.
 *
 * KNOWN HAZARD — cross-project credential collision: OAuth tokens are cached
 * by server *name*, not by project. Two different projects that both name
 * their Linear server the same generic thing (plain `"linear"` has been
 * observed doing this twice in one portfolio) silently share one cached
 * token — whichever project authenticated it last wins for all of them, with
 * no error. Directly observed: a project documenting team `BASEMyHome`
 * resolved to an unrelated team (`Valqor-crm`) with this exact script.
 * Before trusting output for anything write-related, cross-check
 * `node scripts/linear-mcp.mjs call list_teams '{}'` against the project's
 * own documented team in `.claude/commands/create-issue.md`. If they don't
 * match, the fix is at the source: give the project's Linear server a unique
 * name in `.mcp.json`/`opencode.json` and re-authenticate it — not this
 * script.
 *
 * Usage:
 *   node scripts/linear-mcp.mjs call <toolName> '<jsonArgs>'
 *   node scripts/linear-mcp.mjs call <toolName> @path/to/args.json
 *   node scripts/linear-mcp.mjs get-issue VEN-45
 *   node scripts/linear-mcp.mjs list-issues '{"query":"..."}'
 *   node scripts/linear-mcp.mjs save-issue '{"id":"VEN-45","state":"Done"}'
 *   node scripts/linear-mcp.mjs comment VEN-45 path/to/body.md
 *
 * Prints the tool's parsed JSON result to stdout. Non-zero exit + message on
 * stderr on any failure (no Linear MCP config found, missing credentials,
 * expired refresh token, MCP tool error, etc.) — never fails silently.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const MCP_URL = "https://mcp.linear.app/mcp";

/**
 * Walk up from cwd looking for `.mcp.json` and `opencode.json[c]`. Stops at
 * the git root (inclusive) or the filesystem root, whichever comes first —
 * mirrors how opencode itself resolves project config.
 */
function findConfigFiles() {
  const found = [];
  let dir = process.cwd();
  for (;;) {
    for (const name of [".mcp.json", "opencode.json", "opencode.jsonc"]) {
      const p = join(dir, name);
      if (existsSync(p)) found.push(p);
    }
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/**
 * Strip `//` and `/* *\/` comments from JSONC, respecting string literals
 * and escape sequences — unlike a naive regex, this does not truncate a
 * value like `"url": "https://mcp.linear.app/mcp"` at the `//` inside it.
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        // Preserve the escaped character verbatim so a trailing backslash
        // before a quote doesn't fool the string-end check below.
        out += next ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Extract { key, url } entries from a Claude Code `.mcp.json` (`mcpServers`)
 * or an opencode `opencode.json[c]` (`mcp`) — both are objects keyed by
 * server name, each value carrying a `url` for remote/http servers. */
function extractMcpEntries(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const stripped = filePath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
  const parsed = JSON.parse(stripped);
  const bag = parsed.mcpServers ?? parsed.mcp ?? {};
  return Object.entries(bag)
    .filter(([, v]) => typeof v?.url === "string")
    .map(([key, v]) => ({ key, url: v.url, source: filePath }));
}

function discoverServerKey() {
  if (process.env.LINEAR_MCP_SERVER_KEY) return process.env.LINEAR_MCP_SERVER_KEY;

  const configFiles = findConfigFiles();
  const candidates = configFiles.flatMap(extractMcpEntries).filter((e) => e.url.includes("mcp.linear.app"));

  const uniqueKeys = [...new Set(candidates.map((c) => c.key))];
  if (uniqueKeys.length === 1) return uniqueKeys[0];

  if (uniqueKeys.length === 0) {
    throw new Error(
      `No Linear MCP server found in .mcp.json/opencode.json for ${process.cwd()} ` +
        `(checked: ${configFiles.length ? configFiles.join(", ") : "no config files found"}). ` +
        `This project may track work somewhere other than Linear (e.g. GitHub Issues — check ` +
        `.claude/commands/create-issue.md), or the entry uses a name this script can't infer. ` +
        `Set LINEAR_MCP_SERVER_KEY explicitly to override.`,
    );
  }

  throw new Error(
    `Multiple Linear MCP servers found (${uniqueKeys.join(", ")}) across ${configFiles.join(", ")}. ` +
      `Set LINEAR_MCP_SERVER_KEY to disambiguate.`,
  );
}

function loadCreds() {
  return JSON.parse(readFileSync(CREDS_PATH, "utf8"));
}

function saveCreds(creds) {
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
}

function findEntryKey(creds, serverKey) {
  // mcpOAuth is keyed like "linear-vl|638130d5ab3558f4" — the discovered
  // server name is a prefix, not the full key.
  const key = Object.keys(creds.mcpOAuth ?? {}).find((k) => k.startsWith(`${serverKey}|`) || k === serverKey);
  if (!key) {
    throw new Error(
      `Found Linear MCP server "${serverKey}" in this project's config, but no cached OAuth ` +
        `entry for it in ${CREDS_PATH}. Authenticate Linear once via Claude Code for this ` +
        `project first (or set LINEAR_MCP_SERVER_KEY to an already-authenticated server name).`,
    );
  }
  return key;
}

async function refreshToken(creds, key) {
  const entry = creds.mcpOAuth[key];
  const discovery = await fetch(`${new URL(entry.serverUrl).origin}/.well-known/oauth-authorization-server`).then(
    (r) => r.json(),
  );
  const resp = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Linear token refresh failed (${resp.status}): ${JSON.stringify(data)}. ` +
        `The cached refresh token may be dead — re-authenticate Linear via Claude Code.`,
    );
  }
  entry.accessToken = data.access_token;
  entry.refreshToken = data.refresh_token ?? entry.refreshToken;
  entry.expiresAt = Date.now() + data.expires_in * 1000;
  entry.scope = data.scope ?? entry.scope;
  saveCreds(creds);
  return entry.accessToken;
}

async function getAccessToken() {
  const serverKey = discoverServerKey();
  const creds = loadCreds();
  const key = findEntryKey(creds, serverKey);
  const entry = creds.mcpOAuth[key];
  const skewMs = 60_000;
  if (!entry.expiresAt || entry.expiresAt - skewMs < Date.now()) {
    return refreshToken(creds, key);
  }
  return entry.accessToken;
}

async function callTool(name, args) {
  const token = await getAccessToken();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine ? dataLine.slice("data: ".length) : raw);
  if (payload.error) {
    throw new Error(`Linear MCP error calling ${name}: ${JSON.stringify(payload.error)}`);
  }
  const content = payload.result?.content?.[0];
  if (content?.text) {
    try {
      return JSON.parse(content.text);
    } catch {
      return content.text;
    }
  }
  return payload.result;
}

function parseArgs(raw) {
  if (raw === undefined) return {};
  if (raw.startsWith("@")) return JSON.parse(readFileSync(raw.slice(1), "utf8"));
  return JSON.parse(raw);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let result;
  switch (cmd) {
    case "call": {
      const [tool, argsRaw] = rest;
      if (!tool) throw new Error("Usage: linear-mcp.mjs call <toolName> [jsonArgs|@file]");
      result = await callTool(tool, parseArgs(argsRaw));
      break;
    }
    case "get-issue": {
      const [id] = rest;
      if (!id) throw new Error("Usage: linear-mcp.mjs get-issue <VEN-XX>");
      result = await callTool("get_issue", { id });
      break;
    }
    case "list-issues": {
      const [argsRaw] = rest;
      result = await callTool("list_issues", parseArgs(argsRaw));
      break;
    }
    case "save-issue": {
      const [argsRaw] = rest;
      result = await callTool("save_issue", parseArgs(argsRaw));
      break;
    }
    case "comment": {
      const [issueId, bodyPath] = rest;
      if (!issueId || !bodyPath) throw new Error("Usage: linear-mcp.mjs comment <VEN-XX> <bodyFile>");
      const body = readFileSync(bodyPath, "utf8");
      result = await callTool("save_comment", { issueId, body });
      break;
    }
    default:
      console.error(
        "Usage: node scripts/linear-mcp.mjs <call <tool> <json>|get-issue <id>|list-issues <json>|save-issue <json>|comment <id> <bodyFile>>",
      );
      process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
