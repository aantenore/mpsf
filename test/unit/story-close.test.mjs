import assert from "node:assert/strict";
import test from "node:test";

test("automatic close is opt-in", async () => {
  const { autoCloseEnabled } = await import("../../lib/engine/story-close.mjs");
  assert.equal(autoCloseEnabled({}, {}), false);
  assert.equal(autoCloseEnabled({}, { AGENTIC_SDLC_AUTO_CLOSE: "1" }), true);
  assert.equal(autoCloseEnabled({ orchestration_policy: { auto_close: true } }, {}), true);
  assert.equal(autoCloseEnabled({ orchestration_policy: { auto_close: true } }, { AGENTIC_SDLC_AUTO_CLOSE: "0" }), false);
});
