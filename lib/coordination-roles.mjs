import { crypto } from "./runtime/host.mjs";

/**
 * Roles of the computers that work on one project.
 *
 * A coordinator does, once for everyone, what every computer would otherwise
 * repeat: merges pull requests one at a time, publishes records and
 * baselines from one place, asks active computers to update the plugin,
 * settles expired waits and old questions, frees abandoned claims, opens a
 * P1 fix story when the base branch is broken, checks the records for
 * consistency, sends the digest and the welcome, releases the plugin. It
 * gives no orders and blocks nobody. Workers claim their own stories,
 * triage their defects and talk to their own person. A computer can be a
 * worker and hold roles at the same time.
 *
 * Who holds a role: the computer pinned in the configuration below, else
 * the one chosen by rendezvous hashing among the computers alive on the
 * remote (presence refs). The holder keeps a lease (create-only refs, one
 * per epoch); when the chosen computer changes it hands over at the next
 * renewal, and when the holder disappears its lease expires. No message is
 * needed for any of this. See lib/engine/role-leases.mjs.
 *
 * Configuration (`.sdlc/config.json` -> host_policy.roles.coordinator):
 *   hosts             computers allowed to coordinate, in order of preference (host ids)
 *   lease_minutes     how long one coordinator lease lasts before it must be renewed (default 30)
 *   fallback          what happens while no coordinator holds a valid lease:
 *                       everyone   every computer runs the reserved actions, as without roles (default)
 *                       next_host  the first listed computer that acts takes the lease
 *                       hold       reserved actions wait for a coordinator (nothing else stops)
 *   reserved_actions  overrides the default list below
 *
 * Nothing here trusts message text. Who coordinates is decided by the
 * configuration on the base branch and by the lease record in the record
 * store's shared state (create-only, written with the person's own
 * credentials); a message only announces it.
 */
export const ROLE_FALLBACKS = Object.freeze(["everyone", "next_host", "hold"]);
export const DEFAULT_LEASE_MINUTES = 30;
export const COORDINATOR_DUTIES = Object.freeze([
  "merge_pull_requests_serially",
  "publish_records_and_baselines",
  "request_plugin_updates",
  "settle_expired_waits_and_questions",
  "free_abandoned_claims",
  "keep_base_branch_green",
  "check_record_consistency",
  "digest_and_welcome",
  "release_plugin",
]);
// Roles assigned automatically among the computers alive on the remote.
export const AUTO_ROLES = Object.freeze(["coordinator", "knowledge"]);
// Action ids as the commands record them; a step of a delivery is "<command>:<step>".
export const DEFAULT_RESERVED_ACTIONS = Object.freeze([
  "autonomy.delivery.action:pull_request.merge",
  "story.publish-records",
  "baseline.refresh",
  "wait.resolve",
  "story.assign",
  "plugin.release",
]);
const HOST_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

function invalid(message) {
  const error = new Error(message);
  error.code = "ROLES_CONFIG_INVALID";
  throw error;
}

/** The validated coordinator settings, or null when the project has no coordinator. */
export function coordinatorPolicy(projectConfig) {
  const section = projectConfig?.host_policy?.roles?.coordinator;
  if (section === undefined || section === null) return null;
  if (typeof section !== "object" || Array.isArray(section)) invalid("host_policy.roles.coordinator must be an object.");
  const hosts = section.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string" && HOST_PATTERN.test(host))) {
    invalid("host_policy.roles.coordinator.hosts must list at least one host id.");
  }
  if (new Set(hosts).size !== hosts.length) invalid("host_policy.roles.coordinator.hosts lists a host twice.");
  const lease = section.lease_minutes ?? DEFAULT_LEASE_MINUTES;
  if (!Number.isInteger(lease) || lease < 1 || lease > 1440) invalid("host_policy.roles.coordinator.lease_minutes must be an integer from 1 to 1440.");
  const fallback = section.fallback ?? "everyone";
  if (!ROLE_FALLBACKS.includes(fallback)) invalid(`host_policy.roles.coordinator.fallback must be one of ${ROLE_FALLBACKS.join(", ")}.`);
  const reserved = section.reserved_actions ?? DEFAULT_RESERVED_ACTIONS;
  if (!Array.isArray(reserved) || !reserved.every((item) => typeof item === "string" && item.length > 0)) {
    invalid("host_policy.roles.coordinator.reserved_actions must list action ids.");
  }
  return Object.freeze({ hosts: Object.freeze([...hosts]), lease_minutes: lease, fallback, reserved_actions: Object.freeze([...reserved]) });
}

/**
 * True when `lease` ({ host, expires_at }) is not expired at `now` (ms) and,
 * with a policy, held by a listed host. Without a policy (automatic roles)
 * any computer may hold it.
 */
