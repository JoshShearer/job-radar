#!/usr/bin/env node
/**
 * The mechanical half of `/run-tickets` (.claude/commands/run-tickets.md).
 *
 * Start, Ship, Merge and Finish make no judgement calls - name a branch, run the gates, push, read
 * the push back, open a PR, check the merge preconditions, delete a branch - so they are
 * deterministic steps the orchestrator runs with one Bash call each, not agents that pay for the
 * instruction files on every tool call and can improvise.
 *
 * Linear is reachable only through the `linear-jr` MCP server, which a script cannot call. Every
 * tracker read and write therefore stays with the orchestrator; this script records what the
 * orchestrator reports (`trackerWritesAdd`) and says which pipeline decisions still need posting
 * (`toPost`). It reads no tracker or MCP configuration from the lane. Git, gh and the state file
 * are all here.
 *
 * This script is the ONLY writer of ticket entries in the run's state file. Agents return one JSON
 * object; the orchestrator pipes it into `record --phase <phase>`, which:
 *   - validates the shape (types, enums, the phase's results) before applying anything;
 *   - keeps only the fields that phase may set (FIELDS_BY_PHASE) and reports what it dropped;
 *   - refuses a verdict that names any commit but the current `commitSha`;
 *   - refuses a critic or Verify return that changed the lane, the primary, or the remote branch;
 *   - moves `phase`/`status` by the routing table (NEXT), so a resume continues where the run was.
 * A verdict describes one commit: whenever `commitSha` changes, every verdict is cleared.
 *
 * The lane-safety checks (`safetyProblems`) run inside record, ship, merge and finish as well as in
 * `guard`, so an orchestrator that forgets `guard` still cannot carry on in an unsafe lane.
 *
 * The orchestrator runs a FROZEN copy of this file, taken from origin/<base> at Step 0c before any
 * ticket branch is checked out: a ticket that edits this file must not change the gate that
 * merges it.
 *
 * Run from the lane (every command refuses any other working directory):
 *   node <ops>/ticket-ops.mjs --state <file> <cmd> [<KEY>] [...]
 *
 *   gate-files                      print the gate-defining paths (no state needed)
 *   guard [--init]                  lane safety: generate (--init) or re-check the lane .env, the
 *                                   launching environment, servers left running, the owner's units
 *   add <KEY>                       register a pending ticket (idempotent)
 *   show <KEY> [field,...]          print the ticket entry (or a subset) - what agents read
 *   snapshot <KEY>                  before a critic or Verify: what "wrote nothing" is checked against
 *   record <KEY> --phase <p>        merge a JSON return (stdin) - see above
 *   pr-append <KEY> <textFile>      append text to the PR body and read it back
 *   start <KEY> --run-branch <b>    branch off the run branch; stdin is the issue as the
 *                                   orchestrator read it from Linear: {title, type, description, url}
 *   ship <KEY>                      gates unless HEAD == gatedSha, secret scan, key probe, leased
 *                                   push, read back, PR adopt/create or Round-line append
 *   risk <KEY>                      critic depth for origin/<base>...commitSha (L1 | L2 | L2+Double)
 *   merge <KEY>                     preflight; prints the `gh pr merge` the ORCHESTRATOR must run
 *   merged <KEY>                    read the merge back; prints the remote-branch delete to run
 *   finish <KEY> --run-branch <b>   resync the lane, delete the local branch by head equality
 *
 * Output: one JSON line. Exit codes: 0 ok, 1 usage or malformed input (nothing written; for
 * `record`: re-run the agent once), 2 infrastructure or safety error (stop the run), 3 blocked
 * (status and blockedReason are set), 4 fail (route to Fix; verifyFindings is set).
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXIT = { ok: 0, usage: 1, error: 2, blocked: 3, fail: 4 };
/** Everything that describes one commit. A new commitSha clears all of it. */
const VERDICT_FIELDS = [
  "criticVerdict",
  "criticSha",
  "verifyVerdict",
  "verifiedSha",
  "verifiedBaseSha",
  "gateJustifications",
  "risk",
  "snapshot",
];
const STATUSES = ["pending", "in_progress", "blocked", "done"];
const PHASES = ["start", "build", "ship", "critic", "verify", "fix", "merge", "finish"];

/**
 * The lane's .env is GENERATED from this allowlist, never linked. The primary's .env (and the
 * timer's ~/.config/job-radar/env) hold a live ANTHROPIC_API_KEY - the only thing in this repo that
 * spends money - and the JOB_RADAR_* path overrides can point the lane at the owner's real
 * database, resume or personal answers. Anything not listed here is dropped, whatever it is called.
 */
const LANE_ENV_ALLOW = ["JOB_RADAR_MODEL", "JOB_RADAR_EFFORT", "JOB_RADAR_CONTACT", "JOB_RADAR_DEBUG"];
/** Exported in the launching shell, these beat the lane .env (loadEnvFile never overrides). */
const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "JOB_RADAR_DB",
  "JOB_RADAR_PERSONAL",
  "JOB_RADAR_RESUME",
  "JOB_RADAR_REPORTS",
  "JOB_RADAR_PROFILE",
  "JOB_RADAR_SOURCES",
  "JOB_RADAR_GMAIL_CLIENT_ID",
  "JOB_RADAR_GMAIL_CLIENT_SECRET",
  "JOB_RADAR_GMAIL_REFRESH_TOKEN",
];
/**
 * The owner's personal material: real contact and work-authorization answers, real employment
 * history, and the logged-in browser profile `autofill` uses. Gitignored, so a fresh lane has none,
 * and a lane never needs one (a repro points JOB_RADAR_PERSONAL / JOB_RADAR_RESUME at an example
 * or fixture file inside the lane, per command). One appearing is a copy of the owner's data.
 */
const PERSONAL_PATHS = ["config/personal.yaml", "config/resume.yaml", ".browser-profile"];
/** A key-shaped Anthropic value (the `.env.example` placeholder `sk-ant-...` is not one). */
const KEY_VALUE_RE = /sk-ant-[A-Za-z0-9_-]{16,}/;

