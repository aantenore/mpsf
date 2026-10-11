import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STRIPPED_ENV,
  DEFAULT_TEST_CONCURRENCY,
  MAX_TEST_CONCURRENCY,
  SHARD_WEIGHTS_FILE,
  SHARD_WEIGHTS_SCHEMA,
  TEST_CONCURRENCY_ENV,
  TEST_SHARD_ENV,
  TEST_STRIP_ENV,
  TEST_TIERS_FILE,
  TEST_TIERS_SCHEMA,
  TEST_TIER_ENV,
  applyRunnerArguments,
  discoverTestFiles,
  loadShardWeights,
  loadTestTiers,
  main,
  medianWeight,
  parseShardWeights,
  parseStrippedEnv,
  parseTestConcurrency,
  parseTestShard,
  parseTestTier,
  parseTestTiers,
  partitionTestFiles,
  projectRelativePath,
  selectShardFiles,
  selectTierPlan,
} from "../../scripts/run-test-suite.mjs";
import { NODE_ENGINE_RANGE } from "../../lib/runtime-support.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("test concurrency defaults to two, accepts positive integers, and caps large requests", () => {
  assert.equal(DEFAULT_TEST_CONCURRENCY, 2);
  assert.equal(MAX_TEST_CONCURRENCY, 8);
  assert.equal(TEST_CONCURRENCY_ENV, "AGENTIC_SDLC_TEST_CONCURRENCY");
  assert.equal(parseTestConcurrency(undefined), 2);
  assert.equal(parseTestConcurrency("1"), 1);
  assert.equal(parseTestConcurrency("4"), 4);
  assert.equal(parseTestConcurrency("8"), 8);
  assert.equal(parseTestConcurrency("9"), 8);
  assert.equal(parseTestConcurrency("999999999999999999999999"), 8);
});

test("test concurrency rejects malformed or non-positive values", () => {
  for (const value of ["", "0", "-1", "+2", "1.5", " 2", "2 ", "two"]) {
    assert.throws(
      () => parseTestConcurrency(value),
      new RegExp(`${TEST_CONCURRENCY_ENV} must be a positive integer`, "u"),
    );
  }
  assert.throws(
    () => parseTestConcurrency(2),
    new RegExp(`${TEST_CONCURRENCY_ENV} must be a positive integer`, "u"),
  );
});

test("npm test uses the supported bounded programmatic runner", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );

  assert.equal(packageJson.engines.node, NODE_ENGINE_RANGE);
  assert.equal(packageJson.scripts.test, "node scripts/run-test-suite.mjs");
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /--test-concurrency(?:=|\s)/u);
});

test("runner discovers an explicit, non-empty, stable test-file list", () => {
  const files = discoverTestFiles();

  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every((file) => path.isAbsolute(file)));
  assert.ok(files.every((file) => file.startsWith(path.join(PROJECT_ROOT, "test"))));
  assert.ok(files.includes(fileURLToPath(import.meta.url)));
});

