import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/normalizer.mjs";
import { knownErrorHints } from "../../lib/known-errors/hints.mjs";
import { matchKnownErrors, readKnownErrors, readLastFailures } from "../../lib/known-errors/registry.mjs";
import { computeSignature } from "../../lib/known-errors/signature.mjs";
import { createFixtureDir } from "../helpers/test-isolation.mjs";

// TravelOps issue 52: the vitest cache inside a package made the gate fail on every computer.
const VITEST_FAILURE = (story, commit) =>
  `Story ${story} changed packages/engine/.vitest/json/output.json outside the approved requirement write paths (commit ${commit})`;

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function knownError(signature, extra = {}) {
  return {
    kind: "known_error",
    schema_version: "known-error:v1",
    id: signature.id,
    title: "vitest cache in the diff",
    signature: { ...signature, aliases: [] },
    diagnosis: "vitest writes .vitest/ inside the package and the gate sees it as a changed file",
    steps: ["delete packages/engine/.vitest", "add .vitest/ to .gitignore"],
    fix: { safe: true, actions: [{ type: "remove_path", path: "packages/engine/.vitest" }, { type: "gitignore_add", pattern: ".vitest/" }] },
    scope: { repo: null, plugin_versions: { min: "0.1.0", max: null } },
    created_by: { type: "agent", id: "codex" },
    created_at: "2026-10-11T10:00:00.000Z",
    record_hash: "x",
    hash_algorithm: "sha256:stable-json:v1",
    ...extra,
  };
}

function event(id, type, at) {
  return { kind: "known_error_event", schema_version: "known-error-event:v1", known_error_id: id, type, actor: { type: "human" }, at };
}

test("the same failure in different stories and commits has one signature", () => {
  const first = computeSignature({ check: "gate.check", exit_code: 1, message: VITEST_FAILURE("ST-QA-001A", "3fa9c1d2") });
  const second = computeSignature({ check: "gate.check", exit_code: 1, message: VITEST_FAILURE("ST-CAT-002", "9bb1e0aa7") });
  assert.equal(first.key, second.key);
  assert.match(first.id, /^KE-[0-9a-f]{12}$/u);
  assert.equal(first.path, "packages/engine/.vitest/json/output.json");
  assert.equal(first.message, "Story <id> changed <path> outside the approved requirement write paths (commit <hash>)");
  const other = computeSignature({ check: "gate.check", exit_code: 1, message: VITEST_FAILURE("ST-QA-001A", "3fa9c1d2").replace(".vitest", "coverage") });
  assert.notEqual(other.key, first.key);
});

test("states: suspect after a failed fix, stale when unused, out of range, retired", () => {
  const root = createFixtureDir("known-errors-states");
  const sdlc = path.join(root, ".sdlc");
  const signature = computeSignature({ check: "gate.check", exit_code: 1, message: VITEST_FAILURE("ST-A-001", "abc1234") });
  write(root, `.sdlc/known-errors/${signature.id}.json`, knownError(signature));
  write(root, `.sdlc/known-errors/events/${signature.id}/1-worked.json`, event(signature.id, "worked", "2026-10-11T11:00:00.000Z"));
  const now = Date.parse("2026-10-12T00:00:00Z");
  assert.equal(readKnownErrors(sdlc, { now })[0].status, "active");
  assert.equal(readKnownErrors(sdlc, { now: now + 200 * 86400000 })[0].status, "stale");
  assert.equal(readKnownErrors(sdlc, { now, running: "0.0.1" })[0].status, "out_of_range");
  write(root, `.sdlc/known-errors/events/${signature.id}/2-failed.json`, event(signature.id, "failed", "2026-10-11T12:00:00.000Z"));
  const suspect = readKnownErrors(sdlc, { now })[0];
  assert.equal(suspect.status, "suspect");
  assert.equal(suspect.worked, 1);
  assert.equal(suspect.failed, 1);
  assert.equal(suspect.auto_applicable, false);
  assert.equal(matchKnownErrors(readKnownErrors(sdlc, { now }), signature)[0].id, signature.id);
  write(root, `.sdlc/known-errors/events/${signature.id}/3-retired.json`, event(signature.id, "retired", "2026-10-11T13:00:00.000Z"));
  assert.equal(matchKnownErrors(readKnownErrors(sdlc, { now }), signature).length, 0);
});

test("a failed gate shows the known fix and remembers the failure for known-error add", async () => {
  const root = createFixtureDir("known-errors-hints");
  const sdlc = path.join(root, ".sdlc");
  const signature = computeSignature({ check: "gate.check", exit_code: 1, message: VITEST_FAILURE("ST-A-001", "abc1234") });
  write(root, `.sdlc/known-errors/${signature.id}.json`, knownError(signature));
  write(root, `.sdlc/known-errors/events/${signature.id}/1-accepted.json`, event(signature.id, "accepted", "2026-10-11T11:00:00.000Z"));
  const lines = knownErrorHints({
    action: "gate.check",
    options: { story: "ST-B-002" },
    exitCode: 1,
    result: { errors: [VITEST_FAILURE("ST-B-002", "ffee99887"), "Story ST-B-002 has no test evidence"] },
    root,
    sdlcRoot: sdlc,
    config: null,
    now: Date.parse("2026-10-12T00:00:00Z"),
  });
  const text = lines.join("\n");
  assert.match(text, new RegExp(`known error ${signature.id} \\(same signature`, "u"));
  assert.match(text, /delete packages\/engine\/\.vitest/u);
  assert.match(text, new RegExp(`known-error apply --id ${signature.id}`, "u"));
  assert.match(text, /new failure signature KE-[0-9a-f]{12}/u);
  assert.equal(readLastFailures(sdlc).length, 2);
  // The same unknown failure again: no repeated "record it" line.
  const again = knownErrorHints({
    action: "gate.check", options: {}, exitCode: 1, result: { errors: ["Story ST-C-003 has no test evidence"] }, root, sdlcRoot: sdlc, config: null,
  });
  assert.deepEqual(again, []);
  // Disabled by the project.
  assert.deepEqual(knownErrorHints({
    action: "gate.check", options: {}, exitCode: 1, result: { errors: [VITEST_FAILURE("ST-D-004", "1234567")] }, root, sdlcRoot: sdlc,
    config: { host_policy: { known_errors: { enabled: false } } },
  }), []);

  const view = await buildObservatoryViewModel(root, { clock: () => new Date("2026-10-12T00:00:00Z") });
  assert.equal(view.knownErrors.length, 1);
  assert.equal(view.knownErrors[0].id, signature.id);
  assert.equal(view.knownErrors[0].autoApplicable, true);
});
