import test from "node:test";
import assert from "node:assert/strict";
import { closestNames, levenshtein } from "../../lib/cli/closest-name.mjs";
import { closeCommandMatches } from "../../lib/cli/command-catalog.mjs";

test("a swap of two adjacent characters is one edit", () => {
  assert.equal(levenshtein("josn", "json"), 1);
  assert.equal(levenshtein("status", "status"), 0);
});

test("typos get the nearest names only, unrelated input gets none", () => {
  assert.deepEqual(closestNames("josn", ["json", "host", "root"]), ["json"]);
  assert.deepEqual(closestNames("definitely-unknown", ["json", "host", "root"]), []);
  assert.deepEqual(closeCommandMatches("obsrve"), ["observe"]);
  assert.deepEqual(closeCommandMatches("bogus"), []);
});