test("runner returns a nonzero status for test failures and stream errors", async () => {
  const failure = await runMainWithEvent("test:fail", { name: "failed test" });
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "");
  assert.match(failure.stdout, /# Failing tests \(1\):\n# - failed test\n/u);

  // The summary names the file and repeats the cause, so a log cut at the top still shows it.
  const detailed = await runMainWithEvent("test:fail", {
    name: "detailed test",
    file: path.join(PROJECT_ROOT, "test", "example.e2e.mjs"),
    line: 12,
    details: { error: Object.assign(new Error("wrapper"), { cause: new Error("ENOENT: no such file") }) },
  });
  assert.match(detailed.stdout, /# - test\/example\.e2e\.mjs:12 detailed test\n#   Error: ENOENT: no such file/u);
  const parent = await runMainWithEvent("test:fail", { name: "parent", details: { error: { failureType: "subtestsFailed" } } });
  assert.doesNotMatch(parent.stdout, /Failing tests/u);

  const error = await runMainWithEvent("error", new Error("runner exploded"));
  assert.equal(error.code, 1);
  assert.match(error.stderr, /Test runner error: Error: runner exploded/u);
});

test("runner fails closed when the stream reports fewer tests than explicit files", async () => {
  const testStream = new EventEmitter();
  let stderr = "";
  const code = await main({
    env: {},
    stdout: {
      write() {
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
        return true;
      },
    },
    runTests(options) {
      assert.deepEqual(options, {
        concurrency: DEFAULT_TEST_CONCURRENCY,
        files: ["/deterministic/one.test.mjs", "/deterministic/two.test.mjs"],
      });
      return testStream;
    },
    findTestFiles() {
      return ["/deterministic/one.test.mjs", "/deterministic/two.test.mjs"];
    },
    async *reporter() {
      yield "TAP version 13\n";
    },
  });

  assert.equal(code, 1);
  assert.match(stderr, /completed only 0 test events for 2 explicit test files/u);
});

test("test shard parsing accepts only 1-based <index>/<total> values", () => {
  assert.equal(TEST_SHARD_ENV, "AGENTIC_SDLC_TEST_SHARD");
  assert.equal(parseTestShard(undefined), null);
  assert.deepEqual(parseTestShard("1/3"), { index: 1, total: 3 });
  assert.deepEqual(parseTestShard("3/3"), { index: 3, total: 3 });
  assert.deepEqual(parseTestShard("1/1"), { index: 1, total: 1 });
  for (const value of [
    "", "0/3", "4/3", "1/0", "1", "/3", "1/", "a/b", "1/3/5", "-1/3", "+1/3",
    "1.5/3", " 1/3", "1/3 ", "01/3", "1/03", "12345/99999", "1-3", 1, null, {},
  ]) {
    assert.throws(
      () => parseTestShard(value),
      new RegExp(`${TEST_SHARD_ENV} must be "<index>/<total>"`, "u"),
      JSON.stringify(value),
    );
  }
});

const FIXTURE_SIZES = new Map(Object.entries({
  "/t/a.mjs": 900, "/t/b.mjs": 800, "/t/c.mjs": 500, "/t/d.mjs": 500,
  "/t/e.mjs": 300, "/t/f.mjs": 200, "/t/g.mjs": 100, "/t/h.mjs": 100, "/t/i.mjs": 10,
}));
const fixtureFiles = () => [...FIXTURE_SIZES.keys()];
const fixtureSize = (file) => FIXTURE_SIZES.get(file);

test("sharding is deterministic and independent of the input order", () => {
  const baseline = partitionTestFiles(fixtureFiles(), 3, fixtureSize);
  assert.deepEqual(partitionTestFiles(fixtureFiles(), 3, fixtureSize), baseline);
  assert.deepEqual(partitionTestFiles(fixtureFiles().reverse(), 3, fixtureSize), baseline);
  assert.deepEqual(baseline, [
    ["/t/a.mjs", "/t/f.mjs", "/t/h.mjs"],
    ["/t/b.mjs", "/t/e.mjs", "/t/i.mjs"],
    ["/t/c.mjs", "/t/d.mjs", "/t/g.mjs"],
  ]);
});

test("every file lands in exactly one shard and the shards are balanced", () => {
  for (const total of [1, 2, 3, 5, 9]) {
    const shards = partitionTestFiles(fixtureFiles(), total, fixtureSize);
    assert.equal(shards.length, total);
    assert.deepEqual(shards.flat().sort(), fixtureFiles().sort(), `total ${total}`);
    for (const shard of shards) assert.deepEqual(shard, [...shard].sort());
    const loads = shards.map((shard) => shard.reduce((sum, file) => sum + fixtureSize(file), 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 900, `total ${total}: ${loads}`);
  }
  const loads = partitionTestFiles(fixtureFiles(), 3, fixtureSize)
    .map((shard) => shard.reduce((sum, file) => sum + fixtureSize(file), 0));
  assert.deepEqual(loads, [1200, 1110, 1100]);
});

test("equal sizes are tied by path so the split never depends on the filesystem", () => {
  const files = ["/t/z.mjs", "/t/y.mjs", "/t/x.mjs", "/t/w.mjs"];
  assert.deepEqual(
    partitionTestFiles(files, 2, () => 10),
    [["/t/w.mjs", "/t/y.mjs"], ["/t/x.mjs", "/t/z.mjs"]],
  );
});

test("the real test tree is covered exactly once by three shards", () => {
  const files = discoverTestFiles();
  const shards = partitionTestFiles(files, 3);
  assert.deepEqual(shards.flat().sort(), files);
  assert.ok(shards.every((shard) => shard.length > 0));
});

// Expected durations are what balances the shards, so a file that is small but
// slow must weigh more than a large file that finishes quickly.
const FIXTURE_WEIGHTS = new Map(Object.entries({
  "/t/a.mjs": 10, "/t/b.mjs": 700, "/t/c.mjs": 20, "/t/d.mjs": 650,
  "/t/e.mjs": 30, "/t/f.mjs": 600, "/t/g.mjs": 40, "/t/h.mjs": 50, "/t/i.mjs": 60,
}));
const fixtureWeight = (file) => FIXTURE_WEIGHTS.get(file);

test("shards are balanced by the weight function, not by file count or size", () => {
  const bySize = partitionTestFiles(fixtureFiles(), 3, fixtureSize);
  const byWeight = partitionTestFiles(fixtureFiles(), 3, fixtureWeight);
  assert.notDeepEqual(byWeight, bySize);
  const loads = (shards, weight) => shards.map((shard) => shard.reduce((sum, file) => sum + weight(file), 0));
  // Each of the three heavy files is alone with light ones, so the shards finish together.
  assert.deepEqual(byWeight, [
    ["/t/b.mjs", "/t/e.mjs"],
    ["/t/c.mjs", "/t/d.mjs", "/t/h.mjs"],
    ["/t/a.mjs", "/t/f.mjs", "/t/g.mjs", "/t/i.mjs"],
  ]);
  const weighted = loads(byWeight, fixtureWeight);
  assert.deepEqual(weighted, [730, 720, 710]);
  // The same split judged by the weights is far worse when it was made from sizes.
  const sized = loads(bySize, fixtureWeight);
  assert.ok(Math.max(...sized) - Math.min(...sized) > Math.max(...weighted) - Math.min(...weighted));
});

test("shard weights are parsed strictly", () => {
  const valid = { schema: SHARD_WEIGHTS_SCHEMA, defaultWeight: 40, files: { "test/a.mjs": 10, "test/b.mjs": 90 } };
  const parsed = parseShardWeights(JSON.stringify(valid));
  assert.equal(parsed.defaultWeight, 40);
  assert.deepEqual([...parsed.files], [["test/a.mjs", 10], ["test/b.mjs", 90]]);
  for (const broken of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...valid, schema: "other" }),
    JSON.stringify({ ...valid, defaultWeight: 0 }),
    JSON.stringify({ ...valid, defaultWeight: 1.5 }),
    JSON.stringify({ ...valid, files: [] }),
    JSON.stringify({ ...valid, files: null }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": 0 } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": -3 } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": "10" } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": Number.MAX_SAFE_INTEGER + 2 } }),
  ]) {
    assert.throws(() => parseShardWeights(broken), TypeError, broken);
  }
});