/** What each phase's return may set. Anything else is dropped and reported. */
const COMMON = ["handoff", "blockedReason", "clarificationAdd"];
const FIELDS_BY_PHASE = {
  triage: ["type", "status", "noTracker", ...COMMON],
  build: ["planNote", "reproduction", "reproConfirmed", "implementationSummary", "gatedSha", "prTitle", "prBody", ...COMMON],
  fix: ["gatedSha", "verifyFindings", "implementationSummary", "roundNote", "branch", "prNumber", ...COMMON],
  critic: ["criticVerdict", "criticSha", "verifyFindings", "criticNotes", "gateJustifications", "blockedReason"],
  verify: ["verifyVerdict", "verifiedSha", "verifyNotes", "verifyFindings", ...COMMON],
  orchestrator: ["fixRound", "status", "blockedReason", "noTracker", "phase", "handoff", "trackerWritesAdd", "postedAdd"],
};
/** Routing for agent results: phase -> result -> next phase. `handoff` stays in the same phase. */
const NEXT = {
  build: { done: "ship" },
  fix: { done: "ship" },
  critic: { pass: "verify", concerns: "verify", block: "fix" },
  verify: { pass: "merge", fail: "fix" },
};
/** Paths whose change needs the owner before merge (CLAUDE.md: a live autofill run ships them). */
const OWNER_GATED = /^src\/apply\//;
/**
 * Files that DEFINE the gates, or what the critic grades against. Freezing this script does not
 * freeze what `npm test` and `npm run typecheck` do: a ticket could weaken the test config, the
 * typecheck script, the toolchain versions, the env loader that decides which credentials load, or
 * the critic's checklist, and then pass through its own weakened gate. Such a diff gets the deepest
 * critic, every critic must justify it, and Ship never takes the "gates already ran" shortcut.
 * tests/run-tickets.ops.test.ts derives the gates' config closure and checks this list covers it.
 */
const GATE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "vitest.config.ts",
  "src/config/env.ts",
  "src/config/load.ts",
  "CLAUDE.md",
  ".claude/commands/critique.md",
  ".claude/commands/check-constraints.md",
];
const isGateFile = (f) =>
  GATE_FILES.includes(f) ||
  /(^|\/)tsconfig[^/]*\.json$/.test(f) ||
  /(^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(f) ||
  /(^|\/)\.npmrc$/.test(f);
/** Linear team JOB. Keys reach branch names and shell commands, so nothing else is accepted. */
const KEY_RE = /^JOB-[1-9][0-9]*$/;
/** Results each phase may return. Anything else is malformed: re-run the agent, write nothing. */
const RESULTS = {
  triage: [undefined, "done", "blocked"],
  build: ["done", "handoff", "blocked"],
  fix: ["done", "handoff", "blocked"],
  critic: ["pass", "concerns", "block", "blocked"],
  verify: ["pass", "fail", "handoff", "blocked"],
  orchestrator: [undefined],
};
/** Field types, checked before anything is applied. */
const STRING_FIELDS = new Set([
  "type", "blockedReason", "handoff", "planNote", "reproduction", "implementationSummary", "gatedSha",
  "prTitle", "prBody", "verifyFindings", "roundNote", "branch", "criticSha", "criticNotes",
  "verifiedSha", "verifyNotes",
]);
const ENUM_FIELDS = {
  status: STATUSES,
  phase: PHASES,
  criticVerdict: ["pass", "concerns", "block"],
  verifyVerdict: ["pass", "fail"],
};
const BOOLEAN_FIELDS = new Set(["reproConfirmed", "noTracker"]);
const NUMBER_FIELDS = new Set(["fixRound", "prNumber"]);
const ARRAY_FIELDS = new Set(["clarificationAdd", "trackerWritesAdd", "postedAdd", "gateJustifications"]);

class Stop extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------- argv

// Options are pulled out first: `$OPS` puts `--state <file>` BEFORE the subcommand.
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};
const STATE = opt("state");
const PHASE = opt("phase");
const RUN_BRANCH = opt("run-branch");
const INIT = flag("init");
const [cmd, KEY, ...REST] = argv;

// ---------------------------------------------------------------------------- shell helpers

/** Run and return trimmed stdout; throws on a non-zero exit. */
function sh(bin, args, { input } = {}) {
  return execFileSync(bin, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
/** Run without throwing. `out` is stdout+stderr capped for reporting; `stdout` is kept apart. */
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, stdout: r.stdout ?? "", out: out.length > 4000 ? `...${out.slice(-4000)}` : out };
}
const git = (...a) => sh("git", a);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const pause = (s) => spawnSync("sleep", [String(s)]);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------- state file

