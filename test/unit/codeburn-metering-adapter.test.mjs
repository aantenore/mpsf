import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  CODEBURN_ASSURANCE_CLASSIFICATION,
  CODEBURN_REPORT_CONTRACT,
  buildCodeBurnMeteringSnapshot,
  buildCodeBurnReportArgv,
  calculateMeteringDelta,
  collectCodeBurnMeteringSnapshot,
  computeMeteringSnapshotHash,
  detectCodeBurn,
  executeCodeBurnReport,
  normalizeCodeBurnObservation,
  normalizeCodeBurnQuery,
  parseCodeBurnReport,
  parseCodeBurnVersion,
  validateCodeBurnReport,
  validateMeteringDeltaIntegrity,
  validateMeteringSnapshotIntegrity,
} from "../../lib/codeburn-metering-adapter.mjs";
import { assertAgainstSchema } from "../../lib/json-schema-validator.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(TEST_DIR, "../fixtures/codeburn/report-v0.9.15.json");
const FIXTURE_JSON = fs.readFileSync(FIXTURE_PATH, "utf8");
const QUERY = Object.freeze({
  provider: "codex",
  project: "ShopFront",
  from: "2026-07-14",
  to: "2026-07-14",
});

function fixtureReport() {
  return JSON.parse(FIXTURE_JSON);
}

function snapshot(id, report = fixtureReport(), overrides = {}) {
  return buildCodeBurnMeteringSnapshot({
    id,
    report,
    query: overrides.query || QUERY,
    tool_version: overrides.tool_version || "0.9.15",
  });
}

test("CodeBurn 0.9.x reports normalize into immutable advisory snapshot evidence", () => {
  const report = parseCodeBurnReport(FIXTURE_JSON);
  const validation = validateCodeBurnReport(report);
  assert.equal(validation.valid, true);

  const observation = normalizeCodeBurnObservation(report, {
    query: QUERY,
    tool_version: "0.9.15",
  });
  const result = buildCodeBurnMeteringSnapshot({ id: "meter-start", observation });

  assert.equal(result.adapter.id, "codeburn");
  assert.equal(result.adapter.report_contract, CODEBURN_REPORT_CONTRACT);
  assert.deepEqual(result.scope, QUERY);
  assert.deepEqual(result.cumulative.tokens, {
    input: 100000,
    output: 25000,
    cache_read: 800000,
    cache_write: 5000,
  });
  assert.equal(result.cumulative.calls, 120);
  assert.equal(result.cumulative.sessions, 2);
  assert.deepEqual(result.cumulative.cost, { amount: "12.3456", currency: "USD" });
  assert.equal(result.metering.tokens, "estimated");
  assert.equal(result.metering.cost, "estimated");
  assert.equal(result.assurance.classification, CODEBURN_ASSURANCE_CLASSIFICATION);
  assert.equal(result.assurance.enforcement, "advisory");
  assert.equal(result.assurance.trusted_exact, false);
  assert.equal(result.source.matched_projects[0].calls, 120);
  assert.match(result.source.report_hash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result.cumulative.tokens), true);
  assert.equal(validateMeteringSnapshotIntegrity(result).valid, true);
  assert.doesNotThrow(() => assertAgainstSchema(result, "metering-snapshot"));
});

test("report argv is allowlisted and execution never uses a shell or real CodeBurn in tests", async () => {
  assert.deepEqual(normalizeCodeBurnQuery({ ...QUERY, provider: "CODEX" }), QUERY);
  assert.deepEqual(buildCodeBurnReportArgv(QUERY), [
    "report",
    "--provider",
    "codex",
    "--project",
    "ShopFront",
    "--from",
    "2026-07-14",
    "--to",
    "2026-07-14",
    "--format",
    "json",
  ]);
  assert.throws(
    () => buildCodeBurnReportArgv({ ...QUERY, project: "--all" }),
    /must not start/u,
  );
  assert.throws(
    () => buildCodeBurnReportArgv({ ...QUERY, raw_args: ["--format", "html"] }),
    /unsupported field/u,
  );
  assert.throws(
    () => buildCodeBurnReportArgv({ ...QUERY, from: "2026-02-30" }),
    /valid calendar date/u,
  );

  const calls = [];
  const executor = async (executable, argv, options) => {
    calls.push({ executable, argv: [...argv], options });
    assert.equal(options.shell, false);
    if (argv.at(-1) === "--version") {
      return { stdout: "0.9.15\n", stderr: "" };
    }
    return { stdout: FIXTURE_JSON, stderr: "" };
  };
  const prefixArgs = ["/opt/tools/codeburn-cli.mjs"];
  const execution = await executeCodeBurnReport(QUERY, {
    executable: process.execPath,
    prefix_args: prefixArgs,
    executor,
    cwd: "/tmp",
  });
  assert.equal(execution.tool_version, "0.9.15");
  assert.equal(execution.report.overview.calls, 120);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, [...prefixArgs, "--version"]);
  assert.deepEqual(calls[1].argv, [...prefixArgs, ...buildCodeBurnReportArgv(QUERY)]);

  const collected = await collectCodeBurnMeteringSnapshot(
    { id: "meter-collected", query: QUERY },
    { executable: process.execPath, prefix_args: prefixArgs, executor, cwd: "/tmp" },
  );
  assert.equal(collected.id, "meter-collected");
  assert.equal(validateMeteringSnapshotIntegrity(collected).valid, true);

  await assert.rejects(
    () => detectCodeBurn({ prefix_args: "--loader" }),
    /prefix_args must be an array/u,
  );
});

