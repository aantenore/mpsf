import path from "node:path";
import { once } from "node:events";
import fs from "node:fs";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";

export const TEST_CONCURRENCY_ENV = "AGENTIC_SDLC_TEST_CONCURRENCY";
export const DEFAULT_TEST_CONCURRENCY = 2;
export const MAX_TEST_CONCURRENCY = 8;
export const TEST_SHARD_ENV = "AGENTIC_SDLC_TEST_SHARD";
export const SHARD_WEIGHTS_SCHEMA = "agentic-sdlc.test-shard-weights.v1";
export const TEST_TIER_ENV = "AGENTIC_SDLC_TEST_TIER";
// A tier is refused under CI unless the workflow opts in explicitly, so an inherited tier
// variable can never silently shrink a CI run that was meant to be the full suite.
export const TEST_TIER_IN_CI_ENV = "AGENTIC_SDLC_TEST_TIER_IN_CI";
export const TEST_TIERS_SCHEMA = "agentic-sdlc.test-tiers.v1";
export const TEST_STRIP_ENV = "AGENTIC_SDLC_TEST_STRIP_ENV";
// Removed from the environment the test files inherit. The suite never makes a TLS call, but with
// NODE_USE_SYSTEM_CA set every spawned CLI process loads the system certificate store first.
export const DEFAULT_STRIPPED_ENV = Object.freeze(["NODE_USE_SYSTEM_CA"]);
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_ROOT = path.join(PROJECT_ROOT, "test");
export const SHARD_WEIGHTS_FILE = path.join(TEST_ROOT, "shard-weights.json");
export const TEST_TIERS_FILE = path.join(TEST_ROOT, "test-tiers.json");
// Only these names are test files. Helper modules and fixtures are imported or spawned by tests.
const TEST_FILE_PATTERN = /\.(?:test|e2e)\.(?:cjs|js|mjs)$/u;
const NON_TEST_DIRECTORIES = new Set(["helpers", "fixtures"]);
const TEST_TIER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const TIER_FIELDS = new Set(["description", "files", "exclude", "smoke"]);
// The closing counters of one run ("tests 12", "pass 11", ...); unlike t.diagnostic() output they carry no file.
const RUN_SUMMARY_PATTERN = /^(tests|suites|pass|fail|cancelled|skipped|todo) ([0-9]+)$/u;

export function parseTestConcurrency(value) {
  if (value === undefined) return DEFAULT_TEST_CONCURRENCY;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(
      `${TEST_CONCURRENCY_ENV} must be a positive integer; received ${JSON.stringify(value)}.`,
    );
  }

  const requested = BigInt(value);
  return requested > BigInt(MAX_TEST_CONCURRENCY)
    ? MAX_TEST_CONCURRENCY
    : Number(requested);
}

// "<index>/<total>", 1-based. Absent means "run everything".
export function parseTestShard(value) {
  if (value === undefined) return null;
  const match = typeof value === "string"
    ? /^([1-9][0-9]{0,3})\/([1-9][0-9]{0,3})$/u.exec(value)
    : null;
  if (match === null || Number(match[1]) > Number(match[2])) {
    throw new TypeError(
      `${TEST_SHARD_ENV} must be "<index>/<total>" with 1 <= index <= total (at most four digits each); received ${JSON.stringify(value)}.`,
    );
  }
  return { index: Number(match[1]), total: Number(match[2]) };
}