function loadState() {
  if (!STATE) throw new Stop("usage", "--state <file> is required");
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
/** Atomic replace: a crash mid-write must not leave a truncated state file. */
function saveState(state) {
  const tmp = `${STATE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, STATE);
}
function ticketOf(state, key) {
  const t = state.tickets.find((x) => x.id === key);
  if (!t) throw new Stop("usage", `${key} is not in ${STATE}`);
  return t;
}
/** Apply fields to a ticket. A new commitSha invalidates everything describing the old one. */
function apply(t, fields, phase, result) {
  const shaChanged = "commitSha" in fields && fields.commitSha !== t.commitSha;
  Object.assign(t, fields);
  if (shaChanged) for (const f of VERDICT_FIELDS) if (!(f in fields)) t[f] = null;
  t.history ??= [];
  t.history.push({ phase: phase ?? t.phase, at: now(), result: result ?? "recorded" });
}
/**
 * Saves even when fn throws, so what happened before a block is still on record - except on a
 * usage refusal (a malformed or misdirected return), which must write nothing at all.
 */
function mutate(key, fn) {
  const state = loadState();
  const t = ticketOf(state, key);
  let refused = false;
  try {
    return fn(t, state);
  } catch (e) {
    refused = e instanceof Stop && e.kind === "usage";
    throw e;
  } finally {
    if (!refused) {
      state.heartbeat = now();
      saveState(state);
    }
  }
}
/** A mechanical step runs only on a ticket at its own phase, never on a finished one. */
function requirePhase(t, phase) {
  if (t.status === "done") throw new Stop("usage", `${t.id} is done`);
  if (t.phase !== phase) throw new Stop("usage", `${t.id} is at phase ${t.phase}, not ${phase}`);
}
/** Pipeline decisions not yet on the Linear ticket. Never for a ticket the run does not own. */
const unposted = (t) =>
  t.noTracker ? [] : (t.clarification ?? []).filter((c) => c.decidedBy === "pipeline" && !c.posted);

/** Every problem with a return's shape. Nothing is applied unless this is empty. */
function shapeProblems(phase, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["return is not a JSON object"];
  const problems = [];
  if (!RESULTS[phase].includes(input.result))
    problems.push(`result ${JSON.stringify(input.result)} is not a ${phase} result`);
  if ("note" in input && typeof input.note !== "string") problems.push("note is not a string");
  for (const [k, v] of Object.entries(input)) {
    if (k === "result" || k === "note") continue;
    if (STRING_FIELDS.has(k) && v !== null && typeof v !== "string") problems.push(`${k} is not a string`);
    if (ENUM_FIELDS[k] && !ENUM_FIELDS[k].includes(v))
      problems.push(`${k} ${JSON.stringify(v)} is not one of ${ENUM_FIELDS[k]}`);
    if (BOOLEAN_FIELDS.has(k) && typeof v !== "boolean") problems.push(`${k} is not a boolean`);
    if (NUMBER_FIELDS.has(k) && v !== null && !Number.isInteger(v)) problems.push(`${k} is not an integer`);
    if (ARRAY_FIELDS.has(k) && !Array.isArray(v)) problems.push(`${k} is not an array`);
  }
  for (const c of Array.isArray(input.clarificationAdd) ? input.clarificationAdd : [])
    if (!c || typeof c.question !== "string" || typeof c.answer !== "string")
      problems.push("clarificationAdd entries need string question and answer");
  for (const w of Array.isArray(input.trackerWritesAdd) ? input.trackerWritesAdd : [])
    if (!w || typeof w.op !== "string" || typeof w.ok !== "boolean")
      problems.push("trackerWritesAdd entries need a string op and a boolean ok");
  for (const q of Array.isArray(input.postedAdd) ? input.postedAdd : [])
    if (typeof q !== "string") problems.push("postedAdd entries are question strings");
  for (const j of Array.isArray(input.gateJustifications) ? input.gateJustifications : [])
    if (typeof j !== "string" || !j.trim()) problems.push("gateJustifications entries are non-empty strings");
  return problems;
}

// ---------------------------------------------------------------------------- git/gh helpers

const baseOf = (state) => {
  if (!state.baseBranch) throw new Stop("error", "state file has no baseBranch");
  return state.baseBranch;
};
/**
 * Every path the diff touches. `--no-renames`: with rename detection a moved file lists only its
 * NEW path, so moving a gate config out of its watched name would read as "no gate change". Both
 * sides of a rename, and deletions, are listed.
 */
const diffFiles = (base, to = "HEAD") =>
  git("diff", "--no-renames", "--name-only", `origin/${base}...${to}`).split("\n").filter(Boolean);
const remoteHead = (branch) => {
  const line = git("ls-remote", "origin", `refs/heads/${branch}`);
  return line ? line.split(/\s+/)[0] : null;
};
const prView = (pr, fields) => JSON.parse(sh("gh", ["pr", "view", String(pr), "--json", fields]));
function appendToPrBody(pr, text) {
  const body = prView(pr, "body").body;
  if (body.includes(text)) return true;
  sh("gh", ["pr", "edit", String(pr), "--body-file", "-"], { input: `${body}\n\n${text}\n` });
  return prView(pr, "body").body.includes(text);
}
/**
 * The owner's gitignored material in the primary - invisible to `git status` - by path, size and
 * mtime: the paid key, the personal answers and resume, the logged-in browser profile, the real
 * database, and the timer's env directory.
 */
const PRIMARY_PRIVATE = [".env", "config/personal.yaml", "config/resume.yaml", ".browser-profile", "data/job-radar.sqlite"];
function privateFingerprint(state) {
  const paths = PRIMARY_PRIVATE.map((p) => path.join(state.primary, p));
  const envDir = path.join(configHome(), "job-radar");
  paths.push(envDir);
  if (fs.existsSync(envDir)) for (const n of fs.readdirSync(envDir).sort()) paths.push(path.join(envDir, n));
  return sha256(
    paths
      .map((f) => {
        try {
          const st = fs.lstatSync(f);
          return `${f}\0${st.size}\0${st.mtimeMs}`;
        } catch {
          return `${f}\0absent`;
        }
      })
      .join("\n"),
  );
}
/** What an agent could have changed outside the lane: the primary (tracked and ignored) and origin. */
const primaryStatus = (state) =>
  sha256(run("git", ["-C", state.primary, "status", "--porcelain=v1"]).stdout + privateFingerprint(state));
/**
 * A critic or Verify may write nothing: the lane is on the ticket branch at the pushed commit and
 * clean, the remote branch is still that commit, and the primary's status is what it was when the
 * agent was spawned. `git status` in the lane alone cannot see a push or a write in the primary.
 */
function agentWroteSomething(t, state) {
  const problems = [];
  if (git("status", "--short")) problems.push("uncommitted or untracked files in the lane");
  if (git("branch", "--show-current") !== t.branch) problems.push(`lane not on ${t.branch}`);
  if (git("rev-parse", "HEAD") !== t.commitSha) problems.push(`lane HEAD is not ${t.commitSha}`);
  if (remoteHead(t.branch) !== t.commitSha) problems.push(`origin/${t.branch} is not ${t.commitSha}`);
  if (remoteHead(baseOf(state)) !== t.snapshot?.baseRemote)
    problems.push(`origin/${baseOf(state)} moved (an agent pushed to it, or another run merged)`);
  if (primaryStatus(state) !== t.snapshot?.primaryStatus)
    problems.push("the primary checkout changed, ignored files included (an agent wrote there, or the owner is editing)");
  return problems;
}

/**
 * The repo's gates, from CLAUDE.md: `npm test` (which launches a real Chromium and fails loudly
 * without one) and `npm run typecheck`. There is no lint, format or build script to run.
 */
function runGates() {
  for (const args of [["test"], ["run", "typecheck"]]) {
    const r = run("npm", args);
    if (r.code !== 0) return { ok: false, gate: `npm ${args.join(" ")}`, output: r.out };
  }
  return { ok: true };
}
/**
 * Whether the CLI, as this commit builds it, can see a paid key from the lane. The env loader is
 * app code a ticket can change (to read the timer's env file, say); the generated lane .env being
 * clean proves nothing about that. Runs the commit's own loadEnvFile with forbidden vars removed.
 */
function keyProbe() {
  if (!fs.existsSync("src/config/env.ts")) return { visible: false, ran: false };
  const env = { ...process.env };
  for (const k of FORBIDDEN_ENV) delete env[k];
  const r = run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const m = await import('./src/config/env.ts'); m.loadEnvFile(); console.log(process.env.ANTHROPIC_API_KEY ? 'PAID KEY VISIBLE' : 'no paid key')",
    ],
    { env },
  );
  return { visible: r.stdout.includes("PAID KEY VISIBLE"), ran: true, code: r.code, out: r.out };
}

/**
 * What every commit on the branch adds. Hard blocks: a key-shaped Anthropic value anywhere, any
 * `.env*` file but `.env.example`, the primary's absolute path, and code (not docs, not deploy/)
 * that names the timer's key file. Ordinary code - `process.env.ANTHROPIC_API_KEY`, a short test
 * placeholder like `sk-ant-test` - passes.
 */
function secretLeaks(base, state) {
  const leaks = new Set();
  const log = git("log", "--no-renames", "-p", "--format=COMMIT %H", `origin/${base}..HEAD`);
  let file = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      if (file !== "/dev/null" && /(^|\/)\.env(\..*)?$/.test(file) && !file.endsWith(".env.example"))
        leaks.add(`an env file (${file})`);
      continue;
    }
    if (!line.startsWith("+")) continue;
    if (KEY_VALUE_RE.test(line)) leaks.add(`an Anthropic key value (${file})`);
    if (state.primary && line.includes(state.primary)) leaks.add(`the primary path ${state.primary} (${file})`);
    if (/^(src|tests|scripts)\//.test(file ?? "") && line.includes(".config/job-radar"))
      leaks.add(`code naming ~/.config/job-radar, the timer's key file (${file})`);
  }
  return [...leaks];
}

