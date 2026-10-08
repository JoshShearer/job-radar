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
 * (`toPost`). Git, gh and the state file are all here.
 *
 * This script is the ONLY writer of ticket entries in the run's state file. Agents return one JSON
 * object; the orchestrator pipes it into `record --phase <phase>`, which:
 *   - keeps only the fields that phase may set (FIELDS_BY_PHASE) and reports what it dropped;
 *   - refuses a verdict that names any commit but the current `commitSha`;
 *   - refuses a critic or Verify return that left the lane changed (they may write nothing);
 *   - moves `phase`/`status` by the routing table (NEXT), so a resume continues where the run was.
 * A verdict describes one commit: whenever `commitSha` changes, both verdicts are cleared.
 *
 * The orchestrator runs a FROZEN copy of this file, taken from origin/<base> at Step 0c before any
 * ticket branch is checked out: a ticket that edits this file must not change the gate that
 * merges it.
 *
 * Run from the lane (every command refuses any other working directory):
 *   node <ops>/ticket-ops.mjs --state <file> <cmd> [<KEY>] [...]
 *
 *   guard [--init --primary <dir>]  lane safety: generate (--init) or re-check the lane .env, the
 *                                   launching environment, and the owner's systemd units
 *   add <KEY>                       register a pending ticket (idempotent)
 *   show <KEY> [field,...]          print the ticket entry (or a subset) - what agents read
 *   record <KEY> --phase <p>        merge a JSON return (stdin) - see above
 *   pr-append <KEY> <textFile>      append text to the PR body and read it back
 *   start <KEY> --run-branch <b>    branch off the run branch; stdin is the issue as the
 *                                   orchestrator read it from Linear: {title, type, description, url}
 *   ship <KEY>                      gates unless HEAD == gatedSha, leased push, read back, PR create
 *                                   or Round-line append
 *   risk <KEY>                      critic depth for origin/<base>...commitSha (L1 | L2 | L2+Double)
 *   merge <KEY>                     preflight; prints the `gh pr merge` the ORCHESTRATOR must run
 *   merged <KEY>                    read the merge back; prints the remote-branch delete to run
 *   finish <KEY> --run-branch <b>   resync the lane, delete the local branch by head equality
 *
 * Output: one JSON line. Exit codes: 0 ok, 1 usage or malformed input (for `record`: re-run the
 * agent once), 2 infrastructure or safety error (stop the run), 3 blocked (status and
 * blockedReason are set), 4 fail (route to Fix; verifyFindings is set).
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXIT = { ok: 0, usage: 1, error: 2, blocked: 3, fail: 4 };
const VERDICT_FIELDS = ["criticVerdict", "criticSha", "verifyVerdict", "verifiedSha", "verifiedBaseSha"];