// Path of a test file relative to the project root, always with "/" separators,
// so the weights table reads the same on every platform.
export function projectRelativePath(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

export function medianWeight(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 1;
  return Math.max(1, Math.round(sorted[Math.floor((sorted.length - 1) / 2)]));
}

// Expected cost of each test file, in milliseconds measured by
// scripts/measure-test-durations.mjs. Only ratios matter.
export function parseShardWeights(text) {
  let table;
  try {
    table = JSON.parse(text);
  } catch {
    throw new TypeError("The test shard weights are not valid JSON.");
  }
  const isWeight = (value) => Number.isSafeInteger(value) && value > 0;
  if (table === null || typeof table !== "object" || table.schema !== SHARD_WEIGHTS_SCHEMA
    || !isWeight(table.defaultWeight)
    || table.files === null || typeof table.files !== "object" || Array.isArray(table.files)
    || !Object.values(table.files).every(isWeight)) {
    throw new TypeError(
      `The test shard weights must declare schema ${SHARD_WEIGHTS_SCHEMA}, a positive integer defaultWeight, and positive integer weights per file.`,
    );
  }
  return { defaultWeight: table.defaultWeight, files: new Map(Object.entries(table.files)) };
}

// Without a weights table, shards fall back to balancing by file size.
export function loadShardWeights(file = SHARD_WEIGHTS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return parseShardWeights(text);
}

let cachedShardWeights;

// Weight of one file: its measured duration; files the table does not know
// (added since the last measurement) count as the median measured file. Every
// shard reads the same checked-out table, so they all derive the same split.
function defaultFileWeight(file) {
  if (cachedShardWeights === undefined) cachedShardWeights = loadShardWeights();
  if (cachedShardWeights === null) return fs.statSync(file).size;
  return cachedShardWeights.files.get(projectRelativePath(file)) ?? cachedShardWeights.defaultWeight;
}

// Deterministic, balanced split: files are placed heaviest first (ties by path)
// on the currently lightest shard (ties by lowest shard index), so the result
// depends only on the file set and its weights. Every file lands in exactly one
// shard; each shard is returned in sorted path order.
export function partitionTestFiles(files, total, fileWeight = defaultFileWeight) {
  const ordered = [...new Set(files)].sort();
  const weighted = ordered
    .map((file) => ({ file, weight: fileWeight(file) }))
    .sort((left, right) => right.weight - left.weight || (left.file < right.file ? -1 : 1));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const { file, weight } of weighted) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.load < target.load) target = shard;
    }
    target.files.push(file);
    target.load += weight;
  }
  return shards.map((shard) => shard.files.sort());
}

export function selectShardFiles(files, { index, total }, fileWeight = defaultFileWeight) {
  const selected = partitionTestFiles(files, total, fileWeight)[index - 1];
  if (selected.length === 0) {
    throw new Error(
      `Test shard ${index}/${total} has no files; ${files.length} test files cannot fill ${total} shards.`,
    );
  }
  return selected;
}

export function discoverTestFiles(testRoot = TEST_ROOT) {
  const discovered = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, {
      encoding: "utf8",
      withFileTypes: true,
    })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!NON_TEST_DIRECTORIES.has(entry.name)) visit(entryPath);
      } else if (
        entry.isFile()
        && TEST_FILE_PATTERN.test(entry.name)
      ) {
        discovered.push(path.resolve(entryPath));
      }
    }
  }

  visit(testRoot);
  discovered.sort();
  if (discovered.length === 0) {
    throw new Error(`No JavaScript test files were found under ${testRoot}.`);
  }
  return discovered;
}

