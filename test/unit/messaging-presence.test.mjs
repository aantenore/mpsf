import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { alertFor } from "../../lib/messaging/auto.mjs";
import { heartbeatMinutes, heartbeatPeriodic, localActiveClaims, selectPresence, stallHours } from "../../lib/messaging/presence.mjs";
import { claimEndedByRefs, readClaimRefNames } from "../../lib/runtime/claim-refs.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");

test("status when the stories or phases change, never more than once per heartbeat gap", () => {
  const claims = [{ story: "ST-A-001", phase: "implement", phaseSince: NOW - 20 * 60_000 }];
  const status = selectPresence({ claims, now: NOW });
  assert.equal(status.kind, "info");
  assert.equal(status.text, "[auto] status: ST-A-001 in phase implement for 20 min");
  assert.equal(status.set, "ST-A-001:implement");
  assert.equal(selectPresence({ claims, presence: { last_status: NOW - 5 * 60_000 }, now: NOW }), null);
  // Same stories and phases: nothing new to say until the 12-hour refresh.
  assert.equal(selectPresence({ claims, presence: { last_status: NOW - 16 * 60_000, last_set: status.set }, now: NOW }), null);
  assert.ok(selectPresence({ claims, presence: { last_status: NOW - 13 * 3600_000, last_set: status.set }, now: NOW }));
  // A new phase is news.
  const moved = [{ ...claims[0], phase: "verify" }];
  assert.match(selectPresence({ claims: moved, presence: { last_status: NOW - 16 * 60_000, last_set: status.set }, now: NOW }).text, /in phase verify/u);
  // The heartbeat set explicitly keeps the old periodic status; 0 turns it off.
  assert.ok(selectPresence({ claims, presence: { last_status: NOW - 16 * 60_000, last_set: status.set }, now: NOW, periodic: true }));
  assert.equal(selectPresence({ claims, now: NOW, heartbeatMs: 0 }), null);
  assert.equal(heartbeatPeriodic({}), false);
  assert.equal(heartbeatPeriodic({ AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES: "15" }), true);
});

test("one stall notice per story and phase", () => {
  const claims = [{ story: "ST-A-001", phase: "discovery", phaseSince: NOW - 5 * 3600_000 }];
  const presence = { last_status: NOW - 16 * 60_000, last_set: "ST-A-001:discovery" };
  const stall = selectPresence({ claims, presence, now: NOW });
  assert.equal(stall.text, "[auto] status: ST-A-001 stalled in phase discovery for 5 h");
  assert.equal(stall.stalled, "ST-A-001:discovery");
  assert.equal(selectPresence({ claims, presence: { ...presence, stalled: ["ST-A-001:discovery"] }, now: NOW }), null);
  assert.equal(selectPresence({ claims, presence, now: NOW, stallMs: 0 }), null);
  const two = [...claims, { story: "ST-B-001", phase: "implement", phaseSince: NOW - 10 * 60_000 }];
  assert.deepEqual(selectPresence({ claims: two, presence: { ...presence, last_set: "ST-A-001:discovery,ST-B-001:implement" }, now: NOW }).stories, ["ST-A-001", "ST-B-001"]);
  assert.equal(stallHours({}), 4);
  assert.equal(stallHours({ AGENTIC_SDLC_MESSAGING_STALL_HOURS: "0" }), 0);
});

test("offer when the computer becomes free, then at most every 12 hours", () => {
  const offer = selectPresence({ claims: [], now: NOW });
  assert.equal(offer.kind, "offer");
  assert.match(offer.text, /free: can take work or help/u);
  assert.equal(selectPresence({ claims: [], presence: { last_offer: NOW - 2 * 3600_000, last_set: "" }, now: NOW }), null);
  assert.ok(selectPresence({ claims: [], presence: { last_offer: NOW - 13 * 3600_000, last_set: "" }, now: NOW }));
  // Just released its last story: offer right away (after the minimum gap).
  assert.ok(selectPresence({ claims: [], presence: { last_offer: NOW - 2 * 3600_000, last_set: "ST-A-001:release" }, now: NOW }));
  assert.equal(selectPresence({ claims: [], presence: { last_offer: NOW - 5 * 60_000, last_set: "ST-A-001:release" }, now: NOW }), null);
  // An explicit heartbeat keeps the old hourly offer.
  assert.ok(selectPresence({ claims: [], presence: { last_offer: NOW - 2 * 3600_000, last_set: "" }, now: NOW, periodic: true }));
  assert.equal(heartbeatMinutes({}), 15);
  assert.equal(heartbeatMinutes({ AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES: "0" }), 0);
});

