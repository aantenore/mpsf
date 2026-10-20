import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

test("propertyNames rejects invalid execution-budget metric names", () => {
  const budget = {
    kind: "execution_budget",
    schema_version: "execution-budget:v1",
    budget_id: "budget-property-names",
    scope: { kind: "story", id: "ST-1" },
    limits: {
      "invalid metric": {
        unit: "count",
        hard_limit: "10",
      },
    },
    warning_thresholds_percent: [70, 90],
    completion_reserve_percent: 15,
    limit_policy: {
      on_warning: "continue",
      on_soft_limit: "checkpoint",
      on_hard_limit: "stop",
      on_metering_violation: "stop",
    },
    extensions: {},
    budget_hash: "0".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
  };

  const result = validateAgainstSchema(budget, "execution-budget.schema.json");
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.keyword === "pattern"), true);
});

test("date validation rejects impossible calendars and accepts Gregorian leap years", () => {
  assert.equal(validateFormat("date", "2026-02-31").valid, false);
  assert.equal(validateFormat("date", "2025-02-29").valid, false);
  assert.equal(validateFormat("date", "2100-02-29").valid, false);
  assert.equal(validateFormat("date", "2000-02-29").valid, true);
  assert.equal(validateFormat("date", "0001-01-01").valid, true);
});

test("date-time validation accepts RFC3339 lowercase separators and real leap seconds", () => {
  for (const timestamp of [
    "1963-06-19t08:30:06.283185z",
    "1998-12-31T23:59:60Z",
    "1998-12-31T15:59:60.123-08:00",
    "1999-01-01T00:59:60+01:00",
    "2024-02-29T23:59:59.123+01:30",
  ]) {
    assert.equal(validateFormat("date-time", timestamp).valid, true, timestamp);
  }
});

test("date-time validation rejects impossible fields and misplaced leap seconds", () => {
  for (const timestamp of [
    "2026-02-31T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:00+24:00",
    "1998-12-31T23:59:61Z",
    "1998-12-31T23:58:60Z",
    "1998-12-31T22:59:60Z",
    "1998-12-30T23:59:60Z",
  ]) {
    assert.equal(validateFormat("date-time", timestamp).valid, false, timestamp);
  }
});

function validateFormat(format, value) {
  const schemaDir = path.resolve("test-inline-json-schema");
  const schemaPath = path.join(schemaDir, "format.schema.json");
  return validateAgainstSchema(value, "format.schema.json", {
    schemaDir,
    cache: new Map([[schemaPath, { type: "string", format }]]),
  });
}

test("required and properties look only at own keys, never the prototype", () => {
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-own-keys-"));
  try {
    fs.writeFileSync(path.join(schemaDir, "strict.schema.json"), JSON.stringify({ type: "object", required: ["toString"], properties: { name: { type: "string" } } }));
    fs.writeFileSync(path.join(schemaDir, "open.schema.json"), JSON.stringify({ type: "object", properties: { name: { type: "string" } } }));
    assert.equal(validateAgainstSchema({}, "strict.schema.json", { schemaDir }).valid, false);
    assert.equal(validateAgainstSchema(JSON.parse('{"constructor":"x","__proto__":"y"}'), "open.schema.json", { schemaDir }).valid, true);
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  }
});
