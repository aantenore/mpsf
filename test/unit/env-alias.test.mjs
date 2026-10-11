import assert from "node:assert/strict";
import test from "node:test";

import { applyEnvAliases } from "../../lib/runtime/env-alias.mjs";

test("MPSF_* variables fill the matching AGENTIC_SDLC_* ones, an explicit old value wins", () => {
  const env = applyEnvAliases({ MPSF_OUTPUT: "json", MPSF_ROLES: "off", AGENTIC_SDLC_ROLES: "on", MPSF_: "x" });
  assert.equal(env.AGENTIC_SDLC_OUTPUT, "json");
  assert.equal(env.AGENTIC_SDLC_ROLES, "on");
  assert.equal(env.AGENTIC_SDLC_, undefined);
});