test("a claim the claim refs show as released or superseded has ended", () => {
  const claim = (epoch, extra = {}) => ({ status: "active", shared_claim: { scope: "shared", ref: `refs/agentic-sdlc/claims/ST-QA-001D/${epoch}/claim`, remote_fingerprint: "d8f26b3c6fd5b059c87073cc", ...extra } });
  const base = "refs/agentic-sdlc-shared/claims/d8f26b3c6fd5b059/ST-QA-001D";
  assert.equal(claimEndedByRefs(claim("000001"), new Set([`${base}/000001/claim`])), false);
  assert.equal(claimEndedByRefs(claim("000001"), new Set([`${base}/000001/claim`, `${base}/000001/release`])), true);
  assert.equal(claimEndedByRefs(claim("000001"), new Set([`${base}/000002/claim`])), true);
  assert.equal(claimEndedByRefs(claim("000002"), new Set([`${base}/000001/release`, `${base}/000002/claim`])), false);
  assert.equal(claimEndedByRefs(claim("000001"), new Set(["refs/agentic-sdlc-shared/claims/0000000000000000/ST-QA-001D/000001/release"])), false);
  // Epochs are per remote: refs without the claim's fingerprint say nothing about it.
  assert.equal(claimEndedByRefs(claim("000001"), new Set(["refs/agentic-sdlc/claims/ST-QA-001D/000002/claim"])), false);
  assert.equal(claimEndedByRefs(claim("000001", { remote_fingerprint: null }), new Set(["refs/agentic-sdlc/claims/ST-QA-001D/000001/release"])), true);
  assert.equal(claimEndedByRefs({ status: "active", shared_claim: { scope: "local" } }, new Set([`${base}/000001/release`])), false);
  assert.equal(claimEndedByRefs(claim("000001"), null), false);
});

