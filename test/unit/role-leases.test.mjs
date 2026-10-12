import { createBareOrigin, createFixtureDir } from "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assignedHolder, planRoleLease, rendezvousOrder, resolveRole } from "../../lib/coordination-roles.mjs";
import { forgetSharedRefState } from "../../lib/engine/shared-refs.mjs";
import { claimLeaseHolds } from "../../lib/engine/story-waits.mjs";
import { mergeClonePresence, presenceActivity, pushAccepted, readCoordinationCopies, releaseAtSessionEnd, rolesStatus, rolesTick, TICK_MS, TICK_NETWORK_TIMEOUT_ENV, TICK_NETWORK_TIMEOUT_SECONDS, tickNetworkTimeoutSeconds } from "../../lib/engine/role-leases.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

test("rendezvous hashing picks one computer per role and moves little when computers come and go", () => {
  const hosts = ["pc-a", "pc-b", "pc-c", "pc-d"];
  const order = rendezvousOrder("coordinator", hosts);
  assert.deepEqual([...order].sort(), hosts);
  assert.equal(rendezvousOrder("coordinator", [...hosts].reverse())[0], order[0], "order of the input does not matter");
  // Removing a computer that does not hold the role keeps the holder.
  const other = order.find((host) => host !== order[0]);
  assert.equal(assignedHolder("coordinator", { live: hosts.filter((host) => host !== other) }), order[0]);
  // Removing the holder passes the role to the next one.
  assert.equal(assignedHolder("coordinator", { live: hosts.filter((host) => host !== order[0]) }), order[1]);
  // Pinned hosts win, in their order, when alive.
  assert.equal(assignedHolder("coordinator", { live: hosts, pinned: ["pc-x", "pc-c", "pc-a"] }), "pc-c");
  assert.equal(assignedHolder("coordinator", { live: hosts, pinned: ["pc-x"] }), null);
  assert.equal(assignedHolder("coordinator", { live: ["pc-a"] }), "pc-a", "alone, a computer holds every role");
});

test("the lease is taken by the assigned computer, renewed after half of it, handed over only at renewal", () => {
  const leaseMs = 30 * MIN;
  const [first, second] = rendezvousOrder("coordinator", ["pc-a", "pc-b"]);
  assert.deepEqual(planRoleLease({ role: "coordinator", self: first, live: [second], current: null, now: NOW, leaseMs }), { action: "take", role: "coordinator", epoch: 1 });
  assert.equal(planRoleLease({ role: "coordinator", self: second, live: [first], current: null, now: NOW, leaseMs }).action, "none");
  const held = { role: "coordinator", host: second, epoch: 4, expires_at: iso(NOW + 20 * MIN) };
  // A valid lease is respected by everyone, even by the computer that should hold it.
  assert.equal(planRoleLease({ role: "coordinator", self: first, live: [second], current: held, now: NOW, leaseMs }).action, "none");
  // Its holder keeps it until half has passed, then hands it over because the other computer is assigned.
  assert.equal(planRoleLease({ role: "coordinator", self: second, live: [first], current: held, now: NOW, leaseMs }).action, "none");
  assert.deepEqual(planRoleLease({ role: "coordinator", self: second, live: [first], current: held, now: NOW + 6 * MIN, leaseMs }), { action: "release", role: "coordinator", epoch: 5, handover: first });
  // Alone it renews.
  assert.deepEqual(planRoleLease({ role: "coordinator", self: second, live: [], current: held, now: NOW + 6 * MIN, leaseMs }), { action: "renew", role: "coordinator", epoch: 5 });
  // A released or expired lease is taken by the assigned computer.
  assert.equal(planRoleLease({ role: "coordinator", self: first, live: [second], current: { ...held, released: true }, now: NOW, leaseMs }).action, "take");
  assert.equal(planRoleLease({ role: "coordinator", self: first, live: [second], current: { ...held, expires_at: iso(NOW - MIN) }, now: NOW, leaseMs }).epoch, 5);
  // A computer that is not pinned never takes a pinned role.
  assert.equal(planRoleLease({ role: "coordinator", self: "pc-z", live: [], current: null, now: NOW, leaseMs, pinned: ["pc-a"] }).action, "none");
});