test("a missing weights table falls back to sizes and a corrupt one is an error", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shard-weights-"));
  try {
    assert.equal(loadShardWeights(path.join(scratch, "absent.json")), null);
    const corrupt = path.join(scratch, "corrupt.json");
    fs.writeFileSync(corrupt, "{");
    assert.throws(() => loadShardWeights(corrupt), TypeError);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("median weight is the lower middle value and never below one", () => {
  assert.equal(medianWeight([]), 1);
  assert.equal(medianWeight([5]), 5);
  assert.equal(medianWeight([30, 10, 20]), 20);
  assert.equal(medianWeight([40, 10, 30, 20]), 20);
  assert.equal(medianWeight([0, 0, 0]), 1);
});

test("project-relative paths use forward slashes", () => {
  assert.equal(projectRelativePath(path.join(PROJECT_ROOT, "test", "unit", "x.mjs")), "test/unit/x.mjs");
});

test("a shard that would be empty is rejected instead of silently passing", () => {
  assert.throws(
    () => selectShardFiles(["/t/only.mjs"], { index: 2, total: 3 }, () => 1),
    /shard 2\/3 has no files/u,
  );
});

test("runner runs only its shard and reports it", async () => {
  const seen = [];
  let stdout = "";
  for (const index of [1, 2, 3]) {
    const testStream = new EventEmitter();
    const code = await main({
      env: { [TEST_SHARD_ENV]: `${index}/3` },
      stdout: { write(chunk) { stdout += chunk; return true; } },
      stderr: { write() { return true; } },
      findTestFiles: fixtureFiles,
      fileWeight: fixtureSize,
      runTests(options) {
        seen.push(...options.files);
        queueMicrotask(() => {
          for (const _ of options.files) testStream.emit("test:pass");
        });
        return testStream;
      },
      async *reporter(stream) {
        await new Promise((resolve) => setImmediate(resolve));
        yield "ok\n";
      },
    });
    assert.equal(code, 0, `shard ${index}`);
  }
  assert.deepEqual(seen.sort(), fixtureFiles().sort());
  assert.match(stdout, /# test shard 1\/3: 3 of 9 test files/u);
});

test("runner fails with a clear error for an invalid shard and runs nothing", async () => {
  for (const value of ["0/3", "4/3", "x", ""]) {
    let stderr = "";
    const code = await main({
      env: { [TEST_SHARD_ENV]: value },
      stdout: { write() { return true; } },
      stderr: { write(chunk) { stderr += chunk; return true; } },
      findTestFiles: fixtureFiles,
      runTests() { throw new Error("must not run tests"); },
    });
    assert.equal(code, 1, value);
    assert.match(stderr, /AGENTIC_SDLC_TEST_SHARD must be "<index>\/<total>"/u, value);
  }
});

async function runMainWithEvent(eventName, payload) {
  const testStream = new EventEmitter();
  let stdout = "";
  let stderr = "";
  const code = await main({
    env: {},
    stdout: {
      write(chunk) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
        return true;
      },
    },
    runTests(options) {
      assert.deepEqual(options, {
        concurrency: DEFAULT_TEST_CONCURRENCY,
        files: ["/deterministic/test.mjs"],
      });
      return testStream;
    },
    findTestFiles() {
      return ["/deterministic/test.mjs"];
    },
    async *reporter(stream) {
      stream.emit(eventName, payload);
      yield "TAP version 13\n";
    },
  });
  return { code, stdout, stderr };
}

test("tier parsing treats full as no tier and accepts only short lowercase names", () => {
  assert.equal(TEST_TIER_ENV, "AGENTIC_SDLC_TEST_TIER");
  assert.equal(parseTestTier(undefined), null);
  assert.equal(parseTestTier("full"), null);
  assert.equal(parseTestTier("fast"), "fast");
  assert.equal(parseTestTier("smoke-2"), "smoke-2");
  assert.equal(parseTestTier(`a${"b".repeat(31)}`), `a${"b".repeat(31)}`);
  for (const value of [
    "", "Fast", "1fast", "-fast", "fast tier", "fast_tier", " fast", "fast ", `a${"b".repeat(32)}`, 1, null, {},
  ]) {
    assert.throws(() => parseTestTier(value), TypeError, JSON.stringify(value));
    assert.throws(() => parseTestTier(value), /AGENTIC_SDLC_TEST_TIER must be "full" or a tier name/u, JSON.stringify(value));
  }

  // The npm script passes the tier as a flag so it needs no shell-specific variable syntax.
  const env = {};
  applyRunnerArguments(["--tier=fast"], env);
  assert.deepEqual(env, { [TEST_TIER_ENV]: "fast" });
  applyRunnerArguments(["--unrelated", "--tier", "full"], env);
  assert.deepEqual(env, { [TEST_TIER_ENV]: "fast" });
  applyRunnerArguments(["--tier=full"], env);
  assert.deepEqual(env, { [TEST_TIER_ENV]: "full" });
});

test("stripped variables default to NODE_USE_SYSTEM_CA and an empty value strips nothing", () => {
  assert.equal(TEST_STRIP_ENV, "AGENTIC_SDLC_TEST_STRIP_ENV");
  assert.deepEqual(DEFAULT_STRIPPED_ENV, ["NODE_USE_SYSTEM_CA"]);
  assert.deepEqual(parseStrippedEnv(undefined), ["NODE_USE_SYSTEM_CA"]);
  assert.deepEqual(parseStrippedEnv(""), []);
  assert.deepEqual(parseStrippedEnv("NODE_OPTIONS"), ["NODE_OPTIONS"]);
  assert.deepEqual(parseStrippedEnv("_A,B_2,_A"), ["_A", "B_2"]);
  for (const value of ["a", "A,", ",A", "A,,B", "A B", "A-B", "1A", " A", 1, null]) {
    assert.throws(() => parseStrippedEnv(value), /AGENTIC_SDLC_TEST_STRIP_ENV must be a comma-separated list/u, JSON.stringify(value));
  }
});

test("the runner removes stripped variables from the test environment in every mode", async () => {
  const files = ["/deterministic/test.mjs"];
  const runWith = async (env) => {
    let seen = null;
    const code = await main({
      env,
      stdout: { write() { return true; } },
      stderr: { write() { return true; } },
      findTestFiles: () => files,
      runTests(options) {
        assert.deepEqual(options, { concurrency: DEFAULT_TEST_CONCURRENCY, files });
        seen = { ...env };
        return scriptedStream([{ type: "test:pass", data: { name: "one", nesting: 0 } }]);
      },
      reporter: drainReporter,
    });
    return { code, seen };
  };

  const stripped = await runWith({ NODE_USE_SYSTEM_CA: "1", KEEP: "x" });
  assert.equal(stripped.code, 0);
  assert.equal(Object.hasOwn(stripped.seen, "NODE_USE_SYSTEM_CA"), false);
  assert.equal(stripped.seen.KEEP, "x");

  const kept = await runWith({ NODE_USE_SYSTEM_CA: "1", [TEST_STRIP_ENV]: "" });
  assert.equal(kept.code, 0);
  assert.equal(kept.seen.NODE_USE_SYSTEM_CA, "1");

  const custom = await runWith({ NODE_USE_SYSTEM_CA: "1", KEEP: "x", [TEST_STRIP_ENV]: "KEEP" });
  assert.equal(custom.seen.NODE_USE_SYSTEM_CA, "1");
  assert.equal(Object.hasOwn(custom.seen, "KEEP"), false);

  const invalid = await runMainRejected({ NODE_USE_SYSTEM_CA: "1", [TEST_STRIP_ENV]: "bad name" });
  assert.match(invalid.stderr, /AGENTIC_SDLC_TEST_STRIP_ENV must be a comma-separated list/u);
});

test("discovery takes only .test. and .e2e. files and never enters helpers or fixtures", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-discovery-"));
  try {
    const write = (relative) => {
      const file = path.join(scratch, ...relative.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    };
    for (const relative of [
      "a.test.mjs", "b.e2e.mjs", "unit/c.test.cjs", "unit/d.e2e.js",
      "notes.mjs", "test.mjs", "unit/util.mjs", "unit/e.test.mjs.bak", "unit/data.test.json",
      "helpers/h.test.mjs", "fixtures/f.e2e.mjs", "unit/fixtures/g.test.mjs", "unit/helpers/i.e2e.mjs",
    ]) write(relative);
    assert.deepEqual(
      discoverTestFiles(scratch).map((file) => path.relative(scratch, file).split(path.sep).join("/")),
      ["a.test.mjs", "b.e2e.mjs", "unit/c.test.cjs", "unit/d.e2e.js"],
    );

    const helpersOnly = path.join(scratch, "only");
    fs.mkdirSync(path.join(helpersOnly, "helpers"), { recursive: true });
    fs.writeFileSync(path.join(helpersOnly, "helpers", "x.test.mjs"), "");
    assert.throws(() => discoverTestFiles(helpersOnly), /No JavaScript test files were found/u);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const real = discoverTestFiles().map(projectRelativePath);
  assert.equal(real.some((file) => /^test\/(?:helpers|fixtures)\//u.test(file)), false);
  assert.ok(real.every((file) => /\.(?:test|e2e)\.(?:cjs|js|mjs)$/u.test(file)));
});

const tierPath = (relative) => path.join(PROJECT_ROOT, ...relative.split("/"));
const TIER_FILES = [
  "test/c.e2e.mjs", "test/d.e2e.mjs", "test/e.e2e.mjs",
  "test/unit/a.test.mjs", "test/unit/b.test.mjs", "test/unit/heavy.test.mjs",
].map(tierPath);
const ODD_NAME = "d (two) [x] a-b/c.d $1 ^?|*+{2}";
const FAST_TIER = {
  description: "local check",
  files: ["test/unit/", "test/c.e2e.mjs"],
  exclude: ["test/unit/heavy.test.mjs"],
  smoke: {
    "test/unit/heavy.test.mjs": ["heavy cheap"],
    "test/d.e2e.mjs": ["d one", ODD_NAME],
  },
};
const tierManifest = (tiers) => JSON.stringify({ schema: TEST_TIERS_SCHEMA, tiers });
const fastTier = (overrides = {}) => parseTestTiers(tierManifest({ fast: { ...FAST_TIER, ...overrides } })).get("fast");

test("test tiers are parsed strictly", () => {
  assert.equal(TEST_TIERS_SCHEMA, "agentic-sdlc.test-tiers.v1");
  assert.equal(TEST_TIERS_FILE, path.join(PROJECT_ROOT, "test", "test-tiers.json"));
  const tiers = parseTestTiers(tierManifest({ fast: FAST_TIER, tiny: { smoke: { "test/d.e2e.mjs": ["d one"] } } }));
  assert.deepEqual([...tiers.keys()], ["fast", "tiny"]);
  const fast = tiers.get("fast");
  assert.equal(fast.name, "fast");
  assert.deepEqual(fast.files, FAST_TIER.files);
  assert.deepEqual(fast.exclude, FAST_TIER.exclude);
  assert.deepEqual([...fast.smoke], Object.entries(FAST_TIER.smoke));
  assert.deepEqual(tiers.get("tiny").files, []);

  const tier = (overrides) => tierManifest({ fast: { ...FAST_TIER, ...overrides } });
  for (const broken of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ schema: "other", tiers: { fast: FAST_TIER } }),
    JSON.stringify({ schema: TEST_TIERS_SCHEMA }),
    tierManifest({}),
    tierManifest([]),
    tierManifest({ full: FAST_TIER }),
    tierManifest({ Fast: FAST_TIER }),
    tierManifest({ fast: [] }),
    tier({ exlude: [] }),
    tier({ description: 1 }),
    tier({ files: "test/unit/" }),
    tier({ files: [""] }),
    tier({ files: ["/test/unit/"] }),
    tier({ files: ["test/../lib/"] }),
    tier({ files: ["./test/unit/"] }),
    tier({ files: ["test\\unit\\"] }),
    tier({ files: ["test//unit/"] }),
    tier({ files: ["test/unit/", "test/unit/"] }),
    tier({ exclude: ["test/unit/heavy.test.mjs", "test/unit/heavy.test.mjs"] }),
    tier({ smoke: [] }),
    tier({ smoke: { "test/unit/": ["x"] } }),
    tier({ smoke: { "test/d.e2e.mjs": [] } }),
    tier({ smoke: { "test/d.e2e.mjs": [""] } }),
    tier({ smoke: { "test/d.e2e.mjs": ["same", "same"] } }),
    tier({ smoke: { "test/d.e2e.mjs": "d one" } }),
  ]) {
    assert.throws(() => parseTestTiers(broken), TypeError, broken);
  }
});

test("a missing tiers file is an error and the real manifest loads", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-tiers-"));
  try {
    assert.throws(() => loadTestTiers(path.join(scratch, "absent.json")), /does not exist, so no test tier can run/u);
    const corrupt = path.join(scratch, "corrupt.json");
    fs.writeFileSync(corrupt, "{");
    assert.throws(() => loadTestTiers(corrupt), TypeError);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(loadTestTiers().has("fast"));
});

test("a tier plan runs selected files whole and smoke files by test name", () => {
  const plan = selectTierPlan(TIER_FILES, fastTier());
  assert.deepEqual(plan.whole, ["test/c.e2e.mjs", "test/unit/a.test.mjs", "test/unit/b.test.mjs"].map(tierPath));
  assert.deepEqual(plan.smoke, [
    { file: tierPath("test/d.e2e.mjs"), names: ["d one", ODD_NAME] },
    { file: tierPath("test/unit/heavy.test.mjs"), names: ["heavy cheap"] },
  ]);
  // A smoke file is never also run whole, even when files selects it.
  const overlap = selectTierPlan(TIER_FILES, fastTier({ exclude: [] }));
  assert.equal(overlap.whole.includes(tierPath("test/unit/heavy.test.mjs")), false);
});

test("a tier plan rejects undiscovered paths, duplicate smoke names, and empty selections", () => {
  for (const overrides of [
    { files: ["test/missing/"] },
    { files: ["test/unit/", "test/zzz.e2e.mjs"] },
    { exclude: ["test/unit/zzz.test.mjs"] },
    { smoke: { "test/zzz.e2e.mjs": ["z"] } },
  ]) {
    assert.throws(() => selectTierPlan(TIER_FILES, fastTier(overrides)), /not a discovered test file or folder/u, JSON.stringify(overrides));
  }
  assert.throws(
    () => selectTierPlan(TIER_FILES, fastTier({ smoke: { "test/d.e2e.mjs": ["same"], "test/e.e2e.mjs": ["same"] } })),
    /lists the smoke test "same" twice/u,
  );
  assert.throws(
    () => selectTierPlan(TIER_FILES, fastTier({ files: ["test/unit/"], exclude: ["test/unit/"], smoke: {} })),
    /selects no test files/u,
  );
});

test("a tier runs its whole files first, then only the named smoke tests", async () => {
  const calls = [];
  const env = { [TEST_TIER_ENV]: "fast", NODE_USE_SYSTEM_CA: "1" };
  let wholeDrained = false;
  let stdout = "";
  let stderr = "";
  const code = await main({
    env,
    stdout: { write(chunk) { stdout += chunk; return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
    findTestFiles: () => TIER_FILES,
    loadTiers: () => parseTestTiers(tierManifest({ fast: FAST_TIER })),
    runTests(options) {
      calls.push(options);
      assert.equal(Object.hasOwn(env, "NODE_USE_SYSTEM_CA"), false);
      if (options.testNamePatterns === undefined) {
        return scriptedStream(
          options.files.map((file) => ({ type: "test:pass", data: { file, name: `whole ${path.basename(file)}`, nesting: 0 } })),
          () => { wholeDrained = true; },
        );
      }
      assert.equal(wholeDrained, true, "the smoke phase starts after the whole phase has drained");
      return scriptedStream([
        { type: "test:pass", data: { file: tierPath("test/d.e2e.mjs"), name: "d one", nesting: 0 } },
        { type: "test:pass", data: { file: tierPath("test/d.e2e.mjs"), name: ODD_NAME, nesting: 0 } },
        // A platform skip is still a test that ran under its name.
        { type: "test:pass", data: { file: tierPath("test/unit/heavy.test.mjs"), name: "heavy cheap", nesting: 0, skip: "unsupported here" } },
      ]);
    },
    reporter: async function* (source) {
      for await (const event of source) yield `${event.type} ${event.data.name}\n`;
    },
  });

  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    concurrency: DEFAULT_TEST_CONCURRENCY,
    files: ["test/c.e2e.mjs", "test/unit/a.test.mjs", "test/unit/b.test.mjs"].map(tierPath),
  });
  assert.deepEqual(Object.keys(calls[1]).sort(), ["concurrency", "files", "testNamePatterns"]);
  assert.equal(calls[1].concurrency, DEFAULT_TEST_CONCURRENCY);
  assert.deepEqual(calls[1].files, ["test/d.e2e.mjs", "test/unit/heavy.test.mjs"].map(tierPath));
  const patterns = calls[1].testNamePatterns;
  assert.equal(patterns.length, 3);
  assert.ok(patterns.every((pattern) => pattern instanceof RegExp && pattern.flags === "u"));
  ["d one", ODD_NAME, "heavy cheap"].forEach((name, index) => {
    assert.ok(patterns[index].test(name), name);
    assert.equal(patterns[index].test(`${name} more`), false, name);
    assert.equal(patterns[index].test(`x${name}`), false, name);
  });
  assert.equal(patterns.some((pattern) => pattern.test("d two")), false);

  assert.match(
    stdout,
    /^# test tier fast: 3 whole files \+ 2 files with 3 selected tests \(partial run, not release verification\)\n/u,
  );
  assert.ok(stdout.indexOf("whole b.test.mjs") < stdout.indexOf("test:pass d one"));
});

test("a selected smoke test that does not run fails the tier run and is named", async () => {
  let stderr = "";
  const code = await main({
    env: { [TEST_TIER_ENV]: "fast" },
    stdout: { write() { return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
    findTestFiles: () => TIER_FILES,
    loadTiers: () => parseTestTiers(tierManifest({ fast: FAST_TIER })),
    runTests(options) {
      if (options.testNamePatterns === undefined) {
        return scriptedStream(options.files.map((file) => ({ type: "test:pass", data: { file, name: "whole", nesting: 0 } })));
      }
      return scriptedStream([
        { type: "test:pass", data: { file: tierPath("test/d.e2e.mjs"), name: "d one", nesting: 0 } },
        // A subtest, or the name in another file, does not stand in for the selected test.
        { type: "test:pass", data: { file: tierPath("test/d.e2e.mjs"), name: ODD_NAME, nesting: 1 } },
        { type: "test:fail", data: { file: tierPath("test/unit/heavy.test.mjs"), name: ODD_NAME, nesting: 0 } },
        { type: "test:pass", data: { file: tierPath("test/unit/heavy.test.mjs"), name: "heavy cheap", nesting: 0 } },
      ]);
    },
    reporter: drainReporter,
  });

  assert.equal(code, 1);
  assert.match(stderr, /Test tier fast selected 1 test\(s\) that did not run; update test\/test-tiers\.json:/u);
  assert.ok(stderr.includes(`  - test/d.e2e.mjs: ${ODD_NAME}`), stderr);
  assert.equal(stderr.includes("d one"), false);
});

test("a tier is rejected together with a shard, under CI, when unknown, or without its manifest", async () => {
  const loadTiers = () => parseTestTiers(tierManifest({ fast: FAST_TIER }));
  const cases = [
    [{ [TEST_TIER_ENV]: "fast", [TEST_SHARD_ENV]: "1/3" }, loadTiers, /AGENTIC_SDLC_TEST_TIER and AGENTIC_SDLC_TEST_SHARD cannot be combined/u],
    [{ [TEST_TIER_ENV]: "fast", CI: "true" }, loadTiers, /AGENTIC_SDLC_TEST_TIER=fast is a partial local run; CI always runs the full suite/u],
    [{ [TEST_TIER_ENV]: "slow" }, loadTiers, /Unknown test tier "slow"; test\/test-tiers\.json does not define it/u],
    [{ [TEST_TIER_ENV]: "Fast" }, loadTiers, /AGENTIC_SDLC_TEST_TIER must be "full" or a tier name/u],
    [
      { [TEST_TIER_ENV]: "fast" },
      () => loadTestTiers(path.join(os.tmpdir(), `absent-test-tiers-${process.pid}.json`)),
      /does not exist, so no test tier can run/u,
    ],
  ];
  for (const [env, tiers, message] of cases) {
    const result = await runMainRejected(env, tiers);
    assert.match(result.stderr, message, JSON.stringify(env));
  }

  // "full" is the whole suite, so CI may name it.
  const files = ["/deterministic/test.mjs"];
  const code = await main({
    env: { [TEST_TIER_ENV]: "full", CI: "true" },
    stdout: { write() { return true; } },
    stderr: { write() { return true; } },
    findTestFiles: () => files,
    loadTiers() { throw new Error("the full suite must not read the tiers file"); },
    runTests(options) {
      assert.deepEqual(options, { concurrency: DEFAULT_TEST_CONCURRENCY, files });
      return scriptedStream([{ type: "test:pass", data: { name: "one", nesting: 0 } }]);
    },
    reporter: drainReporter,
  });
  assert.equal(code, 0);
});

// An event emitter that also replays its events to the reporter, like the node:test stream.
function scriptedStream(events, onDrained = () => {}) {
  const stream = new EventEmitter();
  stream[Symbol.asyncIterator] = async function* () {
    for (const event of events) {
      await new Promise((resolve) => setImmediate(resolve));
      stream.emit(event.type, event.data);
      yield event;
    }
    onDrained();
  };
  return stream;
}

async function* drainReporter(source) {
  for await (const _ of source) yield "";
}

async function runMainRejected(env, loadTiers = () => { throw new Error("must not load tiers"); }) {
  let stderr = "";
  const code = await main({
    env,
    stdout: { write() { return true; } },
    stderr: { write(chunk) { stderr += chunk; return true; } },
    findTestFiles: () => TIER_FILES,
    loadTiers,
    runTests() { throw new Error("must not run tests"); },
    reporter: drainReporter,
  });
  assert.equal(code, 1, JSON.stringify(env));
  return { code, stderr };
}