test("local claims drop a stale active snapshot once the release ref exists (loose or packed)", () => {
  for (const packed of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-refs-"));
    const git = path.join(root, ".git");
    fs.mkdirSync(git, { recursive: true });
    const dir = path.join(root, ".sdlc", "stories", "ST-QA-001D");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({
      story_id: "ST-QA-001D", status: "active", branch: "feature/ST-QA-001D",
      claimed_at: new Date(NOW - 60 * 60_000).toISOString(), expires_at: new Date(NOW + 3600_000).toISOString(),
      shared_claim: { scope: "shared", ref: "refs/agentic-sdlc/claims/ST-QA-001D/000001/claim", remote_fingerprint: "d8f26b3c6fd5b059c87073cc" },
    }));
    const args = { now: NOW, branchExists: () => true };
    assert.equal(localActiveClaims(root, args).length, 1);
    const name = "refs/agentic-sdlc-shared/claims/d8f26b3c6fd5b059/ST-QA-001D/000001/release";
    if (packed) fs.writeFileSync(path.join(git, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${"a".repeat(40)} ${name}\n`);
    else {
      fs.mkdirSync(path.dirname(path.join(git, name)), { recursive: true });
      fs.writeFileSync(path.join(git, name), `${"a".repeat(40)}\n`);
    }
    assert.ok(readClaimRefNames(git).has(name));
    assert.deepEqual(localActiveClaims(root, args), []);
  }
});

test("local claims: active, unexpired, on a branch of this clone, with the workflow phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-"));
  const claim = (id, extra) => {
    fs.mkdirSync(path.join(root, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "stories", id, "claim.json"), JSON.stringify({
      story_id: id, status: "active", branch: `b/${id}`, claimed_at: new Date(NOW - 60 * 60_000).toISOString(),
      expires_at: new Date(NOW + 60_000).toISOString(), ...extra,
    }));
  };
  claim("ST-A-001");
  claim("ST-B-001", { status: "released" });
  claim("ST-C-001", { expires_at: new Date(NOW - 1).toISOString() });
  claim("ST-D-001");
  const instance = path.join(root, ".sdlc", "workflows", "instances", "DELIVERY-ST-A-001");
  fs.mkdirSync(instance, { recursive: true });
  fs.writeFileSync(path.join(instance, "instance.json"), JSON.stringify({ metadata: { governance_binding: { story_id: "ST-A-001" } } }));
  fs.writeFileSync(path.join(instance, "checkpoint.json"), JSON.stringify({ current_state: "verify", updated_at: new Date(NOW - 10 * 60_000).toISOString() }));
  const claims = localActiveClaims(root, { now: NOW, branchExists: (branch) => branch !== "b/ST-D-001" });
  assert.deepEqual(claims.map((item) => [item.story, item.phase]), [["ST-A-001", "verify"]]);
  assert.match(selectPresence({ claims, now: NOW }).text, /ST-A-001 in phase verify for 10 min/u);
});

test("[auto] notices for phase, delivery steps, tests and strict gate", () => {
  assert.equal(alertFor("workflow.instance.transition", { id: "W-1", to: "verify" }, { exitCode: 0, extra: { story: "ST-A-001" } }).text, "ST-A-001 entered phase verify.");
  const pr = alertFor("autonomy.delivery.action", { id: "D-1", action: "pull_request.create", outcome: "passed", "pr-url": "https://example.test/pr/1" }, { exitCode: 0, extra: { story: "ST-A-001" } });
  assert.equal(pr.text, "pull request create done for ST-A-001. https://example.test/pr/1");
  assert.equal(alertFor("autonomy.delivery.action", { id: "D-1", action: "git.push", outcome: "failed" }, { exitCode: 0 }), null);
  assert.equal(alertFor("test.record", { story: "ST-A-001", "exit-code": "0", passed: "12", failed: "0" }, { exitCode: 0 }).text, "tests for ST-A-001 passed (12 passed, 0 failed).");
  assert.equal(alertFor("gate.check", { story: "ST-A-001", strict: true }, { exitCode: 0 }).text, "ST-A-001 strict gate passed.");
  assert.equal(alertFor("gate.check", { story: "ST-A-001" }, { exitCode: 0 }), null);
});

test("local claims: one set for the whole clone, a live record wins over a stale worktree copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-wt-"));
  const git = path.join(root, ".git");
  fs.mkdirSync(git, { recursive: true });
  fs.writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/main\n");
  const write = (dir, id, extra) => {
    fs.mkdirSync(path.join(dir, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(dir, ".sdlc", "stories", id, "claim.json"), JSON.stringify({
      story_id: id, status: "active", branch: `story/${id}`, claimed_at: new Date(NOW - 60 * 60_000).toISOString(),
      expires_at: new Date(NOW + 3600_000).toISOString(), ...extra,
    }));
  };
  const worktree = (name, branch) => {
    const dir = path.join(root, "wt", name);
    const meta = path.join(git, "worktrees", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(meta, "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(meta, "gitdir"), `${path.join(dir, ".git")}\n`);
    return dir;
  };
  const one = worktree("one", "story/ST-1");
  const two = worktree("two", "story/ST-2");
  // ST-1: live in the main checkout, an old released copy in its own worktree.
  write(root, "ST-1");
  write(one, "ST-1", { status: "released" });
  // ST-2: only in its own worktree, with its phase there.
  write(two, "ST-2");
  const instance = path.join(two, ".sdlc", "workflows", "instances", "DELIVERY-ST-2");
  fs.mkdirSync(instance, { recursive: true });
  fs.writeFileSync(path.join(instance, "instance.json"), JSON.stringify({ metadata: { governance_binding: { story_id: "ST-2" } } }));
  fs.writeFileSync(path.join(instance, "checkpoint.json"), JSON.stringify({ current_state: "implementation", updated_at: new Date(NOW - 5 * 60_000).toISOString() }));
  const args = { now: NOW, branchExists: () => true };
  for (const from of [root, one, two]) {
    assert.deepEqual(localActiveClaims(from, args).map((item) => [item.story, item.phase]), [["ST-1", null], ["ST-2", "implementation"]]);
  }
});

test("local claims: a claim past its recorded expiry stays live while its work shows activity within the time to live", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-ttl-"));
  fs.mkdirSync(path.join(root, ".sdlc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sdlc", "config.json"), JSON.stringify({ claim_policy: { default_ttl_seconds: 7200 } }));
  const claim = (id) => {
    fs.mkdirSync(path.join(root, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "stories", id, "claim.json"), JSON.stringify({
      story_id: id, status: "active", branch: `b/${id}`, claimed_at: new Date(NOW - 5 * 3600_000).toISOString(),
      expires_at: new Date(NOW - 3 * 3600_000).toISOString(),
    }));
  };
  claim("ST-A-001");
  claim("ST-B-001");
  const worked = { "ST-A-001": NOW - 30 * 60_000, "ST-B-001": NOW - 3 * 3600_000 };
  const args = { now: NOW, branchExists: () => true, activity: (item) => worked[item.story_id] };
  const claims = localActiveClaims(root, args);
  assert.deepEqual(claims.map((item) => [item.story, item.active_at]), [["ST-A-001", NOW - 30 * 60_000]]);
  // Activity in the future of `now` says nothing about `now`.
  assert.deepEqual(localActiveClaims(root, { ...args, activity: () => NOW + 3600_000 }), []);
  // Claims that never expire are not affected.
  fs.writeFileSync(path.join(root, ".sdlc", "config.json"), JSON.stringify({ claim_policy: { default_ttl_seconds: null } }));
  assert.deepEqual(localActiveClaims(root, args), []);
});

test("local claims: an agent working in the story's worktree renews its claim; the story folder's own times do not", async () => {
  const { execFileSync } = await import("node:child_process");
  const { noteWorktreeActivity } = await import("../../lib/runtime/worktree-activity.mjs");
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-work-"));
  execFileSync("git", ["init", "-q", "-b", "b/ST-A-001"], { cwd: root });
  fs.mkdirSync(path.join(root, ".sdlc", "stories", "ST-A-001"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sdlc", "config.json"), JSON.stringify({ claim_policy: { default_ttl_seconds: 7200 } }));
  fs.writeFileSync(path.join(root, ".sdlc", "stories", "ST-A-001", "claim.json"), JSON.stringify({
    story_id: "ST-A-001", status: "active", branch: "b/ST-A-001", claimed_at: new Date(now - 5 * 3600_000).toISOString(), expires_at: new Date(now - 3 * 3600_000).toISOString(),
  }));
  const args = { now: now + 3 * 3600_000, branchExists: () => true };
  // Nothing in git, a fresh story folder: three hours later the claim has lapsed.
  assert.deepEqual(localActiveClaims(root, args), []);
  noteWorktreeActivity(root, now + 2 * 3600_000);
  assert.deepEqual(localActiveClaims(root, args).map((item) => item.story), ["ST-A-001"]);
});
