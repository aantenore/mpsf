import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compactJsonPayload, createRecordLocator } from "../../lib/context/compact-json.mjs";
import { resolveJsonProfile } from "../../lib/context/compact-output.mjs";
import { createFixtureDir } from "../helpers/test-isolation.mjs";

const AGENT_ENV = { CLAUDECODE: "1" };

const PAYLOAD = {
  status: "active",
  assistant_message: "A long message for a person. ".repeat(40),
  delivery_profile: {
    id: "AUT-PR-1", kind: "delivery_execution_profile", status: "active", profile_hash: "a".repeat(64),
    constraints: { allowed_write_paths: ["src"] }, checkpoints: [{ id: "c1" }], created_at: "2026-10-11T10:00:00Z",
  },
  autonomy_decision: { id: "AUT-DEC-1", decision_hash: "b".repeat(64), effective_level: "checkpointed", details: { deep: true } },
  decision_path: ".sdlc/autonomy/decisions/AUT-DEC-1.json",
  human_guidance: { result: "Approved.", impact: "x", required_decision: "none", protection_boundary: "y", next_action: "Start the delivery.", details: ["d"] },
  story_id: "ST-1",
  receipt_hash: "c".repeat(64),
  warnings: ["w1", "w2", "w3", "w4", "w5", "w6"],
  related: [{ id: "ST-2", title: "t" }],
  correlation_id: "corr-1",
};

test("agent profile keeps outcome, ids, hashes, next, warnings and refs; drops long blocks", () => {
  const root = createFixtureDir("sdlc-compact-json-");
  fs.mkdirSync(path.join(root, ".sdlc", "autonomy", "deliveries"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sdlc", "autonomy", "deliveries", "AUT-PR-1.json"), "{}");
  const agent = compactJsonPayload(PAYLOAD, { locate: createRecordLocator(root) });
  assert.equal(agent.profile, "agent");
  assert.equal(agent.status, "active");
  assert.equal(agent.outcome, "Approved.");
  assert.equal(agent.next, "Start the delivery.");
  assert.deepEqual(agent.ids, { related: ["ST-2"], story_id: "ST-1" });
  assert.deepEqual(agent.hashes, { receipt_hash: "c".repeat(64) });
  assert.equal(agent.records.delivery_profile.ref, "rec:.sdlc/autonomy/deliveries/AUT-PR-1.json");
  assert.equal(agent.records.delivery_profile.profile_hash, "a".repeat(64));
  assert.equal("constraints" in agent.records.delivery_profile, false);
  assert.equal(agent.records.autonomy_decision.ref, undefined);
  assert.deepEqual(agent.refs, ["context get rec:.sdlc/autonomy/decisions/AUT-DEC-1.json"]);
  assert.equal(agent.warnings.length, 5);
  for (const key of ["assistant_message", "human_guidance", "warnings[5:]"]) assert.ok(agent.omitted.includes(key), key);
  assert.equal(agent.full, "--json-profile full");
  assert.equal(agent.correlation_id, "corr-1");
  assert.ok(JSON.stringify(agent).length < JSON.stringify(PAYLOAD).length / 2);
  assert.deepEqual(compactJsonPayload(PAYLOAD, { locate: createRecordLocator(root) }), agent);
  assert.deepEqual(Object.keys(agent), [...Object.keys(agent)].sort());
});

test("json profile precedence", () => {
  assert.equal(resolveJsonProfile({ options: { "json-profile": "full" }, env: AGENT_ENV }), "full");
  assert.equal(resolveJsonProfile({ options: { "json-profile": "agent" }, env: {} }), "agent");
  assert.equal(resolveJsonProfile({ options: { verbose: true }, env: AGENT_ENV }), "full");
  assert.equal(resolveJsonProfile({ options: { compact: true }, env: {} }), "agent");
  assert.equal(resolveJsonProfile({ options: {}, env: { AGENTIC_SDLC_JSON_PROFILE: "full", ...AGENT_ENV } }), "full");
  assert.equal(resolveJsonProfile({ options: {}, env: { AGENTIC_SDLC_OUTPUT: "compact" } }), "agent");
  assert.equal(resolveJsonProfile({ options: {}, env: { AGENTIC_SDLC_OUTPUT: "full", ...AGENT_ENV } }), "full");
  assert.equal(resolveJsonProfile({ options: {}, env: {}, policy: { output: { json_profile: "agent" } } }), "agent");
  assert.equal(resolveJsonProfile({ options: {}, env: AGENT_ENV, policy: { output: { json_profile: "auto" } } }), "agent");
  assert.equal(resolveJsonProfile({ options: {}, env: {} }), "full");
});

test("a decision for a person keeps the message written for them", () => {
  const payload = {
    status: "checkpoint_required",
    assistant_message: "Please choose how I work on this pull request.",
    approval_requests: [{ id: "REQ-APPROVAL-1", kind: "delivery" }],
    human_guidance: { result: "Waiting.", required_decision: "Choose the working mode.", next_action: "Answer the question." },
  };
  const agent = compactJsonPayload(payload);
  assert.equal(agent.assistant_message, payload.assistant_message);
  assert.equal(agent.decide, "Choose the working mode.");
  assert.deepEqual(agent.ids, { approval_requests: ["REQ-APPROVAL-1"] });
  const none = compactJsonPayload({ ...payload, approval_requests: [], human_guidance: { ...payload.human_guidance, required_decision: "No decision is needed now." } });
  assert.equal(none.assistant_message, undefined);
  assert.equal(none.decide, undefined);
});
