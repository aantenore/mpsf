import path from "node:path";

import { childProcess, Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { PLUGIN_ROOT } from "../runtime/paths.mjs";
import { assignedHolder, AUTO_ROLES } from "../coordination-roles.mjs";
import { comparePluginVersions } from "../plugin-compatibility.mjs";
import { findCommand } from "../cli/command-catalog.mjs";

/**
 * Runs the duties of the roles this computer holds (config/role-duties.json),
 * from the host hook's roles tick: each duty at most every `every_minutes`,
 * as a detached CLI run, so the hook never waits for it. The last output of
 * each duty is kept in <git common dir>/agentic-sdlc/duties/<duty>.log.
 */
export const ROLE_DUTIES_FILE = path.join(PLUGIN_ROOT, "config", "role-duties.json");
export const ROLE_DUTIES_ENV = "AGENTIC_SDLC_ROLE_DUTIES";
const CLI = path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs");
const BASE_WORKER = path.join(PLUGIN_ROOT, "lib", "engine", "role-duty-worker.mjs");
const OFF_VALUES = new Set(["0", "false", "no", "off"]);
const COMMAND_PART = /^[a-z][a-z0-9-]{0,40}$/u;

/**
 * The valid duties of the plugin config: { key, role, command, every_ms,
 * auto, publish }. Invalid entries are skipped. `publish: "base"` runs the
 * duty in the dedicated base worktree and pushes its records to the base
 * branch (lib/engine/role-duty-worker.mjs) instead of writing into the
 * person's checkout.
 */
export function loadRoleDuties(file = ROLE_DUTIES_FILE) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const duties = [];
  for (const item of Array.isArray(parsed?.duties) ? parsed.duties : []) {
    const command = Array.isArray(item?.command) ? item.command.map(String) : [];
    const minutes = Number(item?.every_minutes);
    if (!AUTO_ROLES.includes(item?.role) || command.length === 0 || !command.every((part) => COMMAND_PART.test(part))) continue;
    if (!Number.isFinite(minutes) || minutes < 1) continue;
    const since = typeof item.since === "string" && comparePluginVersions(item.since, item.since) === 0 ? item.since : null;
    duties.push({ key: command.join("-"), role: item.role, command, every_ms: minutes * 60_000, auto: item.auto === true, publish: item.publish === "base" ? "base" : null, since });
  }
  return duties;
}

export function roleDutiesEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env[ROLE_DUTIES_ENV] ?? "").trim().toLowerCase());
}

/**
 * True when this computer stands in for a role holder whose plugin is older
 * than the duty (`since`): among the live computers recent enough, the one
 * chosen by rendezvous hashing runs it. `elsewhere` comes from
 * rolesHeldElsewhere (lib/engine/role-leases.mjs).
 */
export function standsIn(duty, { self, elsewhere = {} }) {
  const other = elsewhere[duty.role];
  if (!other || !duty.since || !self) return false;
  const holder = comparePluginVersions(other.holder_version, duty.since);
  if (holder !== null && holder >= 0) return false;
  const able = Object.entries(other.versions ?? {})
    .filter(([host, version]) => host !== other.holder && (comparePluginVersions(version, duty.since) ?? -1) >= 0)
    .map(([host]) => host);
  return assignedHolder(duty.role, { live: able }) === self;
}

/** The automatic duties due now for the roles held (or stood in for), among those this plugin has a command for. Pure. */
export function dueRoleDuties({ duties, roles = [], last = {}, now = Date.now(), self = null, elsewhere = {}, hasCommand = (command) => findCommand(command)?.kind === "command" }) {
  return duties.filter((duty) => duty.auto && (roles.includes(duty.role) || standsIn(duty, { self, elsewhere }))
    && hasCommand(duty.command)
    && !(now - Number(last[duty.key]) >= 0 && now - Number(last[duty.key]) < duty.every_ms));
}

function dutiesDir(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", "duties") : null;
}

function spawnDetached(root, duty, env) {
  const dir = dutiesDir(root);
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, `${duty.key}.log`), "w");
  try {
    const args = duty.publish === "base"
      ? [BASE_WORKER, root, duty.key, ...duty.command]
      : [CLI, ...duty.command, "--json", "--root", root];
    childProcess.spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...env, AGENTIC_SDLC_ROLE_DUTY: duty.key, ...(duty.stand_in ? { AGENTIC_SDLC_ROLE_STAND_IN: duty.role } : {}) },
    }).unref();
    return true;
  } finally {
    fs.closeSync(log);
  }
}

/**
 * Starts the duties due for `roles` (the roles whose lease this computer
 * holds). `last` maps duty key -> ms of its last start and is returned
 * updated; the caller keeps it. Never throws.
 */
export function startRoleDuties(root, { roles = [], last = {}, env = process.env, now = Date.now(), duties = loadRoleDuties(), spawn = spawnDetached, hasCommand, self = null, elsewhere = {} } = {}) {
  const next = { ...last };
  if (!roleDutiesEnabled(env)) return { started: [], last: next };
  const started = [];
  for (const due of dueRoleDuties({ duties, roles, last, now, self, elsewhere, ...(hasCommand ? { hasCommand } : {}) })) {
    const duty = roles.includes(due.role) ? due : { ...due, stand_in: true };
    try {
      if (spawn(root, duty, env)) {
        next[duty.key] = now;
        started.push(duty.key);
      }
    } catch {
      // the next tick tries again
    }
  }
  return { started, last: next };
}
