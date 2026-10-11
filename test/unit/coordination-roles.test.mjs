import assert from "node:assert/strict";
import test from "node:test";

import { coordinatorPolicy, isReservedAction, resolveRole } from "../../lib/coordination-roles.mjs";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const config = (coordinator) => ({ host_policy: { roles: { coordinator } } });

test("without a coordinator every computer keeps today's flows", () => {
  assert.equal(coordinatorPolicy({}), null);
  const role = resolveRole({}, { host: "pc-a", now: NOW });
  assert.equal(role.mode, "everyone");
  assert.equal(role.may_run_reserved, true);
  assert.equal(isReservedAction({}, "story.publish-records"), false);
});

test("the lease holder is the coordinator; the others develop", () => {
  const settings = config({ hosts: ["pc-a", "pc-b"] });
  const lease = { host: "pc-a", expires_at: "2026-10-11T10:20:00Z" };
  assert.equal(resolveRole(settings, { host: "pc-a", lease, now: NOW }).role, "coordinator");
  const other = resolveRole(settings, { host: "pc-b", lease, now: NOW });
  assert.equal(other.role, "developer");
  assert.equal(other.may_run_reserved, false);
});

test("an expired lease or one held by an unlisted host does not count; the fallback decides", () => {
  const expired = { host: "pc-a", expires_at: "2026-10-11T09:00:00Z" };
  const stranger = { host: "pc-z", expires_at: "2026-10-11T11:00:00Z" };
  for (const lease of [expired, stranger, null]) {
    assert.equal(resolveRole(config({ hosts: ["pc-a"] }), { host: "pc-c", lease, now: NOW }).may_run_reserved, true, "everyone is the default");
    const next = config({ hosts: ["pc-a", "pc-b"], fallback: "next_host" });
    assert.equal(resolveRole(next, { host: "pc-b", lease, now: NOW }).may_take_lease, true);
    assert.equal(resolveRole(next, { host: "pc-c", lease, now: NOW }).may_run_reserved, false);
    assert.equal(resolveRole(config({ hosts: ["pc-a"], fallback: "hold" }), { host: "pc-a", lease, now: NOW }).may_run_reserved, false);
  }
});

test("reserved actions: defaults, a command prefix covers its steps, and the list is configurable", () => {
  const settings = config({ hosts: ["pc-a"] });
  assert.equal(isReservedAction(settings, "autonomy.delivery.action:pull_request.merge"), true);
  assert.equal(isReservedAction(settings, "autonomy.delivery.action:git.push"), false);
  assert.equal(isReservedAction(settings, "story.publish-records"), true);
  assert.equal(isReservedAction(config({ hosts: ["pc-a"], reserved_actions: ["release"] }), "release:plugin"), true);
});

test("invalid settings are refused", () => {
  assert.throws(() => coordinatorPolicy(config({ hosts: [] })), /hosts/u);
  assert.throws(() => coordinatorPolicy(config({ hosts: ["pc-a", "pc-a"] })), /twice/u);
  assert.throws(() => coordinatorPolicy(config({ hosts: ["pc-a"], fallback: "vote" })), /fallback/u);
  assert.throws(() => coordinatorPolicy(config({ hosts: ["pc a"] })), /host id/u);
});
