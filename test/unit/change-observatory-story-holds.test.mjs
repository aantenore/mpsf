import assert from "node:assert/strict";
import test from "node:test";

import {
  STORY_STATES,
  applySharedClaims,
  storyState,
  storyStateCounts,
} from "../../ui/change-observatory/insights.js";
import { setLocale, t } from "../../ui/change-observatory/i18n.js";

const story = (id, state) => ({ id, state, iteration: { id }, phases: [] });

test("a parked story and an expired claim get their own states, never an unknown one", () => {
  assert.equal(storyState({ phases: [], parked: { reason: "merge conflict" } }), "parked");
  assert.equal(storyState({ phases: [], claimExpired: { agent: "codex" } }), "abandoned");
  assert.equal(storyState({ phases: [], parked: { reason: "x" }, closure: { event: "cancelled" } }), "stopped");
  const keys = new Set(STORY_STATES.map((state) => state.key));
  for (const key of ["parked", "abandoned", "waiting", "live"]) assert.ok(keys.has(key), key);
});

// Merged table: the claim cases from the story-holds and scale suites go through one
// applySharedClaims call, so every claim is also mapped to its story by storyId.
test("shared claims from other computers: parked, expired claim, expired reservation, worked on, finished, or untouched", () => {
  const rows = [
    { story: story("ST-1", "open"), claim: { storyId: "ST-1", state: "parked", agent: "codex", reason: "conflict", expired: false }, expected: "parked" },
    { story: story("ST-2", "open"), claim: { storyId: "ST-2", state: "claimed", agent: "codex", holder: "Antonio, mac", expired: true }, expected: "abandoned" },
    { story: story("ST-3", "idle"), claim: { storyId: "ST-3", state: "reserved", agent: "codex", expired: true }, expected: "idle" },
    { story: story("ST-4", "open"), claim: { storyId: "ST-4", state: "claimed", agent: "codex", expired: false }, expected: "live" },
    { story: story("ST-5", "delivered"), claim: { storyId: "ST-5", state: "parked", agent: "codex", expired: false }, expected: "delivered" },
    { story: story("ST-A", "idle"), claim: { storyId: "ST-A", state: "claimed", agent: "agent" }, expected: "live" },
    { story: story("ST-B", "open"), claim: { storyId: "ST-B", state: "completed", completion: "closed" }, expected: "stopped" },
    { story: story("ST-C", "delivered"), claim: { storyId: "ST-C", state: "claimed" }, expected: "delivered" },
    { story: story("ST-D", "idle"), claim: null, expected: "idle" },
  ];
  const input = rows.map((row) => row.story);
  const stories = applySharedClaims(input, rows.flatMap((row) => (row.claim ? [row.claim] : [])));
  const byId = new Map(stories.map((entry) => [entry.id, entry]));
  assert.deepEqual(stories.map((entry) => entry.state), rows.map((row) => row.expected));
  assert.equal(byId.get("ST-3").holder, undefined, "an expired reservation holds nothing");
  assert.equal(byId.get("ST-A").holder.agent, "agent");
  assert.equal(byId.get("ST-C").state, "delivered", "a delivered story keeps its recorded state");
  assert.equal(byId.get("ST-D"), input.at(-1));
  assert.equal(applySharedClaims(input, []), input);
  const counts = storyStateCounts(stories);
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), stories.length);
  assert.equal(counts.parked, 1);
  assert.equal(counts.abandoned, 1);
});

test("the new state labels read in Italian", () => {
  setLocale("it");
  try {
    assert.equal(t("Parked"), "Parcheggiata");
    assert.equal(t("Needs a decision"), "Da decidere");
  } finally {
    setLocale("en");
  }
});
