import path from "node:path";

import { console, Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { isPlainRecord } from "../canonical.mjs";
import { parseSharedPayload, sealSharedPayload, serializeSharedPayload } from "../shared-ref-records.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { AUTO_ROLES, assignedHolder, coordinatorPolicy, DEFAULT_LEASE_MINUTES, leaseValid, planRoleLease } from "../coordination-roles.mjs";
import { VERSION } from "./definitions.mjs";
import { gitFailure, listLocalRefs, resolveSharedScope, runGit, writeRecordCommit } from "./shared-refs.mjs";
import { hostId } from "../messaging/identity.mjs";

/**
 * Presence of the computers and leases of their roles, kept as refs on the
 * project's remote, outside every branch, with no messaging involved:
 *
 *   refs/agentic-sdlc/presence/<machine id>          one per computer, replaced by its owner at each renewal:
 *                                                   { host, at, expires_at, stories, activity, roles, plugin_version }
 *   refs/agentic-sdlc/roles/<role>/<epoch, 6 digits>  one lease per epoch, created only if it does not exist:
 *                                                   { role, host, epoch, granted_at, expires_at, released }
 *
 * A computer is alive while its presence has not expired; it renews it every
 * PRESENCE_RENEW_MS while the plugin runs on it (hooks and commands), so a
 * computer that is off simply lapses. The role lease protocol is in
 * planRoleLease (lib/coordination-roles.mjs): one computer per role, chosen
 * by pinned configuration or rendezvous hashing, handed over at renewal,
 * lapsing with its holder. Copies are fetched to
 * refs/agentic-sdlc-shared/{presence,roles}/<remote fingerprint>/.
 *
 * One tick is at most one fetch and one push, each bounded by a short time
 * limit, and runs at most every TICK_MS per clone. Without a shared remote,
 * or with AGENTIC_SDLC_ROLES=off, nothing is written and this computer does
 * everything itself, as before.
 */
export const PRESENCE_REF_ROOT = "refs/agentic-sdlc/presence";
export const PRESENCE_TRACKING_ROOT = "refs/agentic-sdlc-shared/presence";
export const ROLE_REF_ROOT = "refs/agentic-sdlc/roles";
export const ROLE_TRACKING_ROOT = "refs/agentic-sdlc-shared/roles";
export const ROLES_ENV = "AGENTIC_SDLC_ROLES";
export const PRESENCE_TTL_MS = 30 * 60_000;
export const PRESENCE_RENEW_MS = 10 * 60_000;
export const TICK_MS = 5 * 60_000;
export const ROLES_STATE_FILE = "roles-state.json";
const TICK_TIMEOUT_SECONDS = 3;
const KEEP_EPOCHS = 3;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const SETTING = "orchestration_policy.coordination";
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/u;

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function projectConfig(root) {
  return readJson(path.join(root, ".sdlc", "config.json"));
}

function statePath(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", ROLES_STATE_FILE) : null;
}

function readState(root) {
  const file = statePath(root);
  return (file && readJson(file)) || {};
}

function writeState(root, state) {
  const file = statePath(root);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Losing it only means one more tick.
  }
}

export function rolesEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env[ROLES_ENV] ?? "").trim().toLowerCase());
}

/** The shared remote, or null when coordination records stay on this computer. */
function sharedTarget(root) {
  try {
    const policy = orchestrationPolicy(projectConfig(root) ?? {}).coordination;
    const target = resolveSharedScope({ root }, policy, SETTING);
    return target.scope === "shared" && !target.unavailable ? { ...target, timeoutSeconds: policy.timeout_seconds } : null;
  } catch {
    return null;
  }
}

/** Pinned hosts of a role from host_policy.roles (only the coordinator has them today), or null. */
function pinnedHosts(config, role) {
  if (role !== "coordinator") return null;
  try {
    return coordinatorPolicy(config)?.hosts ?? null;
  } catch {
    return null;
  }
}

function leaseMinutes(config, role) {
  if (role !== "coordinator") return DEFAULT_LEASE_MINUTES;
  try {
    return coordinatorPolicy(config)?.lease_minutes ?? DEFAULT_LEASE_MINUTES;
  } catch {
    return DEFAULT_LEASE_MINUTES;
  }
}