export function leaseValid(policy, lease, now) {
  if (!lease || typeof lease !== "object" || lease.released === true) return false;
  const until = Date.parse(String(lease.expires_at ?? ""));
  return (!policy || policy.hosts.includes(lease.host)) && Number.isFinite(until) && until > now;
}

function rank(role, host) {
  return crypto.createHash("sha256").update(`${role}\n${host}`).digest("hex");
}

/** The computers ordered by rendezvous hashing for `role`: the first one holds it. */
export function rendezvousOrder(role, hosts = []) {
  return [...new Set(hosts.filter((host) => typeof host === "string" && HOST_PATTERN.test(host)))]
    .sort((left, right) => rank(role, right).localeCompare(rank(role, left)) || left.localeCompare(right));
}

/**
 * Who should hold `role` now among the `live` computers: the first live
 * pinned host when hosts are pinned, else the rendezvous winner. Null when
 * no pinned host is alive.
 */
export function assignedHolder(role, { live = [], pinned = null } = {}) {
  if (Array.isArray(pinned) && pinned.length > 0) return pinned.find((host) => live.includes(host)) ?? null;
  return rendezvousOrder(role, live)[0] ?? null;
}

/**
 * What this computer does with the lease of `role` at one tick:
 *   take     no valid lease and this computer is the one assigned: create epoch + 1
 *   renew    it holds the lease, is still assigned and half of it has passed: epoch + 1
 *   release  it holds the lease, half of it has passed and another live computer
 *            is assigned now: epoch + 1 marked released, so that one takes it
 *   none     anything else
 * `current` is the latest lease ({ host, epoch, expires_at, released }) or null.
 */
export function planRoleLease({ role, self, live = [], current = null, now = Date.now(), leaseMs, pinned = null }) {
  const alive = [...new Set([...live, self])];
  if (Array.isArray(pinned) && pinned.length > 0 && !pinned.includes(self)) return { action: "none", role };
  const assigned = assignedHolder(role, { live: alive, pinned });
  const epoch = Number(current?.epoch ?? 0);
  const valid = leaseValid(null, current, now);
  if (valid && current.host === self) {
    // Nothing changes before half of the lease has passed: a computer that joins waits for the renewal.
    if (Date.parse(current.expires_at) - now >= leaseMs / 2) return { action: "none", role };
    if (assigned !== self && assigned !== null) return { action: "release", role, epoch: epoch + 1, handover: assigned };
    return { action: "renew", role, epoch: epoch + 1 };
  }
  if (valid) return { action: "none", role };
  return assigned === self ? { action: "take", role, epoch: epoch + 1 } : { action: "none", role, assigned };
}

/**
 * Who may do what right now. `lease` is the latest coordinator lease read
 * from the record store (or null). Returns
 *   { mode: "everyone" | "coordinated", coordinator, coordinator_missing, role, may_run_reserved, may_take_lease }
 * for `host`. Without a coordinator policy every computer keeps today's flows.
 */
export function resolveRole(projectConfig, { host, lease = null, now = Date.now() } = {}) {
  const policy = coordinatorPolicy(projectConfig);
  if (!policy) {
    // Automatic roles: a computer holding a valid lease coordinates; with none, everyone runs the usual flows.
    if (leaseValid(null, lease, now)) {
      const isCoordinator = lease.host === host;
      return { mode: "auto", coordinator: lease.host, coordinator_missing: false, role: isCoordinator ? "coordinator" : "developer", may_run_reserved: isCoordinator, may_take_lease: isCoordinator };
    }
    return { mode: "everyone", coordinator: null, coordinator_missing: false, role: "developer", may_run_reserved: true, may_take_lease: false };
  }
  const listed = policy.hosts.includes(host);
  if (leaseValid(policy, lease, now)) {
    const isCoordinator = lease.host === host;
    return { mode: "coordinated", coordinator: lease.host, coordinator_missing: false, role: isCoordinator ? "coordinator" : "developer", may_run_reserved: isCoordinator, may_take_lease: isCoordinator };
  }
  const mayRun = policy.fallback === "everyone" || (policy.fallback === "next_host" && listed);
  return {
    mode: "coordinated",
    coordinator: null,
    coordinator_missing: true,
    role: listed ? "coordinator_candidate" : "developer",
    may_run_reserved: mayRun,
    may_take_lease: listed,
  };
}

/** True when `action` (an action id, optionally "<command>:<step>") is reserved to the coordinator. */
export function isReservedAction(projectConfig, action) {
  const policy = coordinatorPolicy(projectConfig);
  if (!policy) return false;
  const text = String(action ?? "");
  return policy.reserved_actions.some((reserved) => reserved === text || (!reserved.includes(":") && text.startsWith(`${reserved}:`)));
}