// ---------------------------------------------------------------------------- lane safety

const configHome = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
/**
 * Every entry under `dir` (to depth 3) whose relative path names job-radar: unit files, drop-in
 * directories (`job-radar-daily.service.d/`) and `timers.target.wants/` links alike.
 */
function walkJobRadar(dir, rel = "", depth = 0, out = []) {
  if (!fs.existsSync(dir) || depth > 3) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const r = path.join(rel, name);
    const st = fs.lstatSync(full);
    if (r.includes("job-radar")) out.push([full, st]);
    if (st.isDirectory()) walkJobRadar(full, r, depth + 1, out);
  }
  return out;
}
/**
 * Fingerprint of what `deploy/install-timer.sh` writes: the owner's user units, if installed (on
 * the machine this was written on there were none), and ~/.config/job-radar/. Run from a lane,
 * that script would repoint the owner's daily timer at a directory Step 8 deletes.
 */
function unitsFingerprint() {
  const h = createHash("sha256");
  const entries = walkJobRadar(path.join(configHome(), "systemd", "user"));
  const envDir = path.join(configHome(), "job-radar");
  if (fs.existsSync(envDir))
    for (const n of fs.readdirSync(envDir).sort()) entries.push([path.join(envDir, n), fs.lstatSync(path.join(envDir, n))]);
  for (const [f, st] of entries) {
    h.update(`${f}\0`);
    if (st.isSymbolicLink()) h.update(`-> ${fs.readlinkSync(f)}`);
    else if (st.isFile()) {
      try {
        h.update(fs.readFileSync(f));
      } catch {
        h.update("<unreadable>");
      }
    }
  }
  return h.digest("hex");
}
/**
 * Listening sockets owned by a process running in the lane: a server an agent left behind, or one
 * on the owner's port 4321 (`serve` silently moves to the next port when its own is taken).
 */
function laneListeners(lane) {
  const r = run("ss", ["-Hltnp"]);
  if (r.code !== 0) return ["cannot list listening sockets (ss failed)"];
  const real = fs.realpathSync(lane);
  const problems = [];
  for (const line of r.stdout.split("\n")) {
    const port = line.trim().split(/\s+/)[3]?.split(":").pop();
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      let cwd;
      try {
        cwd = fs.realpathSync(`/proc/${m[1]}/cwd`);
      } catch {
        continue;
      }
      if (cwd === real || cwd.startsWith(`${real}/`))
        problems.push(`pid ${m[1]} is listening on :${port} from the lane${port === "4321" ? " (the owner's port)" : ""}`);
    }
  }
  return problems;
}
function parseEnv(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}
/** Properties, not a key list: a symlink, an unknown key, a key value or a primary path refuses. */
function laneEnvProblems(lane, primary) {
  const file = path.join(lane, ".env");
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return [];
  }
  if (st.isSymbolicLink()) return [".env is a symlink (the primary's must never be linked)"];
  const text = fs.readFileSync(file, "utf8");
  const problems = [];
  for (const [k] of parseEnv(text)) if (!LANE_ENV_ALLOW.includes(k)) problems.push(`.env carries ${k}`);
  if (/sk-ant-/.test(text)) problems.push(".env holds an Anthropic key value");
  if (primary && text.includes(primary)) problems.push(".env references the primary checkout");
  return problems;
}
function safetyProblems(state) {
  const lane = state.worktree;
  const problems = FORBIDDEN_ENV.filter((k) => process.env[k]).map((k) => `${k} is exported in this shell`);
  problems.push(...laneEnvProblems(lane, state.primary));
  for (const p of PERSONAL_PATHS)
    if (fs.existsSync(path.join(lane, p))) problems.push(`${p} exists in the lane (owner's personal material)`);
  problems.push(...laneListeners(lane));
  if (!state.guard?.units) problems.push("guard was never initialised (run guard --init)");
  else if (state.guard.units !== unitsFingerprint())
    problems.push("the owner's job-radar systemd units or ~/.config/job-radar changed during the run");
  return problems;
}
/** Detection runs inside every state-changing step, not only when the orchestrator remembers. */
function assertSafe(state) {
  const problems = safetyProblems(state);
  if (problems.length) throw new Stop("error", `lane is not safe: ${problems.join("; ")}`);
}