test("with automatic roles, the lease holder coordinates and the others do not run reserved actions", () => {
  const lease = { host: "pc-a", expires_at: iso(NOW + 10 * MIN) };
  assert.equal(resolveRole({}, { host: "pc-a", lease, now: NOW }).role, "coordinator");
  assert.equal(resolveRole({}, { host: "pc-b", lease, now: NOW }).may_run_reserved, false);
  assert.equal(resolveRole({}, { host: "pc-b", lease: { ...lease, released: true }, now: NOW }).mode, "everyone");
  assert.equal(resolveRole({}, { host: "pc-b", lease: null, now: NOW }).may_run_reserved, true);
});

test("porcelain push output: a rejected ref is not accepted", () => {
  const out = "To /x\n*\tabc:refs/agentic-sdlc/presence/pc-a\t[new reference]\n!\tdef:refs/agentic-sdlc/roles/coordinator/000002\t[rejected] (stale info)\nDone\n";
  assert.equal(pushAccepted(out, "refs/agentic-sdlc/presence/pc-a"), true);
  assert.equal(pushAccepted(out, "refs/agentic-sdlc/roles/coordinator/000002"), false);
  assert.equal(pushAccepted(out, "refs/other"), false);
});

function clone(bare, host) {
  const dir = createFixtureDir(`roles-${host}-`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".sdlc"));
  fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), JSON.stringify({ orchestration_policy: { coordination: { mode: "auto", remote: "origin", timeout_seconds: 5 } } }));
  return { dir, env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: host } };
}

test("two computers on one remote: one coordinator, both alive, the role moves when its holder leaves", async () => {
  const seed = createFixtureDir("roles-seed-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const bare = createBareOrigin(seed);
  const [first, second] = rendezvousOrder("coordinator", ["pc-a", "pc-b"]);
  const a = clone(bare, first);
  const b = clone(bare, second);
  forgetSharedRefState();
  // The second computer ticks first: alone, it takes both roles.
  const t0 = await rolesTick(b.dir, { env: b.env, now: NOW });
  assert.equal(t0.pushed, true);
  assert.deepEqual(t0.actions.sort(), ["take:coordinator", "take:knowledge"]);
  // The first one joins: it sees the lease and does not take the role.
  const t1 = await rolesTick(a.dir, { env: a.env, now: NOW + MIN });
  assert.equal(t1.pushed, true);
  assert.deepEqual((t1.actions ?? []).filter((item) => item.endsWith(":coordinator")), []);
  const seen = rolesStatus(a.dir, { env: a.env, now: NOW + MIN });
  assert.deepEqual(seen.computers.map((item) => item.host).sort(), [first, second].sort());
  assert.equal(seen.roles.find((item) => item.role === "coordinator").holder, second);
  assert.equal(seen.roles.find((item) => item.role === "coordinator").assigned, first);
  // Throttled between ticks.
  assert.equal((await rolesTick(a.dir, { env: a.env, now: NOW + 2 * MIN })).skipped, "throttled");
  // At renewal time the holder hands over; the assigned computer takes it at its next tick.
  const handover = await rolesTick(b.dir, { env: b.env, now: NOW + 16 * MIN });
  assert.ok(handover.actions.includes("release:coordinator"), JSON.stringify(handover));
  const taken = await rolesTick(a.dir, { env: a.env, now: NOW + 16 * MIN + TICK_MS });
  assert.ok(taken.actions.includes("take:coordinator"), JSON.stringify(taken));
  const after = rolesStatus(b.dir, { env: b.env, now: NOW + 17 * MIN + TICK_MS });
  assert.equal(after.roles.find((item) => item.role === "coordinator").holder, first);
  // The holder disappears (presence and lease lapse): the other one takes the role.
  const later = NOW + 120 * MIN;
  const back = await rolesTick(b.dir, { env: b.env, now: later });
  assert.ok(back.actions.includes("take:coordinator"), JSON.stringify(back));
  assert.equal(readCoordinationCopies(b.dir).leases.coordinator.host, second);
});

test("off or without a shared remote nothing is written", async () => {
  const lone = createFixtureDir("roles-lone-");
  execFileSync("git", ["init", "-q"], { cwd: lone });
  assert.equal((await rolesTick(lone, { env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: "pc-a" }, now: NOW })).skipped, "no shared remote");
  assert.equal((await rolesTick(lone, { env: { AGENTIC_SDLC_ROLES: "off" }, now: NOW, force: true })).skipped, "off");
});

