import assert from "node:assert/strict";
import test from "node:test";

import {
  claimLeaseEndMs,
  classifyClaimHealth,
  currentWaitRecord,
  evaluateWait,
  parseWaitCondition,
} from "../../lib/story-wait-shared-state.mjs";

const PAST = "2020-01-01T00:00:00.000Z";

test("wait conditions, leases, and claim health follow plain rules", () => {
  assert.deepEqual(parseWaitCondition("dep:ST-2"), { kind: "dep", target: "ST-2" });
  assert.deepEqual(parseWaitCondition("person:Which provider?"), { kind: "person", target: "Which provider?" });
  assert.ok(parseWaitCondition("pr:not-a-url").error);
  assert.ok(parseWaitCondition("ticket:1").error);
  const nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const hour = 3_600_000;
  // A push renews the lease for the claim time to live; stale_claim_after_seconds counts from that push too.
  assert.equal(claimLeaseEndMs({ expiresAt: PAST, lastActivityMs: nowMs - hour, ttlSeconds: 86_400 }), nowMs + 23 * hour);
  assert.equal(claimLeaseEndMs({ expiresAt: PAST, lastActivityMs: null, ttlSeconds: 86_400 }), Date.parse(PAST));
  assert.equal(claimLeaseEndMs({ expiresAt: null, claimedAt: PAST, lastActivityMs: nowMs - hour, ttlSeconds: 86_400, staleAfterSeconds: 7_200 }), nowMs + hour);
  const wait = { kind: "dep", target: "ST-2", until: new Date(nowMs + hour).toISOString() };
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "open" }).valid, true);
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "unknown" }).valid, true);
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "resolved" }).ended, "resolved");
  assert.equal(evaluateWait(wait, { nowMs: nowMs + 2 * hour }).ended, "expired");
  const health = (extra) => classifyClaimHealth({ claimedAt: PAST, leaseEndMs: nowMs + hour, lastActivityMs: nowMs - hour, idleAfterSeconds: 14_400, nowMs, ...extra });
  assert.equal(health({}), "active");
  assert.equal(health({ lastActivityMs: nowMs - 5 * hour }), "idle");
  assert.equal(health({ idleAfterSeconds: null, lastActivityMs: nowMs - 5 * hour }), "active");
  assert.equal(health({ leaseEndMs: nowMs - 1 }), "abandoned");
  assert.equal(health({ leaseEndMs: nowMs - 1, wait: { valid: true } }), "waiting");
  // The latest record of the current claim decides; another epoch's wait does not count.
  const records = [
    { id: "WAIT-a", action: "wait", on: { kind: "person", target: "q" }, until: "x", created_at: "2026-01-01T00:00:00Z", claim: { epoch: 1, claimant_id: "c1" } },
    { wait_id: "WAIT-b", action: "clear", created_at: "2026-01-02T00:00:00Z", epoch: 1, claimant_id: "c1" },
    { wait_id: "WAIT-c", action: "wait", on: { kind: "dep", target: "ST-9" }, until: "y", created_at: "2026-01-03T00:00:00Z", epoch: 2, claimant_id: "c2" },
  ];
  assert.equal(currentWaitRecord({ local: [records[0]], shared: [records[1], records[2]], claim: { epoch: 1, claimant_id: "c1" } }), null);
  assert.equal(currentWaitRecord({ local: [records[0]], shared: [], claim: { epoch: 1, claimant_id: "c1" } }).kind, "person");
  assert.equal(currentWaitRecord({ local: [], shared: records.slice(1), claim: { epoch: 2, claimant_id: "c2" } }).target, "ST-9");
});