/** Critic depth for `sha`, from .claude/commands/critique.md Step 3 plus the pipeline's own. */
function computeRisk(base, sha) {
  const files = diffFiles(base, sha);
  const stat = git("diff", "--no-renames", "--numstat", `origin/${base}...${sha}`)
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t").map(Number));
  const added = stat.reduce((n, [a]) => n + (a || 0), 0);
  const deleted = stat.reduce((n, [, d]) => n + (d || 0), 0);
  const has = (re) => files.some((f) => re.test(f));
  const factors = [];
  if (has(/^src\/resume\/(provenance|render|tailor)\.ts$/)) factors.push(["resume provenance", 2]);
  if (has(/^src\/apply\//)) factors.push(["apply refusals", 2]);
  if (has(/^src\/analysis\//)) factors.push(["cost controls", 2]);
  if (has(/^(\.claude\/commands\/run-tickets\.md|scripts\/run-tickets\/)/)) factors.push(["pipeline machinery", 2]);
  const gatesChanged = files.some(isGateFile);
  if (gatesChanged) factors.push(["gate definitions (this diff changes the gates that grade it)", 4]);
  if (has(/^src\/(db|analysis)\/schema\.ts$/)) factors.push(["schema change", 1]);
  if (has(/^src\//) && !has(/^tests\//)) factors.push(["no test changes", 1]);
  if (has(/^\.claude\//)) factors.push(["workflow files", 1]);
  if (has(/^(src\/config\/schema\.ts|config\/.*\.yaml)$/)) factors.push(["config schema", 1]);
  if (deleted > added) factors.push(["deletes more than it adds", 1]);
  if (files.length > 10) factors.push(["files changed > 10", 1]);
  const score = factors.reduce((n, [, w]) => n + w, 0);
  // A `.claude/` change is reviewed at L2 at least: a workflow bug hits every later session.
  const floor = has(/^\.claude\//) ? 2 : 0;
  const depth = score >= 4 ? "L2+Double" : Math.max(score, floor) >= 2 ? "L2" : "L1";
  return {
    sha,
    score,
    depth,
    critics: depth === "L2+Double" ? 2 : 1,
    gatesChanged,
    factors: factors.map((f) => f[0]),
    files: files.length,
  };
}

// ---------------------------------------------------------------------------- commands

const commands = {
  "gate-files"() {
    return { ok: true, files: GATE_FILES };
  },

  /**
   * --init (Step 0c, and every --resume): write the lane .env from the allowlist and, the first
   * time only, record the units fingerprint - it is never silently retaken, so a change made while
   * a run was paused still fails. Without --init (after every agent phase): re-check everything.
   */
  guard() {
    const state = loadState();
    const lane = state.worktree;
    if (INIT) {
      const src = path.join(state.primary, ".env");
      const kept = fs.existsSync(src)
        ? parseEnv(fs.readFileSync(src, "utf8")).filter(([k]) => LANE_ENV_ALLOW.includes(k))
        : [];
      const dest = path.join(lane, ".env");
      fs.rmSync(dest, { force: true }); // a symlink left by an older version of this pipeline
      fs.writeFileSync(dest, kept.map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
      // A refused file must not stay on disk for the next process to load.
      if (laneEnvProblems(lane, state.primary).length) fs.rmSync(dest, { force: true });
      state.guard ??= { units: unitsFingerprint(), at: now() };
    }
    state.heartbeat = now();
    saveState(state);
    assertSafe(state);
    return { ok: true };
  },

  /** Register a ticket as pending. Idempotent: an existing entry is left untouched. */
  add() {
    const state = loadState();
    if (state.tickets.some((t) => t.id === KEY)) return { ok: true, existed: true };
    state.tickets.push({
      id: KEY,
      status: "pending",
      phase: "start",
      fixRound: 0,
      clarification: [],
      trackerWrites: [],
      history: [],
    });
    state.heartbeat = now();
    saveState(state);
    return { ok: true, existed: false };
  },

  show() {
    const t = ticketOf(loadState(), KEY);
    const fields = REST[0]?.split(",");
    return fields ? Object.fromEntries(fields.map((f) => [f, t[f] ?? null])) : t;
  },

  /** Before spawning a critic or Verify: the baseline its "wrote nothing" check compares with. */
  snapshot() {
    return mutate(KEY, (t, state) => {
      if (t.status === "done" || !["critic", "verify"].includes(t.phase))
        throw new Stop("usage", `${KEY} is at ${t.phase}, not critic or verify`);
      assertSafe(state);
      t.snapshot = {
        sha: t.commitSha,
        phase: t.phase,
        primaryStatus: primaryStatus(state),
        baseRemote: remoteHead(baseOf(state)),
        at: now(),
      };
      return { ok: true };
    });
  },

  /** The single write path for returns. stdin: one JSON object. */
  record() {
    const allowed = FIELDS_BY_PHASE[PHASE];
    if (!allowed) throw new Stop("usage", `--phase must be one of ${Object.keys(FIELDS_BY_PHASE)}`);
    let input;
    try {
      input = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch (e) {
      throw new Stop("usage", `malformed agent return: ${e.message}`);
    }
    const shape = shapeProblems(PHASE, input);
    if (shape.length) throw new Stop("usage", `malformed ${PHASE} return: ${shape.join("; ")}`);
    const { result, note, ...rest } = input;
    const fields = {};
    const dropped = [];
    for (const [k, v] of Object.entries(rest)) allowed.includes(k) ? (fields[k] = v) : dropped.push(k);
    const { clarificationAdd = [], trackerWritesAdd = [], postedAdd = [] } = fields;
    delete fields.clarificationAdd;
    delete fields.trackerWritesAdd;
    delete fields.postedAdd;

    return mutate(KEY, (t, state) => {
      // Preconditions: a return lands only on a ticket that is in that phase, and never on a
      // finished one. A stale or duplicated return must not rewind a ticket.
      if (t.status === "done") throw new Stop("usage", `${KEY} is done; nothing records onto it`);
      const expected = PHASE === "triage" ? "start" : PHASE;
      if (PHASE !== "orchestrator" && t.phase !== expected)
        throw new Stop("usage", `${KEY} is at phase ${t.phase}, not ${expected}`);
      if (PHASE === "orchestrator" && fields.status === "done" && !(t.mergeCommit && t.gitFinished))
        throw new Stop("usage", "status done needs a recorded merge and a finished lane");
      if ((PHASE === "critic" || PHASE === "verify") && (t.snapshot?.sha !== t.commitSha || t.snapshot?.phase !== PHASE))
        throw new Stop("usage", `run snapshot ${KEY} before spawning the ${PHASE}`);
      // The critic must have been given the risk of THIS commit, and every critic must justify a
      // gate change: one boolean cannot say which of two reviewers looked.
      if (PHASE === "critic" && "criticVerdict" in fields) {
        if (t.risk?.sha !== t.commitSha) throw new Stop("usage", `run risk ${KEY} for ${t.commitSha} first`);
        if (t.risk.gatesChanged && (fields.gateJustifications ?? []).length < t.risk.critics)
          throw new Stop("usage", `gates changed: ${t.risk.critics} critic justification(s) required`);
      }
      assertSafe(state);
      // Not-owned only ever goes false -> true: the run must not start writing to a ticket it
      // has already decided is someone else's.
      if ("noTracker" in fields) fields.noTracker = Boolean(t.noTracker || fields.noTracker);
      // Critic and Verify may write nothing. Checked here, mechanically, rather than trusted. An
      // agent's own block reason (e.g. "main is red", which stops the run) is kept, not replaced.
      if (PHASE === "critic" || PHASE === "verify") {
        const problems = agentWroteSomething(t, state);
        if (problems.length) {
          const own = result === "blocked" ? `${fields.blockedReason ?? note ?? "blocked"}; also ` : "";
          throw new Stop("blocked", `${own}${PHASE} left changes: ${problems.join("; ")}`);
        }
      }
      // A verdict that names any commit but the current one describes nothing the run will merge.
      for (const [verdict, sha] of [
        ["criticVerdict", "criticSha"],
        ["verifyVerdict", "verifiedSha"],
      ]) {
        if (verdict in fields && (!t.commitSha || fields[sha] !== t.commitSha))
          throw new Stop("usage", `${verdict} is for ${fields[sha]}, not commitSha ${t.commitSha}`);
      }
      // A Fix may only clear the PR (merged outside the run) and move to `<branch>-followup`, and
      // only as a pair: half a switch makes every later Ship fail until the Fix cap. An echo of
      // the current value is a no-op, not a switch.
      if (fields.branch === t.branch) delete fields.branch;
      if ("prNumber" in fields && fields.prNumber === t.prNumber) delete fields.prNumber;
      const followup = "branch" in fields && fields.branch === `${t.branch}-followup` && fields.prNumber === null;
      if ("branch" in fields && !followup)
        throw new Stop("usage", `branch may only become ${t.branch}-followup, with prNumber: null`);
      if ("prNumber" in fields && !followup)
        throw new Stop("usage", "prNumber may only be cleared with the -followup switch");
      if (followup) Object.assign(fields, { prNumber: null, prUrl: null });

      if (result === "blocked") {
        fields.status = "blocked";
        fields.blockedReason ??= note ?? "blocked (no reason given)";
      } else if (result === "handoff") {
        fields.phase = PHASE;
      } else if (NEXT[PHASE]?.[result]) {
        // Critic and Verify route on their verdict, so a result without one routes nowhere.
        const verdict = { critic: "criticVerdict", verify: "verifyVerdict" }[PHASE];
        if (verdict && fields[verdict] !== result)
          throw new Stop("usage", `result ${result} without a matching ${verdict}`);
        fields.phase = NEXT[PHASE][result];
        if (!("handoff" in fields)) fields.handoff = null;
      }
      // Pin the base as well as the head: what Verify graded is this head on this base.
      if (PHASE === "verify" && fields.verifyVerdict)
        fields.verifiedBaseSha = git("rev-parse", `origin/${baseOf(state)}`);
      apply(t, fields, PHASE, [result, note].filter(Boolean).join(": ") || undefined);

      t.trackerWrites ??= [];
      for (const w of trackerWritesAdd) t.trackerWrites.push({ at: now(), ...w });
      t.clarification ??= [];
      for (const c of clarificationAdd) {
        if (t.clarification.some((x) => x.question === c.question)) continue;
        t.clarification.push({ ...c, decidedBy: c.decidedBy ?? "pipeline", posted: false });
      }
      for (const q of postedAdd) {
        const c = t.clarification.find((x) => x.question === q);
        if (c) c.posted = true;
      }
      // A decision taken for the owner is posted where the owner will see it, once - by the
      // orchestrator, which holds the tracker. It reports back with postedAdd.
      return { ok: true, phase: t.phase, status: t.status, dropped, toPost: unposted(t) };
    });
  },

  "pr-append"() {
    const t = ticketOf(loadState(), KEY);
    if (!t.prNumber) throw new Stop("usage", `${KEY} has no PR`);
    const text = fs.readFileSync(REST[0], "utf8").trim();
    if (!appendToPrBody(t.prNumber, text)) throw new Stop("error", "PR body did not read back");
    return { ok: true };
  },

  /** Branch only. The ownership check and the In Progress transition are the orchestrator's. */
  start() {
    if (!RUN_BRANCH) throw new Stop("usage", "--run-branch is required");
    let issue;
    try {
      issue = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch (e) {
      throw new Stop("usage", `start needs the issue JSON on stdin: ${e.message}`);
    }
    if (!issue?.title) throw new Stop("usage", "issue JSON has no title");
    return mutate(KEY, (t, state) => {
      requirePhase(t, t.branch ? "build" : "start");
      const base = baseOf(state);
      assertSafe(state);
      // The ticket text is what Critic, Verify and Fix grade against. Without it, Verify would
      // grade the Build agent's own plan.
      const description = t.descriptionSnapshot ?? issue.description;
      if (typeof description !== "string" || !description.trim())
        throw new Stop("blocked", "the Linear issue has no description: nothing to grade against");
      if (git("status", "--short")) throw new Stop("error", "lane is not clean before Start");
      git("fetch", "origin");
      // Another run may have merged into the base since Step 0d; the lane is clean, so resync.
      if (!t.branch && git("rev-parse", RUN_BRANCH) !== git("rev-parse", `origin/${base}`)) {
        git("checkout", RUN_BRANCH);
        git("reset", "--hard", `origin/${base}`);
      }
      const type = t.type ?? (issue.type === "bug" ? "bug" : "feature");
      // .claude/linear.md: `fix/job-{N}-{slug}` / `feature/job-{N}-{slug}`, slug near 50 chars.
      const slug = issue.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, 50)
        .replace(/-+$/, "");
      const branch = t.branch ?? `${type === "bug" ? "fix" : "feature"}/${KEY.toLowerCase()}-${slug}`;
      const localExists = run("git", ["rev-parse", "--verify", "--quiet", branch]).code === 0;
      if (t.branch && localExists) {
        git("checkout", branch); // resume: the branch is ours
      } else if (t.branch && remoteHead(branch)) {
        git("checkout", "--no-track", "-b", branch, `origin/${branch}`); // resume in a recreated lane
      } else {
        if (localExists || remoteHead(branch)) throw new Stop("blocked", `branch collision: ${branch} exists`);
        git("checkout", "--no-track", "-b", branch, RUN_BRANCH);
      }
      apply(
        t,
        {
          title: issue.title,
          url: issue.url ?? null,
          type,
          descriptionSnapshot: description,
          branch,
          status: "in_progress",
          phase: "build",
        },
        "start",
        `branch ${branch}`,
      );
      return { ok: true, branch, type };
    });
  },

  ship() {
    return mutate(KEY, (t, state) => {
      requirePhase(t, "ship");
      const base = baseOf(state);
      assertSafe(state);
      const fail = (reason, output = "") => {
        apply(t, { verifyFindings: `Ship failed: ${reason}\n${output}`.trim(), phase: "fix" }, "ship", `fail: ${reason}`);
        return { ok: false, route: "fix", reason };
      };
      if (git("branch", "--show-current") !== t.branch) throw new Stop("error", `lane is not on ${t.branch}`);
      // A keyed gates run records a result against a commit: the tree must BE that commit.
      if (git("status", "--short")) return fail("uncommitted changes in the lane");
      if (/^wip:/m.test(git("log", "--format=%s", `origin/${base}..HEAD`)))
        return fail("a wip: commit is still on the branch - squash it before shipping");

      // Never push a credential, or code pointing at the owner's private material. Scanned per
      // COMMIT, not on the net diff: a key added and removed again is still in what gets pushed.
      const leaks = secretLeaks(base, state);
      if (leaks.length) throw new Stop("blocked", `the branch adds ${leaks.join(", ")}; not pushed - owner's call`);

      const head = git("rev-parse", "HEAD");
      const gatesChanged = diffFiles(base).some(isGateFile);
      if (head !== t.gatedSha || gatesChanged) {
        const gates = runGates();
        if (!gates.ok) return fail(`gate ${gates.gate}`, gates.output);
      }
      // On every pushed head: the env loader is app code a ticket can change.
      const probe = keyProbe();
      if (probe.visible)
        throw new Stop("blocked", "the paid key is visible to the CLI from the lane at this commit; not pushed");
      if (probe.ran && probe.code !== 0) return fail("the key probe could not load src/config/env.ts", probe.out);

      if (t.prNumber) {
        const pr = prView(t.prNumber, "state,baseRefName");
        if (pr.state === "MERGED") return fail("PR was merged outside the run - work on a -followup branch");
        // Pushing to a closed PR never moves its head, so Verify would fail forever: owner's call.
        if (pr.state === "CLOSED") throw new Stop("blocked", `PR #${t.prNumber} was closed unmerged`);
        if (pr.baseRefName !== base) return fail(`PR base is ${pr.baseRefName}, not ${base}`);
      }

      // Lease against what the run last pushed, so a commit someone else pushed is never
      // overwritten. `remote === head` is a push that landed but reported failure: ours.
      const remote = remoteHead(t.branch);
      if (remote && remote !== t.commitSha && remote !== head)
        throw new Stop("blocked", `${t.branch} on origin is ${remote}, not the run's ${t.commitSha}`);
      if (remote !== head) {
        // A first push (nothing under that name yet, e.g. a -followup branch) has nothing to lease.
        const push = remote
          ? run("git", ["push", `--force-with-lease=${t.branch}:${remote}`, "origin", t.branch])
          : run("git", ["push", "-u", "origin", t.branch]);
        if (push.code !== 0 && remoteHead(t.branch) !== head) return fail("push refused (lease or remote)", push.out);
      }
      if (remoteHead(t.branch) !== head) return fail("push did not read back as HEAD");
      // Record the push before anything else can fail: a retry must recognise this commit as ours.
      if (t.commitSha !== head) apply(t, { commitSha: head, mergeAttempts: 0 }, "ship", `pushed ${head.slice(0, 8)}`);

      let { prNumber, prUrl } = t;
      // A crash between `gh pr create` and the state write leaves a PR the state does not know.
      // Adopt it rather than creating a second one (which fails, and loops to the Fix cap).
      if (!prNumber) {
        const open = JSON.parse(
          sh("gh", ["pr", "list", "--head", t.branch, "--state", "open", "--json", "number,url,baseRefName"]) || "[]",
        );
        if (open[0]) {
          if (open[0].baseRefName !== base) return fail(`open PR #${open[0].number} is based on ${open[0].baseRefName}`);
          ({ number: prNumber, url: prUrl } = open[0]);
        }
      }
      const round = t.roundNote ? `Round ${t.fixRound}: ${t.roundNote}` : null;
      if (!prNumber) {
        const body = [
          t.prBody ?? t.implementationSummary ?? "",
          round,
          "NOT VERIFIED BY A HUMAN",
          t.url ? `Linear: ${t.url}` : null,
          `Resolves ${KEY}`,
          "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        ]
          .filter(Boolean)
          .join("\n\n");
        const title = t.prTitle ?? git("log", "-1", "--format=%s");
        const created = run("gh", ["pr", "create", "--base", base, "--head", t.branch, "--title", title, "--body", body]);
        const m = created.stdout.match(/https:\/\/\S+\/pull\/(\d+)/);
        if (created.code !== 0 || !m) return fail("gh pr create failed", created.out);
        prUrl = m[0];
        prNumber = Number(m[1]);
        apply(t, { prNumber, prUrl }, "ship", `PR #${prNumber} created`);
      } else if (round && !appendToPrBody(prNumber, round)) {
        return fail("PR body Round line did not read back");
      }
      apply(t, { prNumber, prUrl, roundNote: null, phase: "critic" }, "ship", `PR #${prNumber}`);
      return { ok: true, prNumber, prUrl, commitSha: head };
    });
  },

  /** Records the depth for the current commitSha; a critic record is refused without it. */
  risk() {
    return mutate(KEY, (t, state) => {
      requirePhase(t, "critic");
      t.risk = computeRisk(baseOf(state), t.commitSha);
      return { ok: true, ...t.risk };
    });
  },

  /**
   * Preflight only. The merge itself is run by the ORCHESTRATOR as a plain `gh pr merge` Bash
   * call, so the harness permission check sees it: inside `node ...` it would be invisible. Same
   * for the remote-branch delete (`merged` prints it).
   *
   * Order matters: PR state and head first (a merge, ours or by hand, always moves the base, so a
   * base check first would send an already-merged PR to Fix), then the static refusals, then the
   * base check.
   */
  merge() {
    return mutate(KEY, (t, state) => {
      requirePhase(t, "merge");
      const base = baseOf(state);
      assertSafe(state);
      // An explicit false: a state file from before the field existed cannot prove the run was
      // allowed to merge. Refusal blocks the ticket (PR left open), never the whole run.
      if (state.manualMerge !== false)
        throw new Stop("blocked", "run is --manual-merge (or predates the field): PR left open, not merged");
      const sha = t.commitSha;
      if (
        !sha ||
        !["pass", "concerns"].includes(t.criticVerdict) ||
        t.verifyVerdict !== "pass" ||
        t.criticSha !== sha ||
        t.verifiedSha !== sha
      )
        throw new Stop("error", "merge called without both verdicts on the current commitSha");
      // Re-derived rather than trusted: a skipped `risk` after a Fix would otherwise waive the
      // gate justification.
      const risk = computeRisk(base, sha);
      if (risk.gatesChanged && (t.risk?.sha !== sha || (t.gateJustifications ?? []).length < risk.critics))
        throw new Stop("error", "gate files changed and the critics' justifications are not on record for this commit");

      const pr = prView(t.prNumber, "state,baseRefName,headRefOid");
      // Whether merged by us or by hand, what merged must be the commit that was graded.
      if (pr.headRefOid !== sha) throw new Stop("blocked", `PR head ${pr.headRefOid} is not the graded ${sha}`);
      if (pr.state === "CLOSED") throw new Stop("blocked", `PR #${t.prNumber} was closed unmerged`);
      if (pr.state === "MERGED") return { ok: true, run: [] };
      if (pr.baseRefName !== base) throw new Stop("blocked", `PR base is ${pr.baseRefName}`);

      const gated = diffFiles(base, sha).filter((f) => OWNER_GATED.test(f));
      if (gated.length)
        throw new Stop(
          "blocked",
          `owner gate: ${gated.join(", ")} changed; CLAUDE.md requires a live autofill run before an src/apply/ change ships. PR left open for the owner.`,
        );

      // The base must not have moved since Verify: a squash onto a newer base is a tree nobody
      // graded. Decided by comparing shas, never from anything an agent wrote.
      git("fetch", "origin");
      const baseNow = git("rev-parse", `origin/${base}`);
      if (baseNow !== t.verifiedBaseSha || run("git", ["merge-base", "--is-ancestor", baseNow, sha]).code !== 0) {
        apply(
          t,
          {
            verifyFindings: `origin/${base} moved to ${baseNow} since Verify graded ${sha} on ${t.verifiedBaseSha}; rebase and re-verify.`,
            phase: "fix",
          },
          "merge",
          "base moved",
        );
        return { ok: false, route: "fix", reason: "base moved" };
      }
      t.mergeAttempts = (t.mergeAttempts ?? 0) + 1;
      if (t.mergeAttempts > 2) throw new Stop("blocked", "gh pr merge did not land in two attempts");
      return { ok: true, run: [`gh pr merge ${t.prNumber} --squash --match-head-commit ${sha}`] };
    });
  },

  /** After the orchestrator ran `gh pr merge`: read the PR back, never trust the exit code. */
  merged() {
    return mutate(KEY, (t, state) => {
      requirePhase(t, "merge");
      const base = baseOf(state);
      const sha = t.commitSha;
      const s = prView(t.prNumber, "state,mergeable,headRefOid,mergeCommit");
      if (s.state !== "MERGED") {
        if (s.headRefOid !== sha) throw new Stop("blocked", "PR head moved after Verify; someone else pushed");
        if (s.mergeable === "CONFLICTING") {
          apply(t, { verifyFindings: `Merge conflict with origin/${base}; rebase.`, phase: "fix" }, "merge", "conflict");
          return { ok: false, route: "fix", reason: "conflict" };
        }
        pause(Number(process.env.RUN_TICKETS_MERGE_PAUSE ?? 10)); // `mergeable` settles lazily
        return { ok: true, retry: true }; // orchestrator: `merge` again (it caps the attempts)
      }
      if (s.headRefOid !== sha) throw new Stop("error", "PR reads back MERGED at a head that was not graded");
      // The code is in the base from here on: record it before anything can block.
      apply(t, { mergeCommit: s.mergeCommit?.oid ?? null, phase: "finish" }, "merge", "merged");
      // Delete the remote branch only when it holds exactly what merged: anything else on it is a
      // commit whose only remote copy a delete would destroy.
      const remote = remoteHead(t.branch);
      if (remote && remote !== sha)
        throw new Stop("blocked", `merged; origin/${t.branch} moved to ${remote} after, so it was kept`);
      return {
        ok: true,
        mergeCommit: s.mergeCommit?.oid,
        run: remote ? [`gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/${t.branch}`] : [],
      };
    });
  },

  /** Git only. Linear -> Done (read back) is the orchestrator's, after this. */
  finish() {
    if (!RUN_BRANCH) throw new Stop("usage", "--run-branch is required");
    return mutate(KEY, (t, state) => {
      requirePhase(t, "finish");
      const base = baseOf(state);
      if (!t.mergeCommit) throw new Stop("error", "finish called before merged recorded a merge");
      assertSafe(state);
      if (git("status", "--short")) {
        git("add", "-A");
        git("commit", "-m", "wip: left after merge", "--no-verify");
        throw new Stop("blocked", "lane had uncommitted work after merge; committed as wip on the ticket branch");
      }
      git("checkout", RUN_BRANCH);
      git("fetch", "origin");
      git("reset", "--hard", `origin/${base}`);
      if (remoteHead(t.branch))
        throw new Stop("blocked", `merged, but origin/${t.branch} was not deleted (run merged's command)`);
      // Squash-merge makes `git branch -d` lie. Delete only when the local branch IS the merged head.
      const local = run("git", ["rev-parse", "--verify", "--quiet", t.branch]);
      if (local.code === 0) {
        if (local.stdout.trim() !== t.commitSha)
          throw new Stop("blocked", `local ${t.branch} holds commits that were not merged`);
        git("branch", "-D", t.branch);
      }
      // status stays in_progress: the orchestrator sets done after the Linear write (or its failure).
      apply(t, { gitFinished: true }, "finish", "lane resynced");
      // Never transition a ticket the run does not own.
      return { ok: true, trackerDone: !t.noTracker };
    });
  },
};

// ---------------------------------------------------------------------------- main

const KEYLESS = new Set(["guard", "gate-files"]);
try {
  if (!commands[cmd]) throw new Stop("usage", `commands: ${Object.keys(commands).join(" | ")}`);
  if (!KEYLESS.has(cmd) && !KEY_RE.test(KEY ?? ""))
    throw new Stop("usage", `${cmd} needs a ticket key matching ${KEY_RE}`);
  // Every step runs in the lane and nowhere else: a step run from the primary would branch,
  // reset or commit in the owner's checkout. Anchored before any git command runs.
  if (cmd !== "show" && cmd !== "gate-files") {
    const state = loadState();
    const top = run("git", ["rev-parse", "--show-toplevel"]).stdout.trim();
    if (!state.worktree || !top || fs.realpathSync(top) !== fs.realpathSync(state.worktree))
      throw new Stop("error", `run from the lane ${state.worktree}, not ${top || process.cwd()}`);
    process.chdir(state.worktree);
  }
  const out = commands[cmd]();
  console.log(JSON.stringify(out));
  process.exit(out?.ok === false ? EXIT.fail : EXIT.ok);
} catch (e) {
  const kind = e instanceof Stop ? e.kind : "error";
  if (kind === "blocked" && STATE && KEY_RE.test(KEY ?? "")) {
    try {
      mutate(KEY, (t) => apply(t, { status: "blocked", blockedReason: e.message }, cmd, `blocked: ${e.message}`));
    } catch {}
  }
  console.log(JSON.stringify({ ok: false, [kind]: e.message }));
  process.exit(EXIT[kind] ?? EXIT.error);
}
