import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRecordSchemaVersion,
  recordSchemaVersion,
  stampRecordSchemaVersion,
  supportedRecordSchemaVersions,
} from "../../lib/record-schema-version.mjs";
import { checkStoryRecords } from "../../lib/coordinator/records-check.mjs";
import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

test("records without schema_version read as format 1", () => {
  assert.equal(recordSchemaVersion({ story_id: "ST-1" }), 1);
  assert.equal(recordSchemaVersion({ schema_version: "0.1.0" }), 1);
  assert.equal(recordSchemaVersion({ schema_version: "requirement:v2" }), 2);
  assert.equal(recordSchemaVersion({ schema_version: "agentic-sdlc.release-artifact-policy.v1" }), 1);
  assert.equal(recordSchemaVersion({ schema_version: 3 }), 3);
  assert.equal(recordSchemaVersion({ schema_version: "free text" }), null);
});

test("supported formats come from the bundled schemas", () => {
  const supported = supportedRecordSchemaVersions();
  assert.equal(supported.get("requirement"), 2);
  assert.equal(supported.get("claim"), 1);
  assert.equal(checkRecordSchemaVersion({ schema_version: "requirement:v2" }).newer, false);
  assert.equal(checkRecordSchemaVersion({ schema_version: "requirement:v9" }).newer, true);
  assert.equal(checkRecordSchemaVersion({ schema_version: "claim:v2" }).newer, true);
  assert.equal(checkRecordSchemaVersion({ id: "ST-1" }, { kind: "story" }).newer, false);
  // Tags no schema declares are never judged newer.
  assert.equal(checkRecordSchemaVersion({ schema_version: "git-commit-coverage:v2" }).newer, false);
});

test("stamping keeps an existing schema_version", () => {
  assert.deepEqual(stampRecordSchemaVersion({ a: 1 }, "claim"), { schema_version: "claim:v1", a: 1 });
  assert.deepEqual(stampRecordSchemaVersion({ schema_version: "x:v2" }, "claim"), { schema_version: "x:v2" });
});

test("claim schema accepts claims with and without the field", () => {
  const claim = { story_id: "ST-1", agent: "a", branch: "b", status: "active", claimed_at: "2026-10-11T00:00:00Z" };
  assert.equal(validateAgainstSchema(claim, "claim.schema.json").valid, true);
  assert.equal(validateAgainstSchema({ schema_version: "claim:v1", ...claim }, "claim.schema.json").valid, true);
});

test("records check warns about records newer than this plugin", () => {
  const base = ".sdlc/stories/ST-1";
  const files = new Map([
    [`${base}/story.json`, JSON.stringify({ id: "ST-1", status: "ready" })],
    [`${base}/claim.json`, JSON.stringify({ schema_version: "claim:v7", story_id: "ST-1" })],
  ]);
  const result = checkStoryRecords({ paths: [...files.keys()], files });
  assert.equal(result.errors, 0);
  assert.deepEqual(result.issues.map((item) => item.code), ["newer_record_format"]);
});
