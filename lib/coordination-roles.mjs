/**
 * Roles of the computers that work on one project.
 *
 * A coordinator governs and does not develop: it assigns and rebalances
 * stories, merges pull requests one at a time, publishes records and
 * baselines from one place, settles expired waits and questions, releases
 * the plugin, triages defects, keeps the base branch green and checks the
 * records for consistency. Developers develop and deliver up to the pull
 * request, then hand over.
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
  "assign_and_rebalance_stories",
  "merge_pull_requests_serially",
  "publish_records_and_baselines",
  "settle_expired_waits_and_questions",
  "release_plugin",
  "triage_defects",
  "keep_base_branch_green",
  "check_record_consistency",
]);
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

/** True when `lease` ({ host, expires_at }) is held by a listed host and not expired at `now` (ms). */
export function leaseValid(policy, lease, now) {
  if (!policy || !lease || typeof lease !== "object") return false;
  const until = Date.parse(String(lease.expires_at ?? ""));
  return policy.hosts.includes(lease.host) && Number.isFinite(until) && until > now;
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