test("at the end of its last session a computer stops being alive and hands back its roles; its stories keep their activity", async () => {
  const seed = createFixtureDir("roles-end-seed-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const bare = createBareOrigin(seed);
  const a = clone(bare, "pc-a");
  const b = clone(bare, "pc-b");
  forgetSharedRefState();
  assert.ok((await rolesTick(a.dir, { env: a.env, now: NOW, sessionId: "s1" })).actions.includes("take:coordinator"));
  await rolesTick(a.dir, { env: a.env, now: NOW + MIN, sessionId: "s2", force: true });
  // Another session of the clone worked a minute ago: nothing is handed back.
  assert.equal(releaseAtSessionEnd(a.dir, { env: a.env, now: NOW + 2 * MIN, sessionId: "s1" }).skipped, "other sessions");
  const end = releaseAtSessionEnd(a.dir, { env: a.env, now: NOW + 3 * MIN, sessionId: "s2" });
  assert.equal(end.pushed, true, JSON.stringify(end));
  assert.deepEqual(end.released.sort(), ["coordinator", "knowledge"]);
  // The other computer sees it gone and takes the roles at its next tick.
  const taken = await rolesTick(b.dir, { env: b.env, now: NOW + 4 * MIN });
  assert.ok(taken.actions.includes("take:coordinator"), JSON.stringify(taken));
  const seen = rolesStatus(b.dir, { env: b.env, now: NOW + 4 * MIN, fetch: false });
  assert.equal(seen.computers.find((item) => item.host === "pc-a").alive, false);
});

test("presence activity: per story when the presence carries it, else the time of the presence", () => {
  const seed = createFixtureDir("roles-activity-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const state = path.join(seed, ".git", "agentic-sdlc");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "roles-state.json"), JSON.stringify({
    local_presence: { at: NOW, stories: ["ST-1", "ST-2"], activity: { "ST-1": iso(NOW - 40 * MIN) } },
  }));
  const seen = presenceActivity(seed);
  assert.equal(seen.get("ST-1"), NOW - 40 * MIN);
  assert.equal(seen.has("ST-2"), false, "listed without activity: nothing renews it");
  fs.writeFileSync(path.join(state, "roles-state.json"), JSON.stringify({ local_presence: { at: NOW, stories: ["st-3"] } }));
  assert.equal(presenceActivity(seed).get("ST-3"), NOW);
});

test("a claim past its recorded expiry holds while a presence shows work on it, within the time to live", () => {
  const root = createFixtureDir("roles-lease-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".git", "agentic-sdlc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "agentic-sdlc", "roles-state.json"), JSON.stringify({
    local_presence: { at: NOW, stories: ["ST-1"], activity: { "ST-1": iso(NOW - 30 * MIN) } },
  }));
  const context = { root, config: { claim_policy: { default_ttl_seconds: 7200 } }, templateConfig: {} };
  const claim = { story_id: "ST-1", branch: "b/ST-1", claimed_at: iso(NOW - 300 * MIN), expires_at: iso(NOW - 180 * MIN) };
  assert.equal(claimLeaseHolds(context, claim, { nowMs: NOW }), true);
  assert.equal(claimLeaseHolds({ ...context }, claim, { nowMs: NOW + 120 * MIN }), false);
});

