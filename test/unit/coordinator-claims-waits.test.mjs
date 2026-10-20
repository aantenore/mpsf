import assert from "node:assert/strict";
import test from "node:test";

import { planFreeClaims, planSettleWaits } from "../../lib/engine/coordinator-tasks.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const alive = (host, extra = {}) => ({ host, at: iso(NOW - MIN), expires_at: iso(NOW + 20 * MIN), stories: [], ...extra });
const gone = (host, extra = {}) => ({ host, at: iso(NOW - 90 * MIN), expires_at: iso(NOW - 60 * MIN), stories: [], ...extra });
const abandoned = (id, identity = null) => ({
  id,
  claim_health: { state: "abandoned", lease_expires_at: iso(NOW - 10 * MIN) },
  shared_claim: { holder: { agent: "codex", branch: `feature/${id}`, epoch: 2, claimant_id: "c-1", ...(identity ? { identity } : {}) } },
});

test("free-claims frees only abandoned claims whose holder has no live presence; a person decides otherwise", () => {
  const stories = [
    abandoned("ST-A", { host: "pc-off" }),
    abandoned("ST-B", { host: "pc-on" }),
    abandoned("ST-C"),
    abandoned("ST-D"),
    { id: "ST-E", claim_health: { state: "waiting" }, shared_claim: abandoned("ST-E").shared_claim },
    { id: "ST-F", claim_health: { state: "abandoned" }, shared_claim: null },
  ];
  const presence = [alive("pc-on"), alive("pc-x", { stories: ["ST-D"] }), gone("pc-off", { stories: ["ST-A"] })];
  const plans = Object.fromEntries(planFreeClaims({ stories, presence, now: NOW }).map((item) => [item.story_id, item]));
  assert.equal(plans["ST-A"].action, "free", "holder's presence expired");
  assert.equal(plans["ST-B"].reason, "holder_present");
  assert.equal(plans["ST-C"].action, "free", "no live presence names it");
  assert.deepEqual(plans["ST-D"].present, ["pc-x"]);
  assert.equal(plans["ST-E"], undefined, "a declared wait protects the claim");
  assert.equal(plans["ST-F"].reason, "not_shared");
  // Without any presence known, absence cannot be proved.
  assert.equal(planFreeClaims({ stories: [abandoned("ST-A")], presence: [], now: NOW })[0].reason, "presence_unknown");
  // Only expired copies (the presence fetch failed): stale, not proof of absence.
  assert.equal(planFreeClaims({ stories: [abandoned("ST-A", { host: "pc-off" })], presence: [gone("pc-off")], now: NOW })[0].reason, "presence_unknown");
});

test("settle-waits closes expired explicit waits and stale questions only", () => {
  const waits = [
    { id: "WAIT-1", source: "explicit", state: "expired", until: iso(NOW - MIN), blocker: { type: "person" } },
    { id: "WAIT-2", source: "explicit", state: "open", until: iso(NOW + MIN), blocker: { type: "person" } },
    { id: "WAIT-3", source: "explicit", state: "escalated", until: iso(NOW - MIN), blocker: { type: "person" } },
    { id: "q:10", source: "derived", state: "stale", since: iso(NOW - 3 * 60 * MIN), blocker: { type: "question" } },
    { id: "q:11", source: "derived", state: "expired", since: iso(NOW - 20 * MIN), blocker: { type: "question" } },
    { id: "dep:A->B", source: "derived", state: "open", blocker: { type: "story" } },
  ];
  assert.deepEqual(planSettleWaits(waits, { now: NOW }).map((item) => item.id), ["WAIT-1", "WAIT-3", "q:10"]);
});

test("free-claims does not free a claim whose holder's presence ended only minutes ago", () => {
  const late = (host) => ({ host, at: iso(NOW - 35 * MIN), expires_at: iso(NOW - 5 * MIN), stories: [] });
  const presence = [late("pc-slow"), gone("pc-off"), alive("pc-x")];
  const stories = [abandoned("ST-A", { host: "pc-slow" }), abandoned("ST-B", { host: "pc-off" })];
  const plans = Object.fromEntries(planFreeClaims({ stories, presence, now: NOW }).map((item) => [item.story_id, item]));
  assert.equal(plans["ST-A"].action, "ask");
  assert.equal(plans["ST-A"].reason, "holder_presence_late");
  assert.equal(plans["ST-B"].action, "free");
  assert.equal(planFreeClaims({ stories: stories.slice(0, 1), presence, now: NOW, graceMs: 0 })[0].action, "free");
});
