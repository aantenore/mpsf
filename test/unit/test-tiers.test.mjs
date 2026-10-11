import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  TEST_TIERS_FILE,
  discoverTestFiles,
  loadTestTiers,
  projectRelativePath,
  selectTierPlan,
} from "../../scripts/run-test-suite.mjs";

// Top-level test names written as plain string literals: test("name", ...) or it("name", ...).
const TEST_NAME_PATTERN = /\b(?:test|it)(?:\.(?:only|skip|todo))?\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`)/gu;

function literalTestNames(source) {
  const names = [];
  for (const [, literal] of source.matchAll(TEST_NAME_PATTERN)) {
    const quote = literal[0];
    const body = literal.slice(1, -1);
    names.push(quote === "\"" ? JSON.parse(literal) : body.replace(/\\(.)/gu, "$1"));
  }
  return names;
}

const tiers = loadTestTiers();
const discovered = discoverTestFiles();
const discoveredPaths = discovered.map(projectRelativePath);
const namesByFile = new Map(discovered.map((file) => [
  projectRelativePath(file),
  literalTestNames(fs.readFileSync(file, "utf8")),
]));

test("the test tiers manifest parses and defines the fast tier", () => {
  assert.ok(fs.existsSync(TEST_TIERS_FILE));
  assert.ok(tiers.has("fast"));
  assert.equal(tiers.has("full"), false);
});

for (const [name, tier] of tiers) {
  test(`tier ${name}: every listed path is a discovered test file or folder`, () => {
    for (const entry of [...tier.files, ...tier.exclude, ...tier.smoke.keys()]) {
      const found = entry.endsWith("/")
        ? discoveredPaths.some((relative) => relative.startsWith(entry))
        : discoveredPaths.includes(entry);
      assert.ok(found, `${name}: ${entry}`);
    }
    for (const entry of tier.exclude) {
      assert.ok(
        tier.files.some((selected) => (selected.endsWith("/") ? entry.startsWith(selected) : entry === selected)),
        `${name}: exclude ${entry} removes nothing that files selects`,
      );
    }
    const plan = selectTierPlan(discovered, tier);
    assert.ok(plan.whole.length + plan.smoke.length > 0);
  });

  test(`tier ${name}: every smoke name is a test of exactly its own file`, () => {
    for (const [file, names] of tier.smoke) {
      for (const testName of names) {
        const owners = [...namesByFile]
          .filter(([, fileNames]) => fileNames.includes(testName))
          .map(([relative]) => relative);
        assert.deepEqual(owners, [file], `${name}: ${JSON.stringify(testName)}`);
        assert.equal(
          namesByFile.get(file).filter((candidate) => candidate === testName).length,
          1,
          `${name}: ${JSON.stringify(testName)} is defined more than once in ${file}`,
        );
      }
    }
  });

  test(`tier ${name}: nothing is listed twice`, () => {
    for (const list of [tier.files, tier.exclude, [...tier.smoke.keys()]]) {
      assert.equal(new Set(list).size, list.length);
    }
    const smokeNames = [...tier.smoke.values()].flat();
    assert.equal(new Set(smokeNames).size, smokeNames.length);
    for (const entry of tier.files.filter((selected) => !selected.endsWith("/"))) {
      assert.equal(
        tier.files.some((selected) => selected !== entry && selected.endsWith("/") && entry.startsWith(selected)),
        false,
        `${name}: ${entry} is already covered by a folder entry`,
      );
    }
  });
}