function trackingRoot(root, fingerprint) {
  return `${root}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

export function presenceRef(host) {
  return `${PRESENCE_REF_ROOT}/${host}`;
}

export function roleLeaseRef(role, epoch) {
  return `${ROLE_REF_ROOT}/${role}/${String(epoch).padStart(6, "0")}`;
}

/** Presence payloads and role leases from the local copies (no network). */
export function readCoordinationCopies(root, { timeoutSeconds = TICK_TIMEOUT_SECONDS } = {}) {
  const listed = listLocalRefs({ root }, [`${PRESENCE_TRACKING_ROOT}/`, `${ROLE_TRACKING_ROOT}/`], timeoutSeconds);
  const presence = new Map();
  const leases = new Map();
  const epochs = Object.fromEntries(AUTO_ROLES.map((role) => [role, []]));
  for (const item of listed.refs ?? []) {
    const payload = parseSharedPayload(item.message);
    if (!isPlainRecord(payload)) continue;
    if (payload.kind === "presence" && SEGMENT.test(String(payload.host ?? ""))) {
      const known = presence.get(payload.host);
      if (!known || String(known.at) < String(payload.at)) presence.set(payload.host, payload);
    } else if (payload.kind === "role_lease" && AUTO_ROLES.includes(payload.role) && Number.isSafeInteger(payload.epoch) && SEGMENT.test(String(payload.host ?? ""))) {
      // A lease counts only under its own name: a copied payload under another epoch is ignored.
      if (!item.trackingRef.endsWith(`/${payload.role}/${String(payload.epoch).padStart(6, "0")}`)) continue;
      epochs[payload.role].push(payload.epoch);
      const known = leases.get(payload.role);
      if (!known || known.epoch < payload.epoch) leases.set(payload.role, payload);
    }
  }
  return { presence: [...presence.values()], leases: Object.fromEntries(leases), epochs };
}

/** The computers whose presence has not expired at `now`. */
export function liveHosts(presence = [], now = Date.now()) {
  return presence.filter((item) => Date.parse(String(item.expires_at ?? "")) > now).map((item) => item.host);
}

/** One fetch of every presence and role ref; local copies follow the remote (changed or removed). */
export function fetchCoordinationRefs(root, target, timeoutSeconds = TICK_TIMEOUT_SECONDS) {
  const fetched = runGit(root, [
    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--prune", target.url,
    `+${PRESENCE_REF_ROOT}/*:${trackingRoot(PRESENCE_TRACKING_ROOT, target.fingerprint)}/*`,
    `+${ROLE_REF_ROOT}/*:${trackingRoot(ROLE_TRACKING_ROOT, target.fingerprint)}/*`,
  ], { timeoutSeconds });
  return fetched.ok ? { fetched: true } : { fetched: false, error: gitFailure(fetched) };
}

function presencePayload(fields) {
  return sealSharedPayload(presenceFields(fields));
}

function presenceFields({ host, now, stories, activity = {}, roles }) {
  return {
    kind: "presence",
    version: 1,
    host,
    at: new Date(now).toISOString(),
    expires_at: new Date(now + PRESENCE_TTL_MS).toISOString(),
    stories: [...stories].sort(),
    // Last sign of work on each story here: what renews its claim for the other computers.
    activity,
    roles: [...roles].sort(),
    plugin_version: VERSION,
  };
}

function leasePayload({ role, host, epoch, now, leaseMs, released = false }) {
  return sealSharedPayload({
    kind: "role_lease",
    version: 1,
    role,
    host,
    epoch,
    granted_at: new Date(now).toISOString(),
    expires_at: new Date(released ? now : now + leaseMs).toISOString(),
    released,
  });
}

/** Stories this clone holds (claim files of its worktrees) and when each was last worked on, best effort. */
async function heldStories(root, now) {
  try {
    const { localActiveClaims } = await import("../messaging/presence.mjs");
    const claims = localActiveClaims(root, { now });
    const activity = {};
    for (const claim of claims) if (Number.isFinite(claim.active_at)) activity[claim.story] = new Date(claim.active_at).toISOString();
    return { stories: claims.map((claim) => claim.story), activity };
  } catch {
    return { stories: [], activity: {} };
  }
}

/**
 * The plan of one tick from what is known locally: the leases to write and
 * whether presence must be pushed. Pure apart from reading the config.
 */
export function planTick({ config, self, presence, leases, state, stories, now }) {
  const live = liveHosts(presence, now);
  const actions = AUTO_ROLES.map((role) => planRoleLease({
    role,
    self,
    live,
    current: leases[role] ?? null,
    now,
    leaseMs: leaseMinutes(config, role) * 60_000,
    pinned: pinnedHosts(config, role),
  })).filter((action) => action.action !== "none");
  // Roles this computer holds now; one it is taking shows up at the next renewal, once its lease is in.
  const kept = AUTO_ROLES.filter((role) => {
    const lease = leases[role];
    const action = actions.find((item) => item.role === role);
    return action?.action !== "release" && leaseValid(null, lease, now) && lease.host === self;
  });
  const last = state.presence ?? {};
  const changed = last.stories !== stories.join(",") || last.roles !== kept.join(",");
  const due = !(now - Number(last.pushed_at) < PRESENCE_RENEW_MS);
  return { actions, roles: kept, pushPresence: changed || due || actions.length > 0 };
}

/** True when `git push --porcelain` output reports `ref` as updated (not rejected). */
export function pushAccepted(stdout, ref) {
  return String(stdout ?? "").split(/\r?\n/u).some((line) => {
    const match = /^([ +\-*=!])\t[^\t]*:(\S+)\t/u.exec(line);
    return match !== null && match[2] === ref && match[1] !== "!";
  });
}

/**
 * One throttled tick for the hooks: fetch, renew this computer's presence,
 * take, renew or hand over its roles. Never throws; returns what it did.
 */
export async function rolesTick(root, { env = process.env, now = Date.now(), force = false, sessionId = null } = {}) {
  const state = noteSession(root, readState(root), sessionId, now);
  if (!force && now - Number(state.last_tick) < TICK_MS) return { skipped: "throttled" };
  // This clone's own activity renews its claims locally, with or without a remote.
  const local = { at: now, ...await heldStories(root, now) };
  writeState(root, { ...state, last_tick: now, local_presence: local });
  if (!rolesEnabled(env)) return { skipped: "off" };
  const target = sharedTarget(root);
  if (!target) return { skipped: "no shared remote" };
  const fetched = fetchCoordinationRefs(root, target);
  if (!fetched.fetched) return { skipped: "unreachable", error: fetched.error };
  const self = hostId(env);
  const config = projectConfig(root) ?? {};
  const { presence, leases, epochs } = readCoordinationCopies(root);
  const { stories, activity } = local;
  const plan = planTick({ config, self, presence, leases, state, stories, now });
  if (!plan.pushPresence) return { pushed: false, roles: plan.roles, duties: await startDuties(root, plan.roles, { env, now }) };
  const context = { root };
  const refspecs = [];
  const leasesArgs = [];
  const commit = writeRecordCommit(context, TICK_TIMEOUT_SECONDS, serializeSharedPayload(presencePayload({ host: self, now, stories, activity, roles: plan.roles })));
  if (commit.error) return { pushed: false, error: commit.error };
  refspecs.push(`+${commit.objectName}:${presenceRef(self)}`);
  for (const action of plan.actions) {
    const lease = writeRecordCommit(context, TICK_TIMEOUT_SECONDS, serializeSharedPayload(leasePayload({
      role: action.role, host: self, epoch: action.epoch, now, leaseMs: leaseMinutes(config, action.role) * 60_000, released: action.action === "release",
    })));
    if (lease.error) continue;
    const ref = roleLeaseRef(action.role, action.epoch);
    leasesArgs.push(`--force-with-lease=${ref}:`);
    refspecs.push(`${lease.objectName}:${ref}`);
    // Old epochs go: only the last few are kept.
    for (const old of epochs[action.role] ?? []) if (old <= action.epoch - KEEP_EPOCHS) refspecs.push(`:${roleLeaseRef(action.role, old)}`);
  }
  const pushed = runGit(root, ["push", "--porcelain", "--no-verify", ...leasesArgs, target.url, ...refspecs], { timeoutSeconds: TICK_TIMEOUT_SECONDS });
  // A lease refused because another computer created that epoch first is fine: that one holds the role.
  const presenceOk = pushed.ok || pushAccepted(pushed.stdout, presenceRef(self));
  const latest = readState(root);
  if (presenceOk) {
    writeState(root, { ...latest, last_tick: now, presence: { pushed_at: now, stories: stories.join(","), roles: plan.roles.join(",") } });
    fetchCoordinationRefs(root, target);
  }
  return {
    pushed: presenceOk,
    roles: plan.roles,
    actions: plan.actions.map((item) => `${item.action}:${item.role}`),
    duties: await startDuties(root, plan.roles, { env, now }),
    ...(pushed.ok ? {} : { error: gitFailure(pushed) }),
  };
}

/** Starts the duties due for the roles this computer holds (lib/engine/role-duties.mjs); never throws. */
async function startDuties(root, roles, { env, now }) {
  if (roles.length === 0) return [];
  try {
    const { startRoleDuties } = await import("./role-duties.mjs");
    const result = startRoleDuties(root, { roles, last: readState(root).duties ?? {}, env, now });
    if (result.started.length > 0) writeState(root, { ...readState(root), duties: result.last });
    return result.started;
  } catch {
    return [];
  }
}

/** Sessions of this clone seen within this window keep its presence and roles at the end of another one. */
export const SESSION_SEEN_MS = 15 * 60_000;
/** The release at the end of a session runs detached from the SessionEnd hook, bounded on its own. */
export const RELEASE_TIMEOUT_SECONDS = 5;
const SESSION_NOTE_EVERY_MS = 60_000;

/** Records that a session of this clone is working (at most once a minute); returns the state to use. */
function noteSession(root, state, sessionId, now) {
  const id = String(sessionId ?? "").trim();
  if (!id) return state;
  const sessions = isPlainRecord(state.sessions) ? state.sessions : {};
  if (now - Number(sessions[id]) < SESSION_NOTE_EVERY_MS) return state;
  const kept = Object.fromEntries(Object.entries(sessions).filter(([, at]) => now - Number(at) < SESSION_SEEN_MS));
  const next = { ...state, sessions: { ...kept, [id]: now } };
  writeState(root, next);
  return next;
}

/**
 * At the end of a session: when no other session of this clone worked in
 * the last SESSION_SEEN_MS, this computer stops being alive at once (its
 * presence is pushed already expired, its per-story activity kept so the
 * claims it holds still run their time to live) and hands back the roles it
 * holds, in one push bounded by RELEASE_TIMEOUT_SECONDS, from local copies
 * only (the hook starts it detached, hooks/agentic-sdlc-guard.mjs). Claims are not released: the same person resumes them, or they lapse
 * like any lease. Never throws; a failed or cut push only means the presence
 * and leases lapse on their own.
 */
export function releaseAtSessionEnd(root, { env = process.env, now = Date.now(), sessionId = null } = {}) {
  try {
    const state = readState(root);
    const id = String(sessionId ?? "").trim();
    const sessions = isPlainRecord(state.sessions) ? state.sessions : {};
    const others = Object.entries(sessions).filter(([key, at]) => key !== id && now - Number(at) < SESSION_SEEN_MS);
    if (id && Object.hasOwn(sessions, id)) {
      const rest = { ...sessions };
      delete rest[id];
      writeState(root, { ...state, sessions: rest });
    }
    if (others.length > 0) return { skipped: "other sessions" };
    if (!rolesEnabled(env)) return { skipped: "off" };
    const target = sharedTarget(root);
    if (!target) return { skipped: "no shared remote" };
    const self = hostId(env);
    const { presence, leases } = readCoordinationCopies(root, { timeoutSeconds: RELEASE_TIMEOUT_SECONDS });
    const mine = presence.find((item) => item.host === self);
    const local = state.local_presence ?? {};
    const stories = Array.isArray(local.stories) ? local.stories : mine?.stories ?? [];
    const activity = isPlainRecord(local.activity) ? local.activity : isPlainRecord(mine?.activity) ? mine.activity : {};
    const context = { root };
    const refspecs = [];
    const leasesArgs = [];
    const presenceCommit = writeRecordCommit(context, RELEASE_TIMEOUT_SECONDS, serializeSharedPayload(sealSharedPayload({
      ...presenceFields({ host: self, now, stories, activity, roles: [] }),
      expires_at: new Date(now).toISOString(),
    })));
    if (!presenceCommit.error) refspecs.push(`+${presenceCommit.objectName}:${presenceRef(self)}`);
    const config = projectConfig(root) ?? {};
    const released = [];
    for (const role of AUTO_ROLES) {
      const lease = leases[role];
      if (!leaseValid(null, lease, now) || lease.host !== self) continue;
      const epoch = lease.epoch + 1;
      const commit = writeRecordCommit(context, RELEASE_TIMEOUT_SECONDS, serializeSharedPayload(leasePayload({
        role, host: self, epoch, now, leaseMs: leaseMinutes(config, role) * 60_000, released: true,
      })));
      if (commit.error) continue;
      leasesArgs.push(`--force-with-lease=${roleLeaseRef(role, epoch)}:`);
      refspecs.push(`${commit.objectName}:${roleLeaseRef(role, epoch)}`);
      released.push(role);
    }
    if (refspecs.length === 0) return { pushed: false };
    const pushed = runGit(root, ["push", "--porcelain", "--no-verify", ...leasesArgs, target.url, ...refspecs], { timeoutSeconds: RELEASE_TIMEOUT_SECONDS });
    const ok = pushed.ok || pushAccepted(pushed.stdout, presenceRef(self));
    // The next session announces itself again at its first tick.
    if (ok) writeState(root, { ...readState(root), last_tick: 0, presence: null });
    return { pushed: ok, released, ...(pushed.ok ? {} : { error: gitFailure(pushed) }) };
  } catch (error) {
    return { pushed: false, error: String(error?.message ?? error) };
  }
}

/**
 * The roles as this clone sees them: live computers, who holds each role,
 * who should, and what this computer is. `fetch` reads the remote first.
 */
export function rolesStatus(root, { env = process.env, now = Date.now(), fetch = true } = {}) {
  const target = sharedTarget(root);
  let note = null;
  if (!target) note = "no shared remote: this computer does everything itself";
  else if (fetch) {
    const fetched = fetchCoordinationRefs(root, target, target.timeoutSeconds);
    if (!fetched.fetched) note = `remote not readable (${fetched.error}): local copies only`;
  }
  const self = hostId(env);
  const config = projectConfig(root) ?? {};
  const { presence, leases } = readCoordinationCopies(root);
  const live = liveHosts(presence, now);
  const roles = AUTO_ROLES.map((role) => {
    const lease = leases[role] ?? null;
    const valid = leaseValid(null, lease, now);
    return {
      role,
      holder: valid ? lease.host : null,
      expires_at: valid ? lease.expires_at : null,
      assigned: assignedHolder(role, { live: [...new Set([...live, self])], pinned: pinnedHosts(config, role) }),
      pinned: pinnedHosts(config, role),
    };
  });
  return {
    self,
    enabled: rolesEnabled(env),
    shared: Boolean(target),
    note,
    // Role duties this clone started by itself (config/role-duties.json), with when.
    duties: Object.entries(readState(root).duties ?? {})
      .filter(([, at]) => Number.isFinite(Number(at)))
      .map(([key, at]) => ({ key, last_started_at: new Date(Number(at)).toISOString() })),
    computers: presence
      .map((item) => ({ host: item.host, alive: live.includes(item.host), at: item.at, expires_at: item.expires_at, stories: item.stories ?? [], roles: item.roles ?? [], plugin_version: item.plugin_version ?? null }))
      .sort((left, right) => String(right.at).localeCompare(String(left.at))),
    roles,
  };
}

/**
 * Whether this computer runs the duties of `role` now, from local copies
 * only (no network): with no shared remote, roles off, or no valid lease,
 * every computer does (mode "everyone", as before roles); with a valid
 * lease only its holder does. Pinned coordinators follow the same lease.
 * Returns { holds, mode, holder }.
 */
export function holdsRole(root, role, { env = process.env, now = Date.now() } = {}) {
  const self = hostId(env);
  if (!rolesEnabled(env) || !sharedTarget(root)) return { holds: true, mode: "everyone", holder: null };
  const lease = readCoordinationCopies(root).leases[role] ?? null;
  if (!leaseValid(null, lease, now)) return { holds: true, mode: "everyone", holder: null };
  const pinned = pinnedHosts(projectConfig(root) ?? {}, role);
  return { holds: lease.host === self, mode: pinned ? "pinned" : "auto", holder: lease.host };
}

/**
 * The current lease of `role` from the copies fetched here, or null; with
 * `fetch`, the remote is read first (one bounded fetch). Null without a
 * shared remote.
 */
export function roleLease(root, role, { fetch = false } = {}) {
  const target = sharedTarget(root);
  if (!target) return null;
  if (fetch) fetchCoordinationRefs(root, target);
  return readCoordinationCopies(root).leases[role] ?? null;
}

/** True when the project shares a remote for coordination (presence, roles). */
export function hasSharedRemote(root) {
  return Boolean(sharedTarget(root));
}

function clock(iso) {
  const at = Date.parse(String(iso ?? ""));
  return Number.isFinite(at) ? new Date(at).toISOString().slice(11, 16) : "?";
}

/** `roles status [--offline] [--json]` */
export async function rolesStatusCommand(options = {}, env = process.env) {
  const root = path.resolve(String(options.root || process.cwd()));
  const status = rolesStatus(root, { env, fetch: options.offline !== true });
  if (options.json === true) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }
  const it = String(options.locale ?? "").trim().toLowerCase().split(/[-_]/u)[0] === "it";
  const lines = [it
    ? `Questo computer: ${status.self}${status.enabled ? "" : ` (ruoli spenti: ${ROLES_ENV}=off)`}`
    : `This computer: ${status.self}${status.enabled ? "" : ` (roles off: ${ROLES_ENV}=off)`}`];
  if (status.note) lines.push(status.note);
  for (const item of status.roles) {
    const holder = item.holder
      ? `${item.holder} ${it ? "fino alle" : "until"} ${clock(item.expires_at)} UTC`
      : (it ? "nessuno: ogni computer fa da sé" : "nobody: every computer acts for itself");
    const next = item.assigned && item.assigned !== item.holder ? (it ? ` (toccherà a ${item.assigned})` : ` (next: ${item.assigned})`) : "";
    lines.push(`${item.role}: ${holder}${next}${item.pinned ? ` [${it ? "fissato" : "pinned"}: ${item.pinned.join(", ")}]` : ""}`);
  }
  if (status.computers.length > 0) {
    lines.push(it ? "Computer:" : "Computers:");
    for (const item of status.computers) {
      const what = [item.stories.length ? `${it ? "story" : "stories"} ${item.stories.join(", ")}` : null, item.roles.length ? `${it ? "ruoli" : "roles"} ${item.roles.join(", ")}` : null].filter(Boolean).join("; ");
      const state = it ? (item.alive ? "attivo" : "assente") : (item.alive ? "active" : "away");
      lines.push(`  ${item.host} ${state}, ${it ? "visto alle" : "seen at"} ${clock(item.at)} UTC, plugin ${item.plugin_version ?? "?"}${what ? `: ${what}` : ""}`);
    }
  }
  if (status.duties.length > 0) {
    lines.push(`${it ? "Compiti avviati qui" : "Duties started here"}: ${status.duties.map((item) => `${item.key} ${it ? "alle" : "at"} ${clock(item.last_started_at)} UTC`).join(", ")}`);
  }
  console.log(lines.join("\n"));
  return status;
}

/**
 * When each story was last worked on by a computer that runs the plugin:
 * Map story id (upper case) -> ms. From the presence refs fetched here
 * (every computer) and this clone's own last tick. A claim's lease is renewed
 * by this activity like by a push (lib/engine/story-waits.mjs). A presence
 * without per-story activity (0.149.1) counts as activity at its time.
 */
export function presenceActivity(root) {
  const seen = new Map();
  const toMs = (value) => {
    const ms = Date.parse(String(value ?? ""));
    return Number.isFinite(ms) ? ms : Number(value);
  };
  const note = ({ stories, activity, at }) => {
    if (!Array.isArray(stories)) return;
    const perStory = isPlainRecord(activity) ? activity : null;
    for (const story of stories) {
      const value = toMs(perStory ? perStory[story] : at);
      if (!Number.isFinite(value)) continue;
      const key = String(story).toUpperCase();
      seen.set(key, Math.max(seen.get(key) ?? -Infinity, value));
    }
  };
  try {
    for (const item of readCoordinationCopies(root).presence) note(item);
  } catch {
    // no git: only the local activity
  }
  const local = readState(root).local_presence;
  if (local) note(local);
  return seen;
}