test("detection is explicit for supported, unsupported, and missing executables", async () => {
  const supported = await detectCodeBurn({
    executor: async () => ({ stdout: "codeburn 0.9.15\n", stderr: "" }),
  });
  assert.equal(supported.available, true);
  assert.equal(supported.supported, true);
  assert.equal(supported.version, "0.9.15");

  const version = parseCodeBurnVersion("codeburn v0.10.0");
  assert.equal(version.version, "0.10.0");
  assert.equal(version.supported, false);
  const unsupported = await detectCodeBurn({
    executor: async () => ({ stdout: "0.10.0\n", stderr: "" }),
  });
  assert.equal(unsupported.available, true);
  assert.equal(unsupported.supported, false);

  const missing = await detectCodeBurn({
    executor: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "not_found");
});

test("invalid or incompatible CodeBurn report content fails closed", () => {
  const missingCounter = fixtureReport();
  delete missingCounter.overview.tokens.cacheRead;
  const validation = validateCodeBurnReport(missingCounter);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /cacheRead/u);
  assert.throws(() => parseCodeBurnReport("{not-json"), /not valid JSON/u);
  assert.throws(
    () => normalizeCodeBurnObservation(fixtureReport(), { query: QUERY, tool_version: "1.0.0" }),
    /unsupported/u,
  );

  const wrongPeriod = fixtureReport();
  wrongPeriod.period = "2026-07-13 to 2026-07-14";
  assert.throws(
    () => normalizeCodeBurnObservation(wrongPeriod, { query: QUERY, tool_version: "0.9.15" }),
    /does not match requested period/u,
  );
});

test("monotonic snapshot deltas are deterministic, hash-bound, and remain advisory", () => {
  const baseline = snapshot("meter-start");
  const currentReport = fixtureReport();
  currentReport.generated = "2026-07-14T09:45:30.000Z";
  currentReport.overview.tokens.input = 100500;
  currentReport.overview.tokens.output = 25250;
  currentReport.overview.tokens.cacheRead = 801000;
  currentReport.overview.calls = 130;
  currentReport.overview.sessions = 3;
  currentReport.overview.cost = 13.0001;
  currentReport.projects[0].calls = 130;
  currentReport.projects[0].cost = 13.0001;
  const current = snapshot("meter-current", currentReport);

  const delta = calculateMeteringDelta(baseline, current, { id: "meter-delta" });
  const replay = calculateMeteringDelta(baseline, current, { id: "meter-delta" });
  assert.deepEqual(delta.usage.tokens, {
    input: 500,
    output: 250,
    cache_read: 1000,
    cache_write: 0,
  });
  assert.equal(delta.usage.calls, 10);
  assert.equal(delta.usage.sessions, 1);
  assert.deepEqual(delta.usage.cost, { amount: "0.6545", currency: "USD" });
  assert.equal(delta.baseline_ref.hash, baseline.snapshot_hash);
  assert.equal(delta.current_ref.hash, current.snapshot_hash);
  assert.equal(delta.assurance.classification, "advisory_observed");
  assert.equal(delta.assurance.trusted_exact, false);
  assert.equal(delta.metering.tokens, "estimated");
  assert.equal(delta.delta_hash, replay.delta_hash);
  assert.equal(validateMeteringDeltaIntegrity(delta).valid, true);
  assert.doesNotThrow(() => assertAgainstSchema(delta, "metering-delta"));
});

test("delta rejects counter resets, scope drift, adapter upgrades, and tampered snapshots", () => {
  const baseline = snapshot("meter-start");
  const resetReport = fixtureReport();
  resetReport.generated = "2026-07-14T10:00:00.000Z";
  resetReport.overview.tokens.input = 99999;
  const reset = snapshot("meter-reset", resetReport);
  assert.throws(
    () => calculateMeteringDelta(baseline, reset, { id: "delta-reset" }),
    /decreased/u,
  );

  const otherProject = snapshot("meter-other-project", fixtureReport(), {
    query: { ...QUERY, project: "OtherProject" },
  });
  assert.throws(
    () => calculateMeteringDelta(baseline, otherProject, { id: "delta-scope" }),
    /different provider\/project\/date filters/u,
  );

  const otherPatch = snapshot("meter-other-patch", fixtureReport(), { tool_version: "0.9.14" });
  assert.throws(
    () => calculateMeteringDelta(baseline, otherPatch, { id: "delta-version" }),
    /different adapter.version/u,
  );

  const tampered = structuredClone(baseline);
  tampered.cumulative.tokens.input += 1;
  assert.equal(validateMeteringSnapshotIntegrity(tampered).valid, false);

  const forgedTrust = structuredClone(baseline);
  forgedTrust.assurance.trusted_exact = true;
  forgedTrust.snapshot_hash = computeMeteringSnapshotHash(forgedTrust);
  const forgedValidation = validateMeteringSnapshotIntegrity(forgedTrust);
  assert.equal(forgedValidation.valid, false);
  assert.match(forgedValidation.errors.join(" "), /never trusted-exact/u);
});
