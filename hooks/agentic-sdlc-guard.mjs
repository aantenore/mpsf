#!/usr/bin/env node
// Host hook entry point shared by both supported agent hosts. It reads the
// hook payload from stdin and blocks a tool call only by exiting with status
// 2 and a reason on stderr, the one blocking signal both hosts honour. Any
// internal failure exits 0 so the host's normal permission flow applies; the
// CLI enforces every rule on its own.
// MPSF_* variables are aliases of AGENTIC_SDLC_*; applied before anything reads the environment.
import "../lib/runtime/env-alias.mjs";
// Then: with AGENTIC_SDLC_AUTO_UPDATE=1 a newer installed version takes over this call.
import "../lib/runtime/self-forward.mjs";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_PACK_INSTRUCTION,
  evaluatePreToolUse,
  targetedPaths,
  mainThreadMode,
  orchestratorEditWarning,
  orchestratorSessionContext,
  PROCESS_HYGIENE_INSTRUCTION,
  STORY_LABEL_INSTRUCTION,
  WATCH_INSTRUCTION,
  sessionStartContext,
  strictMainThreadVerdict,
} from "../lib/host-hooks/guard.mjs";
import { ghAlias, gitAlias, isGuardExempt, isUngovernedRepo, mergeAuthorized, storyPushAuthorized } from "../lib/host-hooks/merge-authorization.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs");
// Below the 30-second hook timeout, so a slow remote still yields the local summary.
const STATUS_TIMEOUT_MS = 25_000;

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** The nearest folder up the tree that holds a `.sdlc` folder (a project that uses agentic-sdlc), or null. */
function governedRoot(start) {
  let current = path.resolve(String(start || process.cwd()));
  for (;;) {
    try {
      if (fs.statSync(path.join(current, ".sdlc")).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Session id of the host payload (Claude Code: session_id), or "". */
function sessionIdOf(payload) {
  return String(payload?.session_id || payload?.sessionId || "");
}

/**
 * Drops from `text` what this session already saw and caps the rest (see
 * lib/host-hooks/injection-budget.mjs). Never throws; on any failure the text
 * is returned as it was.
 */
async function budgeted(text, { event, payload, root, pointer, extraTokens = 0, forget = false }) {
  try {
    const { applyInjectionBudget } = await import("../lib/host-hooks/injection-budget.mjs");
    const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
    const base = root ?? payload?.cwd ?? process.cwd();
    const config = readJson(path.join(governedRoot(base) ?? base, ".sdlc", "config.json"));
    return applyInjectionBudget({ text, event, sessionId: sessionIdOf(payload), commonDir: findGitCommonDir(base), config, pointer, extraTokens, forget });
  } catch {
    return text;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The project's main-thread mode from `.sdlc/config.json` ("free" when unset). */
function projectMainThreadMode(root) {
  return mainThreadMode(readJson(path.join(root, ".sdlc", "config.json")), process.env);
}

/** The governed project root plus every git worktree of it: the paths strict mode keeps closed to the main thread. */
function governedTreeRoots(root) {
  const roots = [root];
  const listed = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (listed.status === 0) {
    for (const line of listed.stdout.split("\n")) if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length).trim());
  }
  return roots;
}

function insideGovernedProject(start) {
  return governedRoot(start) !== null;
}

/**
 * Puts unanswered coordination questions and a digest of new messages in
 * front of the agent (after a tool call or on a prompt). Never blocks.
 */
async function coordinationMessages(payload, hookEventName, extraContext = async () => "") {
  const root = governedRoot(payload.cwd);
  if (!root) return;
  // Loaded here so a problem with it never disables the edit guard.
  const { checkAttention } = await import("../lib/messaging/attention.mjs");
  const raw = [await checkAttention(root), await extraContext(root)].filter(Boolean).join("\n");
  const context = raw ? await budgeted(raw, {
    event: hookEventName === "PostToolUse" ? "post_tool_use" : "user_prompt_submit",
    payload,
    root,
    pointer: "mpsf wait list",
  }) : "";
  try {
    const { checkPresence } = await import("../lib/messaging/presence.mjs");
    await checkPresence(root);
  } catch {
    // best effort
  }
  try {
    // An agent working in this folder renews the claim of the story checked out here.
    const { noteWorktreeActivity } = await import("../lib/runtime/worktree-activity.mjs");
    noteWorktreeActivity(root);
  } catch {
    // best effort
  }
  try {
    // This computer's presence and role leases on the remote: at most every few minutes, in a
    // detached process, so the network never holds up the hook or the messages it shows.
    const { claimTickSlot } = await import("../lib/engine/role-leases.mjs");
    if (claimTickSlot(root, { sessionId: payload.session_id })) runDetached("roles-tick", root, payload.session_id);
  } catch {
    // best effort
  }
  if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
}

/** The process warning left at Stop and not yet shown, once, with the next prompt. */
async function pendingProcessWarning(root) {
  try {
    const { takePendingReapWarning } = await import("../lib/host-hooks/process-hygiene.mjs");
    const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
    return takePendingReapWarning(root, { commonDir: findGitCommonDir(root) });
  } catch {
    return "";
  }
}

const MAX_SCRIPT_BYTES = 1024 * 1024;

/**
 * A script file a shell command runs, for the guard to check: null when it is tracked and
 * unchanged (reviewed content), { missing } or { tooLarge }, else its text.
 */
function readAgentScript(cwd, file) {
  try {
    const full = path.resolve(String(cwd || process.cwd()), String(file).replace(/^~(?=[\\/])/u, process.env.HOME || "~"));
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return { missing: true };
    }
    if (!stat.isFile()) return null;
    const status = spawnSync("git", ["status", "--porcelain", "--ignored", "--", path.basename(full)], { cwd: path.dirname(full), encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    if (status.status === 0 && status.stdout.trim() === "") return null;
    if (stat.size > MAX_SCRIPT_BYTES) return { tooLarge: true };
    return { content: fs.readFileSync(full, "utf8") };
  } catch {
    return null;
  }
}

/**
 * The governed project a tool call acts on: the session's own, else one that a
 * written file or a folder named in the command (`--root`, `git -C`, `cd`) lies in,
 * so a session started outside the project cannot reach it unguarded.
 */
function targetGovernedRoot(payload) {
  const own = governedRoot(payload.cwd);
  if (own) return own;
  const cwd = path.resolve(String(payload.cwd || process.cwd()));
  for (const target of targetedPaths(payload)) {
    const full = path.resolve(cwd, target.replace(/^~(?=[\\/])/u, process.env.HOME || process.env.USERPROFILE || "~"));
    const found = governedRoot(full);
    if (found) return found;
  }
  return null;
}

async function preToolUse(payload) {
  // Every rule protects mpsf records, so other projects are never touched.
  const root = targetGovernedRoot(payload);
  if (!root) return;
  const verdict = evaluatePreToolUse(payload, {
    env: process.env,
    isUngovernedRepo: (attempt) => isUngovernedRepo(payload.cwd, attempt.dirs, process.env) || isGuardExempt(payload.cwd, attempt),
    isMergeAuthorized: (attempt) => mergeAuthorized(root, payload.cwd, attempt),
    isStoryPushAuthorized: (attempt) => storyPushAuthorized(root, payload.cwd, attempt),
    resolveGitAlias: (name, dirs) => gitAlias(payload.cwd, dirs, name),
    resolveGhAlias: (name) => ghAlias(name),
    readScript: (file) => readAgentScript(payload.cwd, file),
  });
  if (verdict?.decision === "deny") {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const mode = projectMainThreadMode(root);
  const strict = strictMainThreadVerdict(payload, mode, process.env, { roots: governedTreeRoots(root) });
  if (strict) {
    process.stderr.write(`${strict.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const rawWarning = orchestratorEditWarning(payload, mode);
  const warning = rawWarning ? await budgeted(rawWarning, { event: "pre_tool_use", payload, root, pointer: "mpsf wait list" }) : "";
  if (warning) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warning } })}\n`);
}

/** Tells the session to ask for a plugin update when the project's records need a newer version. */
async function pluginUpdateNotice(root) {
  // Returns the notice text ("" when none is due).
  // Loaded here so a problem with it never disables the edit guard.
  const { COMPATIBILITY_DIRECTORY, evaluateRequirements, pluginUpdateLine } = await import("../lib/plugin-compatibility.mjs");
  const directory = path.join(root, ".sdlc", COMPATIBILITY_DIRECTORY);
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return "";
  }
  const entries = names.map((name) => {
    try {
      return { path: name, record: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) };
    } catch {
      return { path: name, record: null };
    }
  });
  const verdict = evaluateRequirements(entries);
  if (verdict.satisfied) return "";
  return `MPSF: ${pluginUpdateLine(verdict.required_plugin_version)}\n`
    + "Tell the user before any other mpsf work: commands that change the project are refused until the plugin is updated.\n";
}

/** Opt-in plugin update (AGENTIC_SDLC_AUTO_UPDATE=1): detached and throttled; never blocks or fails the hook. */
async function autoUpdate(reason) {
  try {
    const { maybeAutoUpdate } = await import("../lib/runtime/auto-update.mjs");
    maybeAutoUpdate({ reason, pluginRoot: PLUGIN_ROOT });
  } catch {
    // an update problem never disables the guard
  }
}

async function sessionStart(payload) {
  await autoUpdate("session-start");
  const root = path.resolve(String(payload.cwd || process.cwd()));
  // The update notice is safety-critical: written first and never deduplicated.
  let notice = "";
  try {
    notice = await pluginUpdateNotice(governedRoot(root) ?? root);
  } catch {
    // The notice is advice; the CLI enforces the check on its own.
  }
  if (notice) process.stdout.write(notice);
  const parts = [];
  const orchestrator = orchestratorSessionContext(projectMainThreadMode(governedRoot(root) ?? root));
  if (orchestrator) parts.push(orchestrator);
  else if (governedRoot(root)) parts.push(STORY_LABEL_INSTRUCTION);
  if (orchestrator || governedRoot(root)) parts.push(PROCESS_HYGIENE_INSTRUCTION, CONTEXT_PACK_INSTRUCTION, WATCH_INSTRUCTION);
  parts.push(...(await standingContext(governedRoot(root) ?? root)));
  const text = parts.filter(Boolean).join("\n");
  if (!text) return;
  const filtered = await budgeted(text, {
    event: "session_start",
    payload,
    root,
    pointer: "mpsf context pack --story <id>",
    extraTokens: Math.ceil(notice.length / 4),
    // After /clear or /compact the agent no longer holds what was injected before.
    forget: payload.source === "clear" || payload.source === "compact",
  });
  if (filtered) process.stdout.write(`${filtered}\n`);
}

/** The standing-approvals summary lines for SessionStart ([] when there are none). */
async function standingContext(root) {
  const standingRoot = path.join(root, ".sdlc", "autonomy", "standing");
  let entries = [];
  try {
    entries = fs.readdirSync(standingRoot).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  const result = spawnSync(process.execPath, [CLI, "autonomy", "standing", "status", "--root", root, "--json", "--json-profile", "full"], {
    encoding: "utf8",
    timeout: STATUS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) return [];
  let status = null;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  return [sessionStartContext(status)];
}

/**
 * Projects whose operational records live on the state branch
 * (lib/state-branch.mjs) sync them in the background: pull and push on their
 * own throttles at session start and at each stop, a final push at session
 * end. Detached, so a slow remote never delays the agent.
 */
function syncStateBranch(payload, args) {
  try {
    const root = governedRoot(payload.cwd);
    if (!root) return;
    // The requirement file `state migrate` commits, or the sdlc-state records adapter in the config.
    const required = fs.existsSync(path.join(root, ".sdlc", "compatibility", "sdlc-state-records.json"));
    if (!required && !fs.readFileSync(path.join(root, ".sdlc", "config.json"), "utf8").includes("\"sdlc-state\"")) return;
    const child = spawn(process.execPath, [CLI, "state", ...args, "--root", root, "--json"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch {
    // Records stay here and go with the next sync.
  }
}

/** Stops this repository's plugin commands that outlived their time limit. Silent, never blocks. */
async function reapRuns(payload, options = {}) {
  const { findGitCommonDir, reapStaleRuns, reapUnregisteredProcesses } = await import("../lib/runtime/run-registry.mjs");
  const commonDir = findGitCommonDir(payload.cwd || process.cwd());
  if (commonDir) reapStaleRuns(commonDir, options);
  reapUnregisteredProcesses(commonDir, options);
}

// Codex caps the SessionEnd hook at 3 seconds: two short SIGTERM waits keep the reap inside it.
// Anything left over is stopped by the next Stop hook or the run watchdog.
const SESSION_END_KILL_AFTER_MS = 800;
const STOP_KILL_AFTER_MS = 2000;

/**
 * Hands back this computer's presence and roles when the session ends, in a
 * detached process: the push does not count against the SessionEnd limit and
 * a cut push only means they lapse on their own.
 */
function releaseInBackground(payload) {
  const root = governedRoot(payload.cwd);
  if (root) runDetached("session-release", root, payload.session_id);
}

/** Runs one event of this hook in a detached process; never throws. */
function runDetached(event, root, sessionId) {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), event, root, String(sessionId ?? "")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    // best effort
  }
}

/** Keeps the agent working while this computer has work in the project (see lib/host-hooks/keep-going.mjs). */
async function keepGoing(payload) {
  const root = governedRoot(payload.cwd);
  if (!root) return;
  const { keepGoingStop } = await import("../lib/host-hooks/keep-going.mjs");
  const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
  const commonDir = findGitCommonDir(root);
  const output = await keepGoingStop(root, payload, { commonDir });
  const { processHygieneAtStop } = await import("../lib/host-hooks/process-hygiene.mjs");
  const { message } = await processHygieneAtStop(root, {
    commonDir,
    pluginRoot: PLUGIN_ROOT,
    // PowerShell's process scan can take many seconds: on Windows the warning comes from a background run, at the next prompt.
    deferWarning: process.platform === "win32" ? () => runDetached("hygiene-warning", root, payload.session_id) : null,
  });
  const merged = message ? { ...output, systemMessage: [output?.systemMessage, message].filter(Boolean).join("\n") } : output;
  if (!merged) return;
  const { filterHookOutput } = await import("../lib/host-hooks/injection-budget.mjs");
  // Only the free-text fields are filtered; decision and reason stay intact.
  const filtered = merged.systemMessage ? await budgeted(merged.systemMessage, { event: "stop", payload, root, pointer: "mpsf wait list" }) : "";
  const shown = filterHookOutput(merged, (text) => (text === merged.systemMessage ? filtered : text));
  if (shown) process.stdout.write(`${JSON.stringify(shown)}\n`);
}

try {
  const event = process.argv[2];
  const payload = readPayload();
  if (event === "pre-tool-use") await preToolUse(payload);
  else if (event === "session-start") {
    syncStateBranch(payload, ["sync", "--if-due"]);
    await sessionStart(payload);
  }
  else if (event === "post-tool-use") await coordinationMessages(payload, "PostToolUse");
  else if (event === "stop") {
    await autoUpdate("stop");
    syncStateBranch(payload, ["sync", "--if-due"]);
    try {
      // Short SIGTERM waits keep the reap and the keep-going decision inside the 15 s Stop limit.
      await reapRuns(payload, { killAfterMs: STOP_KILL_AFTER_MS });
    } finally {
      await keepGoing(payload);
    }
  } else if (event === "session-end") {
    syncStateBranch(payload, ["push"]);
    releaseInBackground(payload);
    await reapRuns(payload, { killAfterMs: SESSION_END_KILL_AFTER_MS });
  } else if (event === "roles-tick") {
    const { rolesTick } = await import("../lib/engine/role-leases.mjs");
    await rolesTick(process.argv[3], { sessionId: process.argv[4] || null, force: true });
  } else if (event === "hygiene-warning") {
    const { processHygieneAtStop } = await import("../lib/host-hooks/process-hygiene.mjs");
    const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
    await processHygieneAtStop(process.argv[3], { commonDir: findGitCommonDir(process.argv[3]), pluginRoot: PLUGIN_ROOT, throttle: false });
  } else if (event === "session-release") {
    const { releaseAtSessionEnd } = await import("../lib/engine/role-leases.mjs");
    releaseAtSessionEnd(process.argv[3], { sessionId: process.argv[4] || null });
  }
  else if (event === "user-prompt-submit") await coordinationMessages(payload, "UserPromptSubmit", pendingProcessWarning);
} catch {
  process.exitCode = 0;
}
