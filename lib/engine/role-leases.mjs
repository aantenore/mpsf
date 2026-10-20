import path from "node:path";

import { console, crypto, Date, fs, process } from "../runtime/host.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { isPlainRecord } from "../canonical.mjs";
import { parseSharedPayload, sealSharedPayload, serializeSharedPayload } from "../shared-ref-records.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { AUTO_ROLES, assignedHolder, coordinatorPolicy, DEFAULT_LEASE_MINUTES, leaseValid, planRoleLease } from "../coordination-roles.mjs";
import { VERSION } from "./definitions.mjs";
import { gitFailure, listLocalRefs, resolveSharedScope, runGit, writeRecordCommit } from "./shared-refs.mjs";
import { hostId } from "../messaging/identity.mjs";
import { hasPendingChannel, takePendingChannelPush } from "../messaging/providers/git.mjs";
import { notePush, pushWindow } from "./push-budget.mjs";

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
 * limit, and runs at most every TICK_MS per clone (sooner only to push
 * channel messages waiting in this clone). The push follows the computer's
 * push budget (./push-budget.mjs) and carries, in the same `git push`, the
 * channel messages waiting in this clone for the same remote. Presence is
 * renewed every PRESENCE_RENEW_MS plus a jitter per computer (up to
 * PRESENCE_JITTER_MS), so computers do not push in step. Without a shared remote,
 * or with AGENTIC_SDLC_ROLES=off, nothing is written and this computer does
 * everything itself, as before.
 */
export const PRESENCE_REF_ROOT = "refs/agentic-sdlc/presence";
export const PRESENCE_TRACKING_ROOT = "refs/agentic-sdlc-shared/presence";
export const ROLE_REF_ROOT = "refs/agentic-sdlc/roles";
export const ROLE_TRACKING_ROOT = "refs/agentic-sdlc-shared/roles";
export const ROLES_ENV = "AGENTIC_SDLC_ROLES";
export const STAND_IN_ENV = "AGENTIC_SDLC_ROLE_STAND_IN";
export const PRESENCE_TTL_MS = 30 * 60_000;
export const PRESENCE_RENEW_MS = 10 * 60_000;
export const PRESENCE_JITTER_MS = 5 * 60_000;
export const TICK_MS = 5 * 60_000;
export const ROLES_STATE_FILE = "roles-state.json";
// Local steps of the tick (reading copies, writing record commits) are quick.
const TICK_TIMEOUT_SECONDS = 3;
/**
 * Network steps of the tick (fetch and push of the coordination refs) run in
 * a detached process, so they can wait longer than a hook: a slow link that
 * cannot push presence within the limit makes this computer look gone.
 * AGENTIC_SDLC_ROLES_TICK_TIMEOUT_SECONDS changes the limit (1-300).
 */
export const TICK_NETWORK_TIMEOUT_ENV = "AGENTIC_SDLC_ROLES_TICK_TIMEOUT_SECONDS";
export const TICK_NETWORK_TIMEOUT_SECONDS = 20;

export function tickNetworkTimeoutSeconds(env = process.env) {
  const raw = String(env[TICK_NETWORK_TIMEOUT_ENV] ?? "").trim();
  const value = /^\d{1,4}$/u.test(raw) ? Number(raw) : NaN;
  return value >= 1 && value <= 300 ? value : TICK_NETWORK_TIMEOUT_SECONDS;
}
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

/**
 * True when `at` (ms) is less than `ms` before `now`. A time in the future
 * (the clock went back) is not recent: throttles never stall on it.
 */