/**
 * The lane's .env is GENERATED from this allowlist, never linked. The primary's .env holds a live
 * ANTHROPIC_API_KEY (the only thing in this repo that spends money), and the JOB_RADAR_* path
 * overrides can point the lane at the owner's real database, resume or personal answers. Anything
 * not listed here is dropped, whatever it is called.
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

/** What each phase's return may set. Anything else is dropped and reported. */
const COMMON = ["handoff", "blockedReason", "clarificationAdd"];
const FIELDS_BY_PHASE = {
  triage: ["type", "status", "noTracker", ...COMMON],
  build: ["planNote", "reproduction", "reproConfirmed", "implementationSummary", "gatedSha", "prTitle", "prBody", ...COMMON],
  fix: ["gatedSha", "verifyFindings", "implementationSummary", "roundNote", "branch", "prNumber", ...COMMON],
  critic: ["criticVerdict", "criticSha", "verifyFindings", "criticNotes", "blockedReason"],
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
 * Files that DEFINE the gates. Freezing this script does not freeze what `npm test` and
 * `npm run typecheck` do: a ticket could weaken the test config or the typecheck script and then
 * pass through its own weakened gate. Such a diff gets the deepest critic, is told so, and never
 * takes the "gates already ran on this sha" shortcut.
 */
const GATE_FILES = /^(package\.json|tsconfig\.json|vitest\.config\.ts|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|\.npmrc)$/;
/** Linear team JOB. Keys reach branch names and shell commands, so nothing else is accepted. */
const KEY_RE = /^JOB-[1-9][0-9]*$/;
/** Results each phase may return. Anything else is malformed: re-run the agent, write nothing. */
const RESULTS = {
  triage: [undefined, "done", "blocked"],
  build: ["done", "handoff", "blocked"],
  fix: ["done", "handoff", "blocked"],
  critic: ["pass", "concerns", "block"],
  verify: ["pass", "fail", "handoff", "blocked"],
  orchestrator: [undefined],
};
/** Field types, checked before anything is applied. */
const STRING_FIELDS = new Set([
  "type", "status", "blockedReason", "handoff", "planNote", "reproduction", "implementationSummary", "gatedSha",
  "prTitle", "prBody", "verifyFindings", "roundNote", "branch", "criticVerdict", "criticSha", "criticNotes",
  "verifyVerdict", "verifiedSha", "verifyNotes", "phase",
]);
const BOOLEAN_FIELDS = new Set(["reproConfirmed", "noTracker"]);
const NUMBER_FIELDS = new Set(["fixRound", "prNumber"]);
const ARRAY_FIELDS = new Set(["clarificationAdd", "trackerWritesAdd", "postedAdd"]);

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
const PRIMARY_OPT = opt("primary");
const INIT = flag("init");
const [cmd, KEY, ...REST] = argv;

// ---------------------------------------------------------------------------- shell helpers

/** Run and return trimmed stdout; throws on a non-zero exit. */
function sh(bin, args, { input } = {}) {
  return execFileSync(bin, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
/** Run without throwing. `out` is stdout+stderr capped for reporting; `stdout` is kept apart. */
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, stdout: r.stdout ?? "", out: out.length > 4000 ? `...${out.slice(-4000)}` : out };
}
const git = (...a) => sh("git", a);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const pause = (s) => spawnSync("sleep", [String(s)]);

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
/** Apply fields to a ticket. A new commitSha invalidates every verdict not set in the same call. */
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
/** Pipeline decisions not yet on the Linear ticket. Never for a ticket the run does not own. */
const unposted = (t) =>
  t.noTracker ? [] : (t.clarification ?? []).filter((c) => c.decidedBy === "pipeline" && !c.posted);

/** Every problem with a return's shape. Nothing is applied unless this is empty. */
function shapeProblems(phase, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["return is not a JSON object"];
  const problems = [];
  if (!RESULTS[phase].includes(input.result)) problems.push(`result ${JSON.stringify(input.result)} is not a ${phase} result`);
  if ("note" in input && typeof input.note !== "string") problems.push("note is not a string");
  for (const [k, v] of Object.entries(input)) {
    if (k === "result" || k === "note") continue;
    if (STRING_FIELDS.has(k) && v !== null && typeof v !== "string") problems.push(`${k} is not a string`);
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
  return problems;
}

// ---------------------------------------------------------------------------- git/gh helpers

const baseOf = (state) => {
  if (!state.baseBranch) throw new Stop("error", "state file has no baseBranch");
  return state.baseBranch;
};
const changedFiles = (base, to = "HEAD") =>
  git("diff", "--name-only", `origin/${base}...${to}`).split("\n").filter(Boolean);
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
/** The lane must be on the ticket branch, at the pushed commit, with nothing changed. */
function laneUnchanged(t) {
  const problems = [];
  if (git("status", "--short")) problems.push("uncommitted or untracked files");
  if (git("branch", "--show-current") !== t.branch) problems.push(`not on ${t.branch}`);
  if (git("rev-parse", "HEAD") !== t.commitSha) problems.push(`HEAD is not ${t.commitSha}`);
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

// ---------------------------------------------------------------------------- lane safety

const configHome = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
/**
 * Fingerprint of what `deploy/install-timer.sh` writes: the owner's user units and env file. Run
 * from a lane, that script would repoint the owner's daily timer at a directory Step 8 deletes.
 */
function unitsFingerprint() {
  const files = [];
  const unitDir = path.join(configHome(), "systemd", "user");
  if (fs.existsSync(unitDir))
    for (const f of fs.readdirSync(unitDir).sort()) if (f.startsWith("job-radar")) files.push(path.join(unitDir, f));
  const envDir = path.join(configHome(), "job-radar");
  if (fs.existsSync(envDir)) for (const f of fs.readdirSync(envDir).sort()) files.push(path.join(envDir, f));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    try {
      h.update(fs.readFileSync(f));
    } catch {
      h.update("<unreadable>");
    }
  }
  return h.digest("hex");
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
/** Properties, not a key list: an unknown key, a key-shaped value or a primary path refuses. */
function laneEnvProblems(lane, primary) {
  const file = path.join(lane, ".env");
  if (!fs.existsSync(file)) return [];
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) return [".env is a symlink (the primary's must never be linked)"];
  const text = fs.readFileSync(file, "utf8");
  const problems = [];
  for (const [k] of parseEnv(text)) if (!LANE_ENV_ALLOW.includes(k)) problems.push(`.env carries ${k}`);
  if (/sk-ant-/.test(text)) problems.push(".env holds an Anthropic key value");
  if (primary && text.includes(primary)) problems.push(".env references the primary checkout");
  return problems;
}
function safetyProblems(lane, primary) {
  const problems = FORBIDDEN_ENV.filter((k) => process.env[k]).map((k) => `${k} is exported in this shell`);
  problems.push(...laneEnvProblems(lane, primary));
  for (const p of PERSONAL_PATHS)
    if (fs.existsSync(path.join(lane, p))) problems.push(`${p} exists in the lane (owner's personal material)`);
  return problems;
}

// ---------------------------------------------------------------------------- commands

const commands = {
  /**
   * --init (Step 0c, and every --resume): write the lane .env from the allowlist and record the
   * units fingerprint. Without --init (after every agent phase): re-check everything.
   */
  guard() {
    const state = loadState();
    const lane = state.worktree;
    const primary = PRIMARY_OPT ?? state.primary;
    if (INIT) {
      if (!primary) throw new Stop("usage", "guard --init needs --primary <dir> or state.primary");
      const src = path.join(primary, ".env");
      const kept = fs.existsSync(src)
        ? parseEnv(fs.readFileSync(src, "utf8")).filter(([k]) => LANE_ENV_ALLOW.includes(k))
        : [];
      const dest = path.join(lane, ".env");
      fs.rmSync(dest, { force: true }); // a symlink left by an older version of this pipeline
      fs.writeFileSync(dest, kept.map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
      state.guard = { units: unitsFingerprint(), at: now() };
    }
    const problems = safetyProblems(lane, primary);
    if (state.guard?.units && state.guard.units !== unitsFingerprint())
      problems.push("the owner's job-radar systemd units or ~/.config/job-radar changed during the run");
    if (!state.guard) problems.push("guard was never initialised (run guard --init)");
    state.heartbeat = now();
    saveState(state);
    if (problems.length) throw new Stop("error", `lane is not safe: ${problems.join("; ")}`);
    return { ok: true, laneEnvKeys: INIT ? LANE_ENV_ALLOW : undefined };
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
      // Not-owned only ever goes false -> true: the run must not start writing to a ticket it
      // has already decided is someone else's.
      if ("noTracker" in fields) fields.noTracker = Boolean(t.noTracker || fields.noTracker);
      // Critic and Verify may write nothing. Checked here, mechanically, rather than trusted.
      if (PHASE === "critic" || PHASE === "verify") {
        const problems = laneUnchanged(t);
        if (problems.length) throw new Stop("blocked", `${PHASE} left the lane changed: ${problems.join("; ")}`);
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
      const followup = "branch" in fields && fields.branch === `${t.branch}-followup`;
      if ("branch" in fields && !followup) throw new Stop("usage", `branch may only become ${t.branch}-followup`);
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
      } else if (result && PHASE !== "orchestrator" && PHASE !== "triage") {
        throw new Stop("usage", `result ${result} is not a result of ${PHASE}`);
      }
      // Pin the base as well as the head: what Verify graded is this head on this base.
      if (PHASE === "verify" && fields.verifyVerdict) fields.verifiedBaseSha = git("rev-parse", `origin/${baseOf(state)}`);
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
      const base = baseOf(state);
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
          descriptionSnapshot: t.descriptionSnapshot ?? issue.description ?? "",
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
      const base = baseOf(state);
      const fail = (reason, output = "") => {
        apply(t, { verifyFindings: `Ship failed: ${reason}\n${output}`.trim(), phase: "fix" }, "ship", `fail: ${reason}`);
        return { ok: false, route: "fix", reason };
      };
      if (git("branch", "--show-current") !== t.branch) throw new Stop("error", `lane is not on ${t.branch}`);
      if (git("status", "--short")) return fail("uncommitted changes in the lane");
      if (/^wip:/m.test(git("log", "--format=%s", `origin/${base}..HEAD`)))
        return fail("a wip: commit is still on the branch - squash it before shipping");

      const head = git("rev-parse", "HEAD");
      const gatesChanged = changedFiles(base).some((f) => GATE_FILES.test(f));
      if (head !== t.gatedSha || gatesChanged) {
        const gates = runGates();
        if (!gates.ok) return fail(`gate ${gates.gate}`, gates.output);
      }

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

  /** Critic depth, from .claude/commands/critique.md Step 3, plus the pipeline's own machinery. */
  risk() {
    const state = loadState();
    const t = ticketOf(state, KEY);
    const base = baseOf(state);
    // Unfiltered: a deletion (of a refusal, a guard, this script) is the change most worth reviewing.
    const files = git("diff", "--name-only", `origin/${base}...${t.commitSha}`).split("\n").filter(Boolean);
    const stat = git("diff", "--numstat", `origin/${base}...${t.commitSha}`)
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
    const gatesChanged = has(GATE_FILES);
    if (gatesChanged) factors.push(["gate definitions (this diff changes the gates that grade it)", 4]);
    if (has(/^src\/(db|analysis)\/schema\.ts$/)) factors.push(["schema change", 1]);
    if (has(/^src\//) && !has(/^tests\//)) factors.push(["no test changes", 1]);
    if (has(/^package\.json$/)) factors.push(["dependencies", 1]);
    if (has(/^\.claude\//)) factors.push(["workflow files", 1]);
    if (has(/^(src\/config\/schema\.ts|config\/.*\.yaml)$/)) factors.push(["config schema", 1]);
    if (deleted > added) factors.push(["deletes more than it adds", 1]);
    if (files.length > 10) factors.push(["files changed > 10", 1]);
    const score = factors.reduce((n, [, w]) => n + w, 0);
    // A `.claude/` change is reviewed at L2 at least: a workflow bug hits every later session.
    const floor = has(/^\.claude\//) ? 2 : 0;
    return {
      score,
      depth: score >= 4 ? "L2+Double" : Math.max(score, floor) >= 2 ? "L2" : "L1",
      factors: factors.map((f) => f[0]),
      files: files.length,
      gatesChanged,
      // Also a determinism-boundary check the critic must make by reading: a model call in
      // src/pipeline, src/lib or src/db. A path rule cannot see it.
    };
  },

  /**
   * Preflight only. The merge itself is run by the ORCHESTRATOR as a plain `gh pr merge` Bash
   * call, so the harness permission check sees it: inside `node ...` it would be invisible. Same
   * for the remote-branch delete (`merged` prints it).
   */
  merge() {
    return mutate(KEY, (t, state) => {
      const base = baseOf(state);
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
      // The base must not have moved since Verify: a squash onto a newer base is a tree nobody
      // graded. Parallel runs make this real. Rebase and re-verify.
      git("fetch", "origin");
      const baseNow = git("rev-parse", `origin/${base}`);
      if (baseNow !== t.verifiedBaseSha || run("git", ["merge-base", "--is-ancestor", baseNow, sha]).code !== 0) {
        apply(
          t,
          { verifyFindings: `origin/${base} moved to ${baseNow} since Verify graded ${sha} on ${t.verifiedBaseSha}; rebase and re-verify.`, phase: "fix" },
          "merge",
          "base moved",
        );
        return { ok: false, route: "fix", reason: "base moved" };
      }
      const gated = changedFiles(base, sha).filter((f) => OWNER_GATED.test(f));
      if (gated.length)
        throw new Stop(
          "blocked",
          `owner gate: ${gated.join(", ")} changed; CLAUDE.md requires a live autofill run before an src/apply/ change ships. PR left open for the owner.`,
        );
      const pr = prView(t.prNumber, "state,baseRefName,headRefOid");
      // Whether merged by us or by hand, what merged must be the commit that was graded.
      if (pr.headRefOid !== sha) throw new Stop("blocked", `PR head ${pr.headRefOid} is not the graded ${sha}`);
      if (pr.state === "CLOSED") throw new Stop("blocked", `PR #${t.prNumber} was closed unmerged`);
      if (pr.state === "MERGED") return { ok: true, run: [] };
      if (pr.baseRefName !== base) throw new Stop("blocked", `PR base is ${pr.baseRefName}`);
      t.mergeAttempts = (t.mergeAttempts ?? 0) + 1;
      if (t.mergeAttempts > 2) throw new Stop("blocked", "gh pr merge did not land in two attempts");
      return { ok: true, run: [`gh pr merge ${t.prNumber} --squash --match-head-commit ${sha}`] };
    });
  },

  /** After the orchestrator ran `gh pr merge`: read the PR back, never trust the exit code. */
  merged() {
    return mutate(KEY, (t, state) => {
      const base = baseOf(state);
      const sha = t.commitSha;
      const s = prView(t.prNumber, "state,mergeable,headRefOid,mergeCommit");
      if (s.state !== "MERGED") {
        if (s.headRefOid !== sha) throw new Stop("blocked", "PR head moved after Verify; someone else pushed");
        if (s.mergeable === "CONFLICTING") {
          apply(t, { verifyFindings: `Merge conflict with origin/${base}; rebase.`, phase: "fix" }, "merge", "conflict");
          return { ok: false, route: "fix", reason: "conflict" };
        }
        pause(10); // `mergeable` is computed lazily; UNKNOWN usually settles within seconds
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
      const base = baseOf(state);
      if (!t.mergeCommit) throw new Stop("error", "finish called before merged recorded a merge");
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
      apply(t, { gitFinished: true, phase: "finish" }, "finish", "lane resynced");
      // Never transition a ticket the run does not own.
      return { ok: true, trackerDone: !t.noTracker };
    });
  },
};

// ---------------------------------------------------------------------------- main

const KEYLESS = new Set(["guard"]);
try {
  if (!commands[cmd]) throw new Stop("usage", `commands: ${Object.keys(commands).join(" | ")}`);
  if (!KEYLESS.has(cmd) && !KEY_RE.test(KEY ?? "")) throw new Stop("usage", `${cmd} needs a ticket key matching ${KEY_RE}`);
  // Every step runs in the lane and nowhere else: a step run from the primary would branch,
  // reset or commit in the owner's checkout.
  if (cmd !== "show") {
    const state = loadState();
    const top = run("git", ["rev-parse", "--show-toplevel"]).stdout.trim();
    if (!state.worktree || fs.realpathSync(top || ".") !== fs.realpathSync(state.worktree))
      throw new Stop("error", `run from the lane ${state.worktree}, not ${top || process.cwd()}`);
  }
  const out = commands[cmd]();
  console.log(JSON.stringify(out));
  process.exit(out?.ok === false ? EXIT.fail : EXIT.ok);
} catch (e) {
  const kind = e instanceof Stop ? e.kind : "error";
  if (kind === "blocked" && STATE && KEY) {
    try {
      mutate(KEY, (t) => apply(t, { status: "blocked", blockedReason: e.message }, cmd, `blocked: ${e.message}`));
    } catch {}
  }
  console.log(JSON.stringify({ ok: false, [kind]: e.message }));
  process.exit(EXIT[kind] ?? EXIT.error);
}