test("push budget: messages written within the interval wait and leave with the next presence push", async () => {
  const { createGitProvider } = await import("../../lib/messaging/providers/git.mjs");
  const seed = createFixtureDir("roles-budget-seed-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const bare = createBareOrigin(seed);
  const a = clone(bare, "pc-a");
  const env = { ...a.env, AGENTIC_SDLC_PUSH_INTERVAL_SECONDS: "120" };
  forgetSharedRefState();
  const provider = createGitProvider({ now: () => NOW, env });
  const first = await provider.publish({ config: { root: a.dir }, message: { from: "A", text: "one" } });
  const second = await provider.publish({ config: { root: a.dir }, message: { from: "A", text: "two" } });
  assert.equal(first.pending_push, undefined);
  assert.equal(second.pending_push, true);
  const channelCount = () => execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc/channel"], { cwd: bare, encoding: "utf8" }).trim().split("\n")
    .map((ref) => execFileSync("git", ["rev-list", "--count", ref], { cwd: bare, encoding: "utf8" }).trim());
  assert.deepEqual(channelCount(), ["1"]);
  // Local readers see it at once.
  assert.deepEqual((await provider.poll({ config: { root: a.dir }, since: "all" })).map((m) => m.text), ["one", "two"]);
  // The first tick (a presence change: urgent) carries the waiting message in the same push.
  const tick = await rolesTick(a.dir, { env, now: NOW + MIN });
  assert.equal(tick.pushed, true, JSON.stringify(tick));
  assert.equal(tick.messages, 1);
  assert.deepEqual(channelCount(), ["2"]);
});

test("clones of one project on one computer share its presence ref without overwriting each other", () => {
  const entry = (at, stories, activity = {}) => ({ at: iso(at), stories, activity });
  const mine = { clones: { a: entry(NOW - MIN, ["ST-1"], { "ST-1": iso(NOW - 2 * MIN) }), old: entry(NOW - 4 * 24 * 60 * MIN, ["ST-9"]) } };
  const merged = mergeClonePresence({ mine, key: "b", entry: entry(NOW, ["ST-2"], { "ST-2": iso(NOW) }), now: NOW });
  assert.deepEqual(Object.keys(merged.clones).sort(), ["a", "b"], "entries older than three days go");
  assert.deepEqual(merged.stories, ["ST-1", "ST-2"]);
  assert.equal(merged.activity["ST-1"], iso(NOW - 2 * MIN));
  assert.equal(merged.otherLive, true);
  assert.equal(mergeClonePresence({ mine: { clones: { a: { ...entry(NOW - MIN, []), ended: true } } }, key: "b", entry: null, now: NOW }).otherLive, false);
});

test("two clones on one computer: one holds the roles, the end of the other's session releases nothing", async () => {
  const seed = createFixtureDir("roles-clones-seed-");
  execFileSync("git", ["init", "-q"], { cwd: seed });
  const bare = createBareOrigin(seed);
  const a = clone(bare, "pc-x");
  const b = clone(bare, "pc-x");
  forgetSharedRefState();
  assert.ok((await rolesTick(a.dir, { env: a.env, now: NOW, sessionId: "sa" })).actions.includes("take:coordinator"));
  const second = await rolesTick(b.dir, { env: b.env, now: NOW + MIN, sessionId: "sb" });
  assert.deepEqual(second.actions ?? [], [], JSON.stringify(second));
  assert.deepEqual(second.roles, [], "the roles stay with the clone that wrote their lease");
  const ended = releaseAtSessionEnd(b.dir, { env: b.env, now: NOW + 2 * MIN, sessionId: "sb" });
  assert.deepEqual(ended.released, [], JSON.stringify(ended));
  assert.equal(readCoordinationCopies(a.dir).leases.coordinator.host, "pc-x");
  const seen = rolesStatus(a.dir, { env: a.env, now: NOW + 2 * MIN });
  assert.equal(seen.computers.find((item) => item.host === "pc-x").alive, true, "the computer is still there");
  const last = releaseAtSessionEnd(a.dir, { env: a.env, now: NOW + 3 * MIN, sessionId: "sa" });
  assert.deepEqual(last.released.sort(), ["coordinator", "knowledge"]);
});

test("the tick's network limit defaults above the old 3 seconds and follows its variable within bounds", () => {
  assert.equal(tickNetworkTimeoutSeconds({}), TICK_NETWORK_TIMEOUT_SECONDS);
  assert.ok(TICK_NETWORK_TIMEOUT_SECONDS > 3);
  assert.equal(tickNetworkTimeoutSeconds({ [TICK_NETWORK_TIMEOUT_ENV]: "45" }), 45);
  for (const bad of ["0", "-1", "abc", "301", "2.5"]) assert.equal(tickNetworkTimeoutSeconds({ [TICK_NETWORK_TIMEOUT_ENV]: bad }), TICK_NETWORK_TIMEOUT_SECONDS);
});