// A named partial run for local iteration. Absent or "full" means the whole suite.
export function parseTestTier(value) {
  if (value === undefined || value === "full") return null;
  if (typeof value !== "string" || !TEST_TIER_NAME_PATTERN.test(value)) {
    throw new TypeError(
      `${TEST_TIER_ENV} must be "full" or a tier name of lowercase letters, digits, and hyphens (at most 32 characters); received ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

// Absent strips the defaults; an empty value strips nothing.
export function parseStrippedEnv(value) {
  if (value === undefined) return [...DEFAULT_STRIPPED_ENV];
  if (value === "") return [];
  const names = typeof value === "string" ? value.split(",") : null;
  if (names === null || !names.every((name) => ENV_NAME_PATTERN.test(name))) {
    throw new TypeError(
      `${TEST_STRIP_ENV} must be a comma-separated list of environment variable names (A-Z, 0-9, _), or empty to keep every variable; received ${JSON.stringify(value)}.`,
    );
  }
  return [...new Set(names)];
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Project-relative, "/"-separated; a trailing "/" names every test file below that folder.
function isTierPath(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment, index) => (segment === "" ? index === segments.length - 1 : segment !== "." && segment !== ".."));
}

function isUniqueList(value, isEntry) {
  return Array.isArray(value) && value.every(isEntry) && new Set(value).size === value.length;
}

export function parseTestTiers(text) {
  let table;
  try {
    table = JSON.parse(text);
  } catch {
    throw new TypeError("The test tiers are not valid JSON.");
  }
  const invalid = (detail) => new TypeError(
    `The test tiers must declare schema ${TEST_TIERS_SCHEMA} and tiers of unique project-relative files, exclude, and smoke test names: ${detail}.`,
  );
  if (!isPlainObject(table) || table.schema !== TEST_TIERS_SCHEMA) throw invalid("missing or different schema");
  if (!isPlainObject(table.tiers) || Object.keys(table.tiers).length === 0) throw invalid("no tiers");
  const tiers = new Map();
  for (const [name, definition] of Object.entries(table.tiers)) {
    if (name === "full" || !TEST_TIER_NAME_PATTERN.test(name)) throw invalid(`tier name ${JSON.stringify(name)}`);
    if (!isPlainObject(definition) || !Object.keys(definition).every((key) => TIER_FIELDS.has(key))) {
      throw invalid(`tier ${name} is not an object of ${[...TIER_FIELDS].join(", ")}`);
    }
    const { description = "", files = [], exclude = [], smoke = {} } = definition;
    if (typeof description !== "string") throw invalid(`tier ${name} description`);
    if (!isUniqueList(files, isTierPath)) throw invalid(`tier ${name} files`);
    if (!isUniqueList(exclude, isTierPath)) throw invalid(`tier ${name} exclude`);
    if (!isPlainObject(smoke)) throw invalid(`tier ${name} smoke`);
    for (const [file, names] of Object.entries(smoke)) {
      if (!isTierPath(file) || file.endsWith("/")
        || !isUniqueList(names, (entry) => typeof entry === "string" && entry !== "") || names.length === 0) {
        throw invalid(`tier ${name} smoke entry ${JSON.stringify(file)}`);
      }
    }
    tiers.set(name, { name, description, files, exclude, smoke: new Map(Object.entries(smoke)) });
  }
  return tiers;
}

// Read only when a tier is requested; unlike the shard weights, a missing file is an error.
export function loadTestTiers(file = TEST_TIERS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`The test tiers file ${file} does not exist, so no test tier can run.`);
    }
    throw error;
  }
  return parseTestTiers(text);
}

// Files run whole, plus smoke files of which only the named top-level tests run.
export function selectTierPlan(discovered, tierDefinition) {
  const { name, files, exclude, smoke } = tierDefinition;
  const byPath = new Map(discovered.map((file) => [projectRelativePath(file), file]));
  const covers = (entry, relative) => (entry.endsWith("/") ? relative.startsWith(entry) : relative === entry);
  for (const entry of [...files, ...exclude, ...smoke.keys()]) {
    if (![...byPath.keys()].some((relative) => covers(entry, relative))) {
      throw new Error(`Test tier ${name} names ${entry}, which is not a discovered test file or folder.`);
    }
  }
  const owners = new Map();
  const selectedSmoke = [];
  for (const [file, names] of [...smoke].sort(([left], [right]) => (left < right ? -1 : 1))) {
    for (const testName of names) {
      if (owners.has(testName)) {
        throw new Error(
          `Test tier ${name} lists the smoke test ${JSON.stringify(testName)} twice (${owners.get(testName)} and ${file}); one name pattern would select both.`,
        );
      }
      owners.set(testName, file);
    }
    selectedSmoke.push({ file: byPath.get(file), names: [...names] });
  }
  const whole = [...byPath].filter(([relative]) => files.some((entry) => covers(entry, relative))
    && !exclude.some((entry) => covers(entry, relative))
    && !smoke.has(relative)).map(([, file]) => file);
  if (whole.length === 0 && selectedSmoke.length === 0) {
    throw new Error(`Test tier ${name} selects no test files.`);
  }
  return { whole, smoke: selectedSmoke };
}

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

// The file of a test event as an absolute path. Node releases before 22 report
// the file of an ES module test as a file: URL instead of a path.
export function testEventFile(file) {
  if (typeof file !== "string" || file.length === 0) return null;
  if (file.startsWith("file:")) {
    try {
      return path.resolve(fileURLToPath(file));
    } catch {
      return null;
    }
  }
  return path.resolve(file);
}


// The smoke file a top-level test event belongs to. When the event names no
// smoke file (no file at all, or a form this runner does not recognize), the
// tier-unique test name identifies it instead.
export function smokeEventFile(data, smokeFiles, smokeFileByName) {
  const file = testEventFile(data?.file);
  if (file !== null && smokeFiles.has(file)) return file;
  return smokeFileByName.get(data?.name) ?? null;
}


// CI providers set CI to "true", "1", "True", and similar; only empty, "0", and "false" mean "not CI".
export function isContinuousIntegration(value) {
  return typeof value === "string" && value !== "" && !/^(?:0|false)$/iu.test(value);
}

// npm passes script flags the same way on every platform, unlike inline variable assignments.
export function applyRunnerArguments(argv, env) {
  for (const argument of argv) {
    const match = /^--tier=(.*)$/su.exec(argument);
    if (match !== null) env[TEST_TIER_ENV] = match[1];
  }
}

export async function main({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runTests = run,
  reporter = tap,
  findTestFiles = discoverTestFiles,
  fileWeight = defaultFileWeight,
  loadTiers = loadTestTiers,
} = {}) {
  let testStream;
  let streamError;
  let failed = false;
  let completedTestCount = 0;
  let expectedFileCount = 0;
  const failures = [];
  const runTotals = new Map();
  const watch = (stream) => {
    stream.on("test:pass", () => {
      completedTestCount += 1;
    });
    stream.on("test:fail", (data) => {
      completedTestCount += 1;
      failed = true;
      if (data?.details?.error?.failureType !== "subtestsFailed") failures.push(data);
    });
    stream.on("error", (error) => {
      failed = true;
      streamError ||= error;
    });
    stream.on("test:diagnostic", (data) => {
      const match = data?.nesting === 0 && data.file === undefined ? RUN_SUMMARY_PATTERN.exec(String(data.message)) : null;
      if (match !== null) runTotals.set(match[1], (runTotals.get(match[1]) ?? 0) + Number(match[2]));
    });
    return stream;
  };

  try {
    const concurrency = parseTestConcurrency(env[TEST_CONCURRENCY_ENV]);
    // Node 20 can otherwise reinterpret this runner script as the only test file.
    // An explicit, non-empty file list keeps discovery stable across Node 18/20/24.
    const shard = parseTestShard(env[TEST_SHARD_ENV]);
    const tier = parseTestTier(env[TEST_TIER_ENV]);
    if (tier !== null && shard !== null) {
      throw new TypeError(
        `${TEST_TIER_ENV} and ${TEST_SHARD_ENV} cannot be combined: a tier is a partial local run and a shard is a slice of the full suite.`,
      );
    }
    if (tier !== null && isContinuousIntegration(env.CI) && !isContinuousIntegration(env[TEST_TIER_IN_CI_ENV])) {
      throw new TypeError(
        `${TEST_TIER_ENV}=${tier} is a partial local run; CI always runs the full suite unless ${TEST_TIER_IN_CI_ENV}=true requests the tier explicitly.`,
      );
    }
    const strippedEnv = parseStrippedEnv(env[TEST_STRIP_ENV]);
    const discovered = findTestFiles();
    let files;
    let tierPlan = null;
    if (tier === null) {
      files = shard === null ? discovered : selectShardFiles(discovered, shard, fileWeight);
      if (shard !== null) {
        stdout.write(
          `# test shard ${shard.index}/${shard.total}: ${files.length} of ${discovered.length} test files\n`,
        );
      }
    } else {
      const tierDefinition = loadTiers().get(tier);
      if (tierDefinition === undefined) {
        throw new TypeError(`Unknown test tier ${JSON.stringify(tier)}; ${projectRelativePath(TEST_TIERS_FILE)} does not define it.`);
      }
      tierPlan = selectTierPlan(discovered, tierDefinition);
      files = [...tierPlan.whole, ...tierPlan.smoke.map(({ file }) => file)];
      const testCount = tierPlan.smoke.reduce((sum, { names }) => sum + names.length, 0);
      stdout.write(
        `# test tier ${tier}: ${tierPlan.whole.length} whole files + ${tierPlan.smoke.length} files with ${testCount} selected tests (partial run, not release verification)\n`,
      );
    }
    expectedFileCount = files.length;
    for (const name of strippedEnv) delete env[name];
    // Status must not fetch the fixtures' real remotes during a test run.
    env.AGENTIC_SDLC_STATUS_SYNC ??= "off";
    // Fixtures name the real repository as their remote: finished merges must not publish records to it.
    env.AGENTIC_SDLC_AUTO_PUBLISH ??= "off";
    // Hosts without a smoke sandbox (Windows, Linux without bwrap) still exercise local-release
    // fixtures; release.local authorization stays fail-closed there.
    env.AGENTIC_SDLC_TEST_DEFER_SMOKE_PROVIDER_PREFLIGHT ??= "1";
    // Windows fixtures expect the fail-closed path; real AppContainer runs are
    // covered by test/unit/windows-appcontainer-launcher.test.mjs.
    if (process.platform === "win32") env.AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER ??= "unavailable";

    let source;
    const smokeKey = (file, name) => `${path.resolve(file)}\n${name}`;
    const selectedSmokeTests = new Set(tierPlan?.smoke.flatMap(({ file, names }) => names.map((name) => smokeKey(file, name))));
    const smokeFiles = new Set(tierPlan?.smoke.map(({ file }) => path.resolve(file)));
    // Smoke names are unique across a tier (selectTierPlan enforces it), so a name identifies its file.
    const smokeFileByName = new Map(tierPlan?.smoke.flatMap(({ file, names }) => names.map((name) => [name, path.resolve(file)])));
    const ranSmokeTests = new Set();
    const skippedSmokeTests = new Set();
    const failedSmokeFiles = new Set();
    if (tierPlan === null) {
      testStream = watch(runTests({ concurrency, files }));
      source = testStream;
    } else {
      const { whole, smoke } = tierPlan;
      // Phase B starts only after phase A has drained, so the reporter sees one ordered stream.
      source = (async function* tierEvents() {
        if (whole.length > 0) yield* watch(runTests({ concurrency, files: whole }));
        if (smoke.length === 0) return;
        const smokeStream = watch(runTests({
          concurrency,
          files: smoke.map(({ file }) => file),
          testNamePatterns: smoke.flatMap(({ names }) => names.map((name) => new RegExp(`^${escapeRegExp(name)}$`, "u"))),
        }));
        // Smoke tests must be literal top-level test() calls in their own file: data.file is the file that called
        // test(), so a test defined by a helper module reports the helper's path and would count as missing.
        // test/unit/test-tiers.test.mjs enforces this for every name in the manifest.
        const record = (data) => {
          if (data?.nesting !== 0) return;
          const file = smokeEventFile(data, smokeFiles, smokeFileByName);
          if (file === null) return;
          const key = smokeKey(file, data.name);
          // A skipped or todo test passes without exercising anything, so it counts as missing, not as run.
          if (data.skip || data.todo) {
            if (selectedSmokeTests.has(key)) skippedSmokeTests.add(key);
            return;
          }
          ranSmokeTests.add(key);
        };
        smokeStream.on("test:pass", record);
        smokeStream.on("test:fail", (data) => {
          record(data);
          // A file that fails outside its selected tests (for example, it throws on import) reports the failure
          // under its own path; its selected tests did not run because of that failure, not a stale manifest.
          const file = data?.nesting === 0 ? testEventFile(data.file) : null;
          if (file !== null && !selectedSmokeTests.has(smokeKey(file, data.name))) {
            failedSmokeFiles.add(file);
          }
        });
        yield* smokeStream;
      })();
    }

    for await (const chunk of reporter(source)) {
      if (!stdout.write(chunk)) await once(stdout, "drain");
    }
    // Each run prints its own plan and counters, so the last block above covers only the smoke run.
    if (tierPlan !== null && runTotals.size > 0) {
      stdout.write(`# test tier ${tier} totals (all runs): ${[...runTotals].map(([name, count]) => `${name} ${count}`).join(", ")}\n`);
    }
    if (tierPlan !== null && !streamError) {
      // A renamed or deleted smoke test would otherwise match nothing and pass silently.
      const missing = tierPlan.smoke.filter(({ file }) => !failedSmokeFiles.has(path.resolve(file))).flatMap(({ file, names }) => names
        .filter((name) => !ranSmokeTests.has(smokeKey(file, name)))
        .map((name) => `${projectRelativePath(file)}: ${name}${skippedSmokeTests.has(smokeKey(file, name)) ? " (skipped or todo here)" : ""}`));
      if (missing.length > 0) {
        failed = true;
        streamError = new Error(
          `Test tier ${tier} selected ${missing.length} test(s) that did not run; update ${projectRelativePath(TEST_TIERS_FILE)}:\n`
          + missing.map((line) => `  - ${line}`).join("\n"),
        );
      }
    }
    if (!streamError && completedTestCount < expectedFileCount) {
      failed = true;
      streamError = new Error(
        `Test runner completed only ${completedTestCount} test events for `
        + `${expectedFileCount} explicit test files.`,
      );
    }
  } catch (error) {
    failed = true;
    streamError ||= error;
  }

  if (failures.length > 0) {
    // Repeated at the end, where a truncated CI log still shows them.
    stdout.write(failureSummary(failures));
  }
  if (streamError) {
    stderr.write(`Test runner error: ${formatError(streamError)}\n`);
  }
  return failed ? 1 : 0;
}

const FAILURE_SUMMARY_LINES = 40;

export function failureSummary(failures) {
  const lines = [`# Failing tests (${failures.length}):`];
  for (const failure of failures) {
    const where = failure?.file ? `${projectRelativePath(failure.file)}${failure.line ? `:${failure.line}` : ""} ` : "";
    lines.push(`# - ${where}${failure?.name || "unnamed test"}`);
    const error = failure?.details?.error;
    const cause = error?.cause instanceof Error ? error.cause : error;
    const text = cause ? formatError(cause) : "";
    for (const line of text.split(/\r?\n/u).slice(0, FAILURE_SUMMARY_LINES)) lines.push(`#   ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  applyRunnerArguments(process.argv.slice(2), process.env);
  process.exitCode = await main();
}