export function recentlyAt(at, ms, now) {
  const since = now - Number(at);
  return Number.isFinite(since) && since >= 0 && since < ms;
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
      // Presence counts only under its own name: a copy under another ref cannot speak for that computer.
      if (!item.trackingRef.endsWith(`/${payload.host}`)) continue;
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

function presenceFields({ host, now, stories, activity = {}, clones = undefined, roles }) {
  return {
    kind: "presence",
    version: 1,
    host,
    at: new Date(now).toISOString(),
    expires_at: new Date(now + PRESENCE_TTL_MS).toISOString(),
    stories: [...stories].sort(),
    // Last sign of work on each story here: what renews its claim for the other computers.
    activity,
    // The same per clone of the project on this computer (stories and activity above cover them all).
    ...(clones ? { clones } : {}),
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

/** A short id of this clone (its git common dir), so clones on one computer share its presence ref. */
export function cloneKey(root) {
  const common = findGitCommonDir(root);
  let resolved = common ?? path.resolve(root);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // as given
  }
  return crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
}

const CLONE_KEEP_MS = 3 * 24 * 3600_000;

/**
 * This computer's presence as one ref for all its clones of the project:
 * the other clones' entries from the fetched copy, this clone's replaced
 * (`entry` null removes it). Returns { clones, stories, activity,
 * otherLive } where stories and activity cover every clone. Pure.
 */
export function mergeClonePresence({ mine = null, key, entry, now = Date.now() }) {
  const previous = isPlainRecord(mine?.clones) ? mine.clones : {};
  const clones = {};
  for (const [name, item] of Object.entries(previous)) {
    const at = Date.parse(String(item?.at ?? ""));
    if (name !== key && isPlainRecord(item) && Number.isFinite(at) && Math.abs(now - at) < CLONE_KEEP_MS) clones[name] = item;
  }
  const otherLive = Object.values(clones).some((item) => Math.abs(now - Date.parse(String(item.at))) < PRESENCE_TTL_MS && item.ended !== true);
  if (entry) clones[key] = entry;
  const stories = new Set();
  const activity = {};
  for (const item of Object.values(clones)) {
    for (const story of Array.isArray(item.stories) ? item.stories : []) stories.add(String(story));
    for (const [story, at] of Object.entries(isPlainRecord(item.activity) ? item.activity : {})) {
      if (!(Date.parse(String(activity[story] ?? "")) >= Date.parse(String(at)))) activity[story] = at;
    }
  }
  return { clones, stories: [...stories].sort(), activity, otherLive };
}

/**
 * The plan of one tick from what is known locally: the leases to write and
 * whether presence must be pushed. Pure apart from reading the config.
 * `sharedHost` says another clone of this computer is alive: a lease held by
 * this computer is then this clone's only when this clone wrote its epoch
 * (`state.owned`).
 */
export function planTick({ config, self, presence, leases, state, stories, now, sharedHost = false }) {
  const live = liveHosts(presence, now);
  const actions = AUTO_ROLES.map((role) => planRoleLease({
    role,
    self,
    live,
    current: leases[role] ?? null,
    now,
    leaseMs: leaseMinutes(config, role) * 60_000,
    pinned: pinnedHosts(config, role),
  })).filter((action) => action.action !== "none" && !(sharedHost && action.action !== "take" && !ownsLease(state, leases[action.role])));
  // Roles this computer holds now; one it is taking shows up at the next renewal, once its lease is in.
  const kept = AUTO_ROLES.filter((role) => {
    const lease = leases[role];
    const action = actions.find((item) => item.role === role);
    return action?.action !== "release" && leaseValid(null, lease, now) && lease.host === self && (!sharedHost || ownsLease(state, lease));
  });
  const last = state.presence ?? {};
  const changed = last.stories !== stories.join(",") || last.roles !== kept.join(",");
  const due = !recentlyAt(last.pushed_at, PRESENCE_RENEW_MS + presenceJitterMs(self), now);
  return { actions, roles: kept, pushPresence: changed || due || actions.length > 0, urgent: changed || actions.length > 0 };
}

function ownsLease(state, lease) {
  return Boolean(lease) && Number(state.owned?.[lease.role]) === Number(lease.epoch);
}

/** A stable delay in [0, PRESENCE_JITTER_MS) for one computer, so renewals spread over time. */
export function presenceJitterMs(host) {
  let hash = 0;
  for (const char of String(host ?? "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % PRESENCE_JITTER_MS;
}

/** True when channel messages wait in this clone and the push budget lets them go. */
function channelWaiting(root, env, now) {
  return hasPendingChannel(root) && pushWindow(root, { now, env }).due;
}

/**
 * The automatic roles held by another computer, with its plugin version and
 * the versions of the live computers: a duty that holder is too old to run
 * is done by a stand-in (lib/engine/role-duties.mjs). A pinned role has no
 * stand-in: a person chose its holder.
 */
export function rolesHeldElsewhere({ config = {}, self, presence = [], leases = {}, now = Date.now() }) {
  const live = new Set(liveHosts(presence, now));
  const versions = Object.fromEntries(presence.filter((item) => live.has(item.host)).map((item) => [item.host, item.plugin_version ?? null]));
  versions[self] = VERSION;
  const held = {};
  for (const role of AUTO_ROLES) {
    const lease = leases[role];
    if (!leaseValid(null, lease, now) || lease.host === self || pinnedHosts(config, role)) continue;
    const holderVersion = presence.find((item) => item.host === lease.host)?.plugin_version ?? null;
    held[role] = { holder: lease.host, holder_version: holderVersion, versions };
  }
  return held;
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
  if (!force && recentlyAt(state.last_tick, TICK_MS, now) && !channelWaiting(root, env, now)) return { skipped: "throttled" };
  // This clone's own activity renews its claims locally, with or without a remote.
  const local = { at: now, ...await heldStories(root, now) };
  writeState(root, { ...state, last_tick: now, local_presence: local });
  if (!rolesEnabled(env)) return { skipped: "off" };
  const target = sharedTarget(root);
  if (!target) return { skipped: "no shared remote" };
  const networkTimeout = tickNetworkTimeoutSeconds(env);
  const fetched = fetchCoordinationRefs(root, target, networkTimeout);
  if (!fetched.fetched) return { skipped: "unreachable", error: fetched.error };
  const self = hostId(env);
  const config = projectConfig(root) ?? {};
  const { presence, leases, epochs } = readCoordinationCopies(root);
  const key = cloneKey(root);
  const merged = mergeClonePresence({
    mine: presence.find((item) => item.host === self),
    key,
    entry: { at: new Date(now).toISOString(), stories: local.stories, activity: local.activity },
    now,
  });
  const { stories, activity, clones } = merged;
  const plan = planTick({ config, self, presence, leases, state: readState(root), stories, now, sharedHost: merged.otherLive });
  // Lease actions and presence changes go at once (backoff aside); renewals and waiting messages follow the spacing.
  const budget = pushWindow(root, { now, env, urgent: plan.urgent });
  const channel = budget.due ? takePendingChannelPush(root, { url: target.url, env, nowMs: now }) : null;
  if (!budget.due || (!plan.pushPresence && !channel)) return { pushed: false, roles: plan.roles, duties: await startDuties(root, plan.roles, { env, now, self, elsewhere: rolesHeldElsewhere({ config, self, presence, leases, now }) }) };
  const context = { root };
  const refspecs = [];
  const leasesArgs = [];
  const commit = writeRecordCommit(context, TICK_TIMEOUT_SECONDS, serializeSharedPayload(presencePayload({ host: self, now, stories, activity, clones, roles: plan.roles })));
  if (commit.error) {
    channel?.done(false);
    return { pushed: false, error: commit.error };
  }
  refspecs.push(`+${commit.objectName}:${presenceRef(self)}`);
  if (channel) refspecs.push(channel.refspec);
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
  const pushed = runGit(root, ["push", "--porcelain", "--no-verify", ...leasesArgs, target.url, ...refspecs], { timeoutSeconds: networkTimeout });
  // A lease refused because another computer created that epoch first is fine: that one holds the role.
  const presenceOk = pushed.ok || pushAccepted(pushed.stdout, presenceRef(self));
  channel?.done(pushed.ok || pushAccepted(pushed.stdout, channel.remoteRef));
  notePush(root, presenceOk ? "ok" : "temporary", { now });
  const latest = readState(root);
  // The epochs this clone wrote: with another clone of this computer alive, only these are its roles.
  const owned = { ...(isPlainRecord(latest.owned) ? latest.owned : {}) };
  for (const action of plan.actions) {
    if (!pushed.ok && !pushAccepted(pushed.stdout, roleLeaseRef(action.role, action.epoch))) continue;
    if (action.action === "release") delete owned[action.role];
    else owned[action.role] = action.epoch;
  }
  if (presenceOk) {
    writeState(root, { ...latest, owned, last_tick: now, presence: { pushed_at: now, stories: stories.join(","), roles: plan.roles.join(",") } });
    fetchCoordinationRefs(root, target);
  }
  return {
    pushed: presenceOk,
    roles: plan.roles,
    actions: plan.actions.map((item) => `${item.action}:${item.role}`),
    ...(channel ? { messages: channel.count } : {}),
    duties: await startDuties(root, plan.roles, { env, now, self, elsewhere: rolesHeldElsewhere({ config, self, presence, leases, now }) }),
    ...(pushed.ok ? {} : { error: gitFailure(pushed) }),
  };
}

/** Starts the duties due for the roles this computer holds (lib/engine/role-duties.mjs); never throws. */
async function startDuties(root, roles, { env, now, self = null, elsewhere = {} }) {
  if (roles.length === 0 && Object.keys(elsewhere).length === 0) return [];
  try {
    const { startRoleDuties } = await import("./role-duties.mjs");
    const result = startRoleDuties(root, { roles, last: readState(root).duties ?? {}, env, now, self, elsewhere });
    if (result.started.length > 0) writeState(root, { ...readState(root), duties: result.last });
    return result.started;
  } catch {
    return [];
  }
}

/**
 * For the host hook, without network: notes the session and says whether a
 * tick is due now, marking it started so the parallel tool calls of the
 * same moment start only one (the hook runs it detached, `force`).
 */
export function claimTickSlot(root, { sessionId = null, now = Date.now(), env = process.env } = {}) {
  const state = noteSession(root, readState(root), sessionId, now);
  // Channel messages waiting for their push window start a tick sooner, one at a time.
  const window = channelWaiting(root, env, now) ? CHANNEL_TICK_GAP_MS : TICK_MS;
  if (recentlyAt(state.last_tick, window, now) || recentlyAt(state.tick_started, window, now)) return false;
  writeState(root, { ...state, tick_started: now });
  return true;
}

const CHANNEL_TICK_GAP_MS = 15_000;

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
  if (recentlyAt(sessions[id], SESSION_NOTE_EVERY_MS, now)) return state;
  const kept = Object.fromEntries(Object.entries(sessions).filter(([, at]) => Math.abs(now - Number(at)) < SESSION_SEEN_MS));
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
    const others = Object.entries(sessions).filter(([key, at]) => key !== id && Math.abs(now - Number(at)) < SESSION_SEEN_MS);
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
    const ownStories = Array.isArray(local.stories) ? local.stories : mine?.stories ?? [];
    const ownActivity = isPlainRecord(local.activity) ? local.activity : isPlainRecord(mine?.activity) ? mine.activity : {};
    // This clone's claims keep their activity; another clone of this computer still alive keeps it alive.
    const merged = mergeClonePresence({
      mine,
      key: cloneKey(root),
      entry: { at: new Date(now).toISOString(), stories: ownStories, activity: ownActivity, ended: true },
      now,
    });
    const context = { root };
    const refspecs = [];
    const leasesArgs = [];
    const fields = presenceFields({ host: self, now, stories: merged.stories, activity: merged.activity, clones: merged.clones, roles: merged.otherLive ? mine?.roles ?? [] : [] });
    const presenceCommit = writeRecordCommit(context, RELEASE_TIMEOUT_SECONDS, serializeSharedPayload(sealSharedPayload(
      merged.otherLive ? { ...fields, expires_at: mine?.expires_at ?? fields.expires_at } : { ...fields, expires_at: new Date(now).toISOString() },
    )));
    if (!presenceCommit.error) refspecs.push(`+${presenceCommit.objectName}:${presenceRef(self)}`);
    const config = projectConfig(root) ?? {};
    const released = [];
    for (const role of AUTO_ROLES) {
      const lease = leases[role];
      // Another clone of this computer still working keeps the roles.
      if (merged.otherLive || !leaseValid(null, lease, now) || lease.host !== self) continue;
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
    // Channel messages still waiting leave with this last push, whatever the spacing.
    const channel = takePendingChannelPush(root, { url: target.url, env, nowMs: now });
    if (channel) refspecs.push(channel.refspec);
    const pushed = runGit(root, ["push", "--porcelain", "--no-verify", ...leasesArgs, target.url, ...refspecs], { timeoutSeconds: RELEASE_TIMEOUT_SECONDS });
    channel?.done(pushed.ok || pushAccepted(pushed.stdout, channel.remoteRef));
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
      .map(([key, at]) => ({ key, last_started_at: new Date(Number(at)).toISOString(), last_result: dutyResult(root, key) })),
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
  // A duty run standing in for a holder whose plugin is too old for it (lib/engine/role-duties.mjs).
  if (!pinned && String(env[STAND_IN_ENV] ?? "") === role) return { holds: true, mode: "stand-in", holder: lease.host };
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

/** The outcome of the last run of a duty that publishes records, or null. */
function dutyResult(root, key) {
  const common = findGitCommonDir(root);
  if (!common) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(common, "agentic-sdlc", "duties", `${key}.result.json`), "utf8"));
  } catch {
    return null;
  }
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
    lines.push(it ? "Compiti avviati qui:" : "Duties started here:");
    for (const item of status.duties) {
      const result = item.last_result;
      const outcome = !result ? "" : result.published ? (it ? ": pubblicato" : ": published") : result.error ? `: ${it ? "non pubblicato" : "not published"}: ${String(result.error).split("\n")[0]}` : "";
      lines.push(`  ${item.key} ${it ? "alle" : "at"} ${clock(item.last_started_at)} UTC${outcome}`);
    }
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
