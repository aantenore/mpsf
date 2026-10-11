import { Date, process } from "../runtime/host.mjs";
import { coordinatorPolicy, isReservedAction, leaseValid, resolveRole } from "../coordination-roles.mjs";
import { hostId } from "../messaging/identity.mjs";
import { hasSharedRemote, roleLease, rolesEnabled, ROLES_ENV, rolesTick } from "./role-leases.mjs";

/**
 * The coordinator's reserved actions, enforced only where a person pinned
 * the coordinator (host_policy.roles.coordinator). Automatic roles block
 * nobody: without a pinned coordinator every computer runs every action, as
 * before roles.
 *
 * With a pinned coordinator, a reserved action (reserved_actions, default
 * DEFAULT_RESERVED_ACTIONS) is refused on this computer while another one
 * holds a valid coordinator lease, and, with fallback `hold`, while nobody
 * does. Without a shared remote there is nobody else to wait for, and
 * AGENTIC_SDLC_ROLES=off turns the check off on this computer.
 */

/** The action id a command run records: "<canonical action>" or "<canonical action>:<step>". */
export function reservedActionId(resolution, options = {}) {
  const action = resolution?.canonical_action;
  if (!action) return null;
  return action === "autonomy.delivery.action" && options.action ? `${action}:${options.action}` : action;
}

function clock(iso) {
  const at = Date.parse(String(iso ?? ""));
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(11, 16)} UTC` : "?";
}

/**
 * `{ allowed, reason?, coordinator? }` for running `actionId` here. Pure
 * apart from what is passed: `lease` is the current coordinator lease (or
 * null), `shared` whether a coordination remote exists.
 */
export function reservedActionDecision({ config, actionId, host, lease = null, shared = true, enabled = true, now = Date.now() }) {
  let policy = null;
  try {
    policy = coordinatorPolicy(config);
  } catch {
    // An invalid section is reported by config validation, not here.
    return { allowed: true };
  }
  if (!policy || !actionId || !isReservedAction(config, actionId) || !enabled || !shared) return { allowed: true };
  const role = resolveRole(config, { host, lease, now });
  if (role.may_run_reserved) return { allowed: true };
  const off = `${ROLES_ENV}=off on this computer turns the check off.`;
  if (role.coordinator) {
    return {
      allowed: false,
      coordinator: role.coordinator,
      reason: `${actionId} is reserved to the coordinator: ${role.coordinator} holds the role until ${clock(lease?.expires_at)}. `
        + `Leave it to the coordinator (hand over the pull request or the records), or have a person change host_policy.roles.coordinator. ${off}`,
    };
  }
  return {
    allowed: false,
    coordinator: null,
    reason: `${actionId} waits for a coordinator: none of ${policy.hosts.join(", ")} holds the role now (host_policy.roles.coordinator.fallback is ${policy.fallback}). `
      + `Everything else goes on; the action runs once a coordinator is back, or a person changes the fallback. ${off}`,
  };
}

/**
 * The decision for this computer, reading the lease from the remote first
 * (one bounded fetch). A pinned host refused only because nobody holds the
 * lease yet takes it now, as its next tick would, and decides again.
 */
export async function checkReservedAction({ root, config, resolution, options = {}, env = process.env, now = Date.now() }) {
  const actionId = reservedActionId(resolution, options);
  let policy = null;
  try {
    policy = coordinatorPolicy(config);
  } catch {
    policy = null;
  }
  if (!policy || !isReservedAction(config, actionId)) return { allowed: true };
  const shared = hasSharedRemote(root);
  const host = hostId(env);
  const enabled = rolesEnabled(env);
  const decide = (lease) => reservedActionDecision({ config, actionId, host, lease, shared, enabled, now });
  const lease = shared ? roleLease(root, "coordinator", { fetch: true }) : null;
  const decision = decide(lease);
  if (decision.allowed || !shared || !enabled || !policy.hosts.includes(host) || leaseValid(policy, lease, now)) return decision;
  await rolesTick(root, { env, now, force: true });
  return decide(roleLease(root, "coordinator"));
}
