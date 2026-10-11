import { createFixtureDir } from "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkReservedAction, reservedActionDecision, reservedActionId } from "../../lib/engine/role-guard.mjs";
import { dueRoleDuties, loadRoleDuties, startRoleDuties } from "../../lib/engine/role-duties.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const pinned = (extra = {}) => ({ host_policy: { roles: { coordinator: { hosts: ["pc-a", "pc-b"], ...extra } } } });

test("reserved action ids: a delivery step is named after its action", () => {
  assert.equal(reservedActionId({ canonical_action: "autonomy.delivery.action" }, { action: "pull_request.merge" }), "autonomy.delivery.action:pull_request.merge");
  assert.equal(reservedActionId({ canonical_action: "wait.resolve" }, {}), "wait.resolve");
  assert.equal(reservedActionId(null), null);
});

test("only a pinned coordinator's reserved actions are refused, and only while another computer holds the role", () => {
  const lease = { host: "pc-a", expires_at: iso(NOW + 10 * MIN) };
  const base = { actionId: "wait.resolve", host: "pc-b", lease, now: NOW };
  // Automatic roles block nobody.
  assert.equal(reservedActionDecision({ ...base, config: {} }).allowed, true);
  const refused = reservedActionDecision({ ...base, config: pinned() });
  assert.equal(refused.allowed, false);
  assert.equal(refused.coordinator, "pc-a");
  assert.match(refused.reason, /reserved to the coordinator: pc-a holds the role until 12:10 UTC/u);
  assert.equal(reservedActionDecision({ ...base, config: pinned(), host: "pc-a" }).allowed, true, "the holder runs it");
  assert.equal(reservedActionDecision({ ...base, config: pinned(), actionId: "story.claim" }).allowed, true, "not reserved");
  assert.equal(reservedActionDecision({ ...base, config: pinned(), enabled: false }).allowed, true, "roles off on this computer");
  assert.equal(reservedActionDecision({ ...base, config: pinned(), shared: false }).allowed, true, "no shared remote");
  // Without a valid lease the fallback decides.
  assert.equal(reservedActionDecision({ ...base, config: pinned(), lease: null }).allowed, true, "everyone by default");
  const held = reservedActionDecision({ ...base, config: pinned({ fallback: "hold" }), lease: { ...lease, expires_at: iso(NOW - MIN) } });
  assert.equal(held.allowed, false);
  assert.match(held.reason, /waits for a coordinator: none of pc-a, pc-b/u);
  assert.equal(reservedActionDecision({ ...base, config: pinned({ fallback: "next_host" }), lease: null }).allowed, true, "listed host");
  assert.equal(reservedActionDecision({ ...base, config: pinned({ fallback: "next_host" }), lease: null, host: "pc-z" }).allowed, false);
  // A broken section is left to config validation.
  assert.equal(reservedActionDecision({ ...base, config: { host_policy: { roles: { coordinator: { hosts: [] } } } } }).allowed, true);
});

test("a project without a pinned coordinator never reads the remote for this", () => {
  assert.deepEqual(checkReservedAction({ root: "/nonexistent", config: {}, resolution: { canonical_action: "wait.resolve" } }), { allowed: true });
});

test("role duties: only automatic ones, for roles held, with a command, at most every interval", () => {
  const dir = createFixtureDir("role-duties-");
  const file = path.join(dir, "role-duties.json");
  fs.writeFileSync(file, JSON.stringify({ duties: [
    { role: "coordinator", command: ["coordinator", "free-claims"], every_minutes: 15, auto: true },
    { role: "coordinator", command: ["coordinator", "digest"], every_minutes: 15, auto: false },
    { role: "knowledge", command: ["knowledge", "distill"], every_minutes: 60, auto: true },
    { role: "boss", command: ["x"], every_minutes: 1, auto: true },
    { role: "coordinator", command: ["rm -rf"], every_minutes: 1, auto: true },
    { role: "coordinator", command: ["coordinator", "merge"], every_minutes: 0, auto: true },
  ] }));
  const duties = loadRoleDuties(file);
  assert.deepEqual(duties.map((item) => item.key), ["coordinator-free-claims", "coordinator-digest", "knowledge-distill"]);
  const hasCommand = () => true;
  assert.deepEqual(dueRoleDuties({ duties, roles: ["coordinator"], now: NOW, hasCommand }).map((item) => item.key), ["coordinator-free-claims"]);
  assert.deepEqual(dueRoleDuties({ duties, roles: ["coordinator"], last: { "coordinator-free-claims": NOW - 5 * MIN }, now: NOW, hasCommand }), []);
  assert.deepEqual(dueRoleDuties({ duties, roles: ["coordinator", "knowledge"], now: NOW, hasCommand: (command) => command[0] === "knowledge" }).map((item) => item.key), ["knowledge-distill"]);
  const spawned = [];
  const run = startRoleDuties(dir, { roles: ["coordinator"], env: {}, now: NOW, duties, hasCommand, spawn: (_root, duty) => spawned.push(duty.key) > 0 });
  assert.deepEqual(run.started, ["coordinator-free-claims"]);
  assert.equal(run.last["coordinator-free-claims"], NOW);
  assert.deepEqual(startRoleDuties(dir, { roles: ["coordinator"], env: { AGENTIC_SDLC_ROLE_DUTIES: "off" }, now: NOW, duties, hasCommand, spawn: () => true }).started, []);
  // The plugin's own list loads, and digest, update requests, merges and main-green wait for a person.
  const shipped = loadRoleDuties();
  assert.ok(shipped.length > 0);
  for (const key of ["coordinator-digest", "coordinator-update-requests", "coordinator-merge", "coordinator-main-green"]) {
    assert.equal(shipped.find((item) => item.key === key)?.auto, false, key);
  }
});
