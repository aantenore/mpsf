import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, Date, fs, process } from "../runtime/host.mjs";

// Hooks (watch, keep-going) start the stories prepared with `story prepare`
// once their dependency merged. The work itself is `story prepare --resolve`;
// this module only decides whether to run it and reads its answer.

export const PREPARED_STARTS_ENV = "AGENTIC_SDLC_PREPARED_STARTS";
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000;

/** True when some preparation under <root>/.sdlc/prepared-starts still waits for its dependency. */
export function hasWaitingPreparedStarts(root) {
  const directory = path.join(root, ".sdlc", "prepared-starts");
  try {
    return fs.readdirSync(directory).some((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))?.state === "waiting";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Runs `story prepare --resolve` when something waits (never when switched
 * off) and returns the preparations that changed: [{ story_id, outcome }].
 * Never throws; `run` is injectable for tests.
 */
export function resolvePreparedStartsFor(root, { env = process.env, run = null } = {}) {
  if (OFF_VALUES.has(String(env[PREPARED_STARTS_ENV] ?? "").trim().toLowerCase())) return [];
  if (!hasWaitingPreparedStarts(root)) return [];
  try {
    const result = run
      ? run(root)
      : childProcess.spawnSync(process.execPath, [BIN, "story", "prepare", "--resolve", "--json", "--json-profile", "full", "--root", root], { encoding: "utf8", timeout: RESOLVE_TIMEOUT_MS, env });
    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.stdout);
    return (Array.isArray(parsed.results) ? parsed.results : []).filter((item) => item.outcome && !["waiting", "unknown"].includes(item.outcome));
  } catch {
    return [];
  }
}

export const BACKGROUND_RESOLVE_STATE_FILE = "prepared-resolve.json";

/**
 * The Stop hook has a short budget: there `story prepare --resolve` (fetch,
 * worktree realignment, claim) runs detached instead of inline, at most once
 * per RESOLVE_TIMEOUT_MS per clone (a marker under `stateDir`). Its outcome
 * reaches the agent through the story records and the channel announcements.
 * Returns { started, reason? }; never throws. `spawn` is injectable for tests.
 */
export function startPreparedStartsInBackground(root, { env = process.env, stateDir = null, now = Date.now(), spawn = null } = {}) {
  if (OFF_VALUES.has(String(env[PREPARED_STARTS_ENV] ?? "").trim().toLowerCase())) return { started: false, reason: "off" };
  if (!hasWaitingPreparedStarts(root)) return { started: false, reason: "nothing waiting" };
  const marker = stateDir ? path.join(stateDir, BACKGROUND_RESOLVE_STATE_FILE) : null;
  try {
    const last = marker ? Number(JSON.parse(fs.readFileSync(marker, "utf8"))?.at) : NaN;
    if (Number.isFinite(last) && now >= last && now - last < RESOLVE_TIMEOUT_MS) return { started: false, reason: "already running" };
  } catch {
    // no marker yet
  }
  try {
    if (marker) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(marker, `${JSON.stringify({ at: now })}\n`, { mode: 0o600 });
    }
    const args = [BIN, "story", "prepare", "--resolve", "--json", "--root", root];
    const options = { cwd: root, env, detached: true, stdio: "ignore", windowsHide: true };
    const child = (spawn ?? childProcess.spawn)(process.execPath, args, options);
    child?.unref?.();
    return { started: true };
  } catch (error) {
    return { started: false, reason: error?.message || String(error) };
  }
}

export function describePreparedStart(item) {
  if (item.outcome === "started") return `${item.story_id}: dependency integrated, story started (worktree realigned, task start and claim done)`;
  if (item.outcome === "dependency_closed") return `${item.story_id}: dependency closed without merge, the story does not start`;
  return `${item.story_id}: automatic start blocked${item.reason ? ` (${item.reason})` : ""}`;
}
