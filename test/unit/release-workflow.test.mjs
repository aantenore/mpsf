import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CI_GATE_POLICY, requiredCiJobNames } from "../../lib/release/ci-gate.mjs";
import {
  CHECKS_STEPS,
  CI_SHARD_TOTAL,
  SHARDED_PLATFORMS,
  SHARD_TEST_STEP,
  checksJobName,
  shardJobName,
} from "../../lib/release/ci-jobs.mjs";
import { TEST_SHARD_ENV, TEST_TIER_ENV, TEST_TIER_IN_CI_ENV } from "../../scripts/run-test-suite.mjs";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ciWorkflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");


function normalizeLineEndings(source) {
  return source.replace(/\r\n?/gu, "\n");
}


const ciWorkflow = normalizeLineEndings(readFileSync(ciWorkflowPath, "utf8"));
const workflow = normalizeLineEndings(readFileSync(workflowPath, "utf8"));

const ACTION_PINS = new Map([
  ["actions/checkout", "df4cb1c069e1874edd31b4311f1884172cec0e10"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
  ["actions/setup-python", "ece7cb06caefa5fff74198d8649806c4678c61a1"],
  ["actions/upload-artifact", "330a01c490aca151604b8cf639adc76d48f6c5d4"],
  ["actions/download-artifact", "018cc2cf5baa6db3ef3c5f8a56943fffe632ef53"],
  ["actions/attest-build-provenance", "96278af6caaf10aea03fd8d33a09a777ca52d62f"],
]);

const SYFT_PINS = Object.freeze({
  version: "1.42.3",
  amd64: "0d6be741479eddd2c8644a288990c04f3df0d609bbc1599a005532a9dff63509",
  arm64: "dc630590c953347789d08f8ebf57c7d8094db89100785fcd94b1cddeac791804",
});


function jobBlocks(source) {
  const jobsOffset = source.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1, "workflow must contain a top-level jobs mapping");
  const body = source.slice(jobsOffset + "\njobs:\n".length);
  const matches = [...body.matchAll(/^  ([a-z][a-z0-9_-]*):\n/gmu)];
  const result = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? body.length;
    result.set(matches[index][1], body.slice(start, end));
  }
  return result;
}


function actionReferences(source) {
  return [...source.matchAll(/^\s+-?\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
}


const SHARDS = ["1/3", "2/3", "3/3"];
const SHARD_TOTAL = SHARDS.length;
// The steps that do not depend on the shard; in the full suite they run in the checks job only.
const SHARD_INDEPENDENT_COMMANDS = [
  "npm run check",
  "node --test test/unit/test-suite-runner.test.mjs",
  "npm run doctor",
  "npm pack --dry-run",
];
const FULL_NODES = ["18.20.3", "20.12.0", "21.6.0", "24"];
const checkNames = (osName, nodes) => nodes.map((node) => `test (${osName}, ${node})`);
// The status checks every event must produce, by event. Pushes and pull
// requests run the fast job; schedule and manual dispatch run the full suite.
const EXPECTED_CHECKS = {
  pullRequest: [
    ...checkNames("ubuntu-latest", ["24", "18.20.3"]),
    ...checkNames("macos-latest", ["24"]),
    ...checkNames("windows-latest", ["24"]),
  ].sort(),
  push: [
    ...checkNames("ubuntu-latest", FULL_NODES),
    ...checkNames("macos-latest", ["24"]),
    ...checkNames("windows-latest", ["24"]),
  ].sort(),
  full: [
    ...checkNames("ubuntu-latest", FULL_NODES),
    ...checkNames("macos-latest", FULL_NODES),
    ...checkNames("windows-latest", FULL_NODES),
  ].sort(),
};
const EVENT_LABELS = { pullRequest: "pull request", push: "push", full: "full" };
const REQUIRED_PULL_REQUEST_CHECKS = [
  "test (ubuntu-latest, 24)",
  "test (macos-latest, 24)",
  "test (windows-latest, 24)",
];
const CI_JOBS = ["fast", "test-full", "test-shard", "test-checks", "test-sharded"];
const FULL_JOBS = ["test-full", "test-shard", "test-checks", "test-sharded"];
const FAST_IF = "github.event_name == 'push' || github.event_name == 'pull_request'";
const FULL_IF = "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
const FAST_TIMEOUT_MINUTES = 8;
const CONCURRENCY_BLOCK = "concurrency:\n  group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'push' || github.event_name == 'pull_request' }}\n";
const CONCURRENCY_EXPRESSION = /AGENTIC_SDLC_TEST_CONCURRENCY: \$\{\{ matrix\.os == '([^']+)' && matrix\.node == '([^']+)' && '([^']+)' \|\| '([^']+)' \}\}/gu;
const EVENT_MATRIX_EXPRESSION = /^      matrix: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '(\{[^']*\})' \|\| '(\{[^']*\})'\) \}\}$/mu;
const STATIC_MATRIX_EXPRESSION = /^      matrix: \$\{\{ fromJSON\('(\{[^']*\})'\) \}\}$/mu;
// Steps after the scope detection run only when the change set is not
// documentation-only; "!= 'true'" makes a missing or failed output run them.
const NOT_DOCS_ONLY = "steps.scope.outputs.docs_only != 'true'";
const SCOPE_STEP = /^id: scope\n\s+name: Detect Markdown-only changes\n\s+run: node scripts\/ci-change-scope\.mjs\n\s+env:\n\s+CI_EVENT_NAME: \$\{\{ github\.event_name \}\}\n\s+CI_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+CI_BEFORE_SHA: \$\{\{ github\.event\.before \}\}\n(?:\s+# [^\n]+\n\s+CI_ALWAYS_RUN: [^\n]+\n)?/u;
// The fast job's scope step opts the reference cell (ubuntu, Node 24) out of skipping.
const ALWAYS_RUN_ENV = "CI_ALWAYS_RUN: ${{ matrix.os == 'ubuntu-latest' && matrix.node == 24 }}";
const AGGREGATOR_ARGS = `--platform "$MATRIX_OS" --node "$MATRIX_NODE" --shards ${SHARD_TOTAL}`;
const CELL_NAME = /^    name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/mu;
const FAST_TEST_STEP = /- name: Run the test suite\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+run: npm run test:fast\n\s+env:\n\s+PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}\n\s+AGENTIC_SDLC_TEST_CONCURRENCY: "4"\n\s+AGENTIC_SDLC_TEST_TIER_IN_CI: "true"\n/u;
const FULL_TEST_STEP = /- name: Run the test suite\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+run: npm test\n\s+env:\n\s+PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}\n\s+AGENTIC_SDLC_TEST_CONCURRENCY: "4"\n/u;


// Mirrors GitHub's matrix expansion for the subset used here: the cross product
// of the listed axes plus `include` entries that extend it with new combinations.
function expandMatrix(definition) {
  let cells = [{}];
  for (const [axis, values] of Object.entries(definition)) {
    if (axis === "include") continue;
    cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [axis]: String(value) })));
  }
  if (Object.keys(definition).every((axis) => axis === "include")) cells = [];
  for (const extra of definition.include ?? []) {
    const cell = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)]));
    if (!cells.some((known) => Object.entries(cell).every(([key, value]) => known[key] === value))) {
      cells.push(cell);
    }
  }
  return cells;
}


// The fast job selects its cells by event; the full-suite jobs declare one
// static matrix and run only on schedule and manual dispatch.
function fastMatrices(block) {
  const match = EVENT_MATRIX_EXPRESSION.exec(block);
  assert.notEqual(match, null, "the fast matrix must be selected with fromJSON on github.event_name");
  return { pullRequest: expandMatrix(JSON.parse(match[1])), push: expandMatrix(JSON.parse(match[2])) };
}


function staticMatrix(block) {
  const match = STATIC_MATRIX_EXPRESSION.exec(block);
  assert.notEqual(match, null, "a full-suite matrix must be one static fromJSON literal");
  return expandMatrix(JSON.parse(match[1]));
}


function cellNames(cells) {
  return cells.map(({ os: osName, node }) => `test (${osName}, ${node})`).sort();
}


// Every status check one event produces: the fast cells for pushes and pull
// requests; for the full suite, the Linux cells plus the per-OS, per-Node
// aggregators of the sharded platforms (shard and checks jobs are not checks of
// their own).
function eventChecks(source, event) {
  const jobs = jobBlocks(source);
  if (event !== "full") return cellNames(fastMatrices(jobs.get("fast") ?? "")[event]);
  return [
    ...cellNames(staticMatrix(jobs.get("test-full") ?? "")),
    ...cellNames(staticMatrix(jobs.get("test-sharded") ?? "")),
  ].sort();
}


function ciConcurrencyPolicy(source) {
  const policies = [...source.matchAll(CONCURRENCY_EXPRESSION)].map((match) => match.slice(1));
  if (policies.length !== 1) return null;
  const [serializedOs, serializedNode, serializedValue, defaultValue] = policies[0];
  return {
    serializedOs,
    serializedNode,
    serializedValue,
    defaultValue,
    forCell: ({ os: osName, node }) => (
      osName === serializedOs && node === serializedNode ? serializedValue : defaultValue
    ),
  };
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}


// Removes one top-level job (its comments are those above the next job).
function withoutJob(source, id) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `${id} must exist`);
  const next = /\n  [a-z][a-z0-9_-]*:\n/u.exec(source.slice(start + 1));
  return source.slice(0, start + 1) + (next ? source.slice(start + 1 + next.index + 1) : "");
}


// The steps of a job, each without its leading "- ".
function jobSteps(block) {
  const marker = "    steps:\n";
  const offset = block.indexOf(marker);
  return offset === -1 ? [] : block.slice(offset + marker.length).split(/^      - /mu).slice(1);
}


function stepName(step) {
  return /^(?:id: [^\n]+\n\s+)?name: ([^\n]+)$/mu.exec(step)?.[1] ?? null;
}


function stepIsGated(step) {
  return new RegExp(`^\\s+if: ${escapeRegExp(NOT_DOCS_ONLY)}(?: && [^\\n]+)?$`, "mu").test(step);
}


// checkout + setup-node, then the scope detection, then everything else.
function stepLayout(block) {
  const steps = jobSteps(block);
  return {
    leading: steps.slice(0, 2),
    scope: steps[2] ?? "",
    after: steps.slice(3),
  };
}


function jobIf(block) {
  return /^    if: (.+)$/mu.exec(block)?.[1] ?? null;
}


function ciContractErrors(source) {
  const errors = [];
  const jobs = jobBlocks(source);
  const fast = jobs.get("fast") ?? "";
  const full = jobs.get("test-full") ?? "";
  const shard = jobs.get("test-shard") ?? "";
  const checks = jobs.get("test-checks") ?? "";
  const aggregator = jobs.get("test-sharded") ?? "";

  if ([...jobs.keys()].join(",") !== CI_JOBS.join(",")) errors.push("CI job boundary");
  if (!new RegExp(`^    timeout-minutes: ${FAST_TIMEOUT_MINUTES}$`, "mu").test(fast)
    || !/^    timeout-minutes: 35$/mu.test(full)
    || !/^    timeout-minutes: 35$/mu.test(shard)
    || !/^    timeout-minutes: 15$/mu.test(checks)
    || !/^    timeout-minutes: 5$/mu.test(aggregator)) {
    errors.push("CI job timeout");
  }
  if (/continue-on-error:/u.test(source)) errors.push("CI fail-open policy");
  if (!/^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[0-9*/, -]+ [0-9*/, -]+ \* \* \*"\n  workflow_dispatch:\n/mu.test(source)) {
    errors.push("CI triggers");
  }
  if (!source.includes(`\n${CONCURRENCY_BLOCK}`)) errors.push("CI run cancellation");

  // Pushes and pull requests run only the fast job; the full suite runs only on
  // schedule and manual dispatch, so the two never share a run or a check name.
  if (jobIf(fast) !== FAST_IF
    || [full, shard, checks].some((block) => jobIf(block) !== FULL_IF)
    || jobIf(aggregator) !== `always() && (${FULL_IF})`
    || (source.match(/^    if:/gmu) ?? []).length !== CI_JOBS.length) {
    errors.push("CI event split");
  }

  try {
    const fastCells = fastMatrices(fast);
    for (const event of ["pullRequest", "push"]) {
      if (eventChecks(source, event).join("|") !== EXPECTED_CHECKS[event].join("|")) {
        errors.push(`CI ${EVENT_LABELS[event]} matrix`);
      }
      if (fastCells[event].some((cell) => Object.keys(cell).sort().join(",") !== "node,os")) errors.push("CI fast cells");
    }
    if (eventChecks(source, "full").join("|") !== EXPECTED_CHECKS.full.join("|")) errors.push("CI full matrix");
    const fullCells = staticMatrix(full);
    const aggregatorCells = staticMatrix(aggregator);
    if (fullCells.some((cell) => SHARDED_PLATFORMS.includes(cell.os))
      || aggregatorCells.some((cell) => !SHARDED_PLATFORMS.includes(cell.os))) {
      errors.push("CI sharded platforms");
    }
    if (cellNames(staticMatrix(checks)).join("|") !== cellNames(aggregatorCells).join("|")) errors.push("CI checks job");
    const expectedShards = aggregatorCells
      .flatMap(({ os: osName, node }) => SHARDS.map((index) => `${osName}|${node}|${index}`)).sort();
    const actualShards = staticMatrix(shard).map((cell) => `${cell.os}|${cell.node}|${cell.shard}`).sort();
    if (expectedShards.join("#") !== actualShards.join("#")) errors.push("CI shards");
  } catch {
    errors.push("CI matrix selection");
  }
  if (/^\s+(?:os|node):/mu.test(source)) errors.push("CI static matrix axes");

  // The fast job: the fast tier, explicitly allowed under CI, once per cell, on
  // the runner of its own operating system, with the shard-independent checks.
  if (!CELL_NAME.test(fast)
    || !/^    runs-on: \$\{\{ matrix\.os \}\}$/mu.test(fast)
    || !FAST_TEST_STEP.test(fast)
    || (fast.match(/npm run test:fast$/gmu) ?? []).length !== 1
    || /npm test$|AGENTIC_SDLC_TEST_SHARD|benchmark:enterprise/mu.test(fast)
    || SHARD_INDEPENDENT_COMMANDS.some((command) => (
      (fast.match(new RegExp(`^\\s+run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length !== 1
    ))) {
    errors.push("CI fast tier");
  }
  if ((source.match(/test:fast/gu) ?? []).length !== 1
    || (source.match(/AGENTIC_SDLC_TEST_TIER_IN_CI/gu) ?? []).length !== 1
    || /AGENTIC_SDLC_TEST_TIER:/u.test(source)) {
    errors.push("CI fast tier");
  }

  // The full Linux job: the whole suite and the reference performance gate.
  if (!CELL_NAME.test(full)
    || !FULL_TEST_STEP.test(full)
    || (full.match(/npm test$/gmu) ?? []).length !== 1
    || SHARD_INDEPENDENT_COMMANDS.some((command) => (
      (full.match(new RegExp(`^\\s+run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length !== 1
    ))) {
    errors.push("CI full suite");
  }

  const concurrency = ciConcurrencyPolicy(shard);
  if (concurrency === null
    || concurrency.serializedOs !== "macos-latest"
    || concurrency.serializedNode !== "18.20.3"
    || concurrency.serializedValue !== "1"
    || concurrency.defaultValue !== "2"
    || (source.match(/AGENTIC_SDLC_TEST_CONCURRENCY:/gu) ?? []).length !== 3
    || (fast.match(/AGENTIC_SDLC_TEST_CONCURRENCY: "4"$/gmu) ?? []).length !== 1
    || (full.match(/AGENTIC_SDLC_TEST_CONCURRENCY: "4"$/gmu) ?? []).length !== 1) {
    errors.push("CI test concurrency policy");
  }
  if ((source.match(/npm run benchmark:enterprise/gu) ?? []).length !== 1
    || !new RegExp(`- name: Enforce enterprise performance on the required reference runtime\\n\\s+if: ${escapeRegExp(NOT_DOCS_ONLY)} && matrix\\.os == 'ubuntu-latest' && matrix\\.node == 24\\n\\s+run: npm run benchmark:enterprise`, "u").test(full)) {
    errors.push("CI reference performance gate");
  }

  // Shards: one npm test per shard with its own shard selector, on the runner
  // of its own operating system, and none of the shard-independent steps.
  const shardTestStep = /run: npm test\n\s+env:\n((?:\s+[A-Z_]+: .*\n?)+)/u.exec(shard);
  if (!/^    runs-on: \$\{\{ matrix\.os \}\}$/mu.test(shard)
    || !/^    name: test shard \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.shard \}\}\)$/mu.test(shard)
    || (shard.match(/npm test$/gmu) ?? []).length !== 1
    || shardTestStep === null
    || !/^\s+AGENTIC_SDLC_TEST_SHARD: \$\{\{ matrix\.shard \}\}$/mu.test(shardTestStep[1])
    || SHARD_INDEPENDENT_COMMANDS.some((command) => shard.includes(command))
    || /startsWith\(matrix\.shard/u.test(shard)) {
    errors.push("CI shards");
  }

  // The checks job: every shard-independent step exactly once per OS and Node
  // line, on the same OS, without the test suite itself.
  if (!/^    name: checks \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/mu.test(checks)
    || !/^    runs-on: \$\{\{ matrix\.os \}\}$/mu.test(checks)
    || /npm test|setup-python/u.test(checks)
    || SHARD_INDEPENDENT_COMMANDS.some((command) => (
      (checks.match(new RegExp(`^\\s+run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length !== 1
    ))
    || CHECKS_STEPS.some((name) => !checks.includes(`- name: ${name}\n`))) {
    errors.push("CI checks job");
  }

  // The aggregator carries the full-suite check names of the sharded platforms,
  // waits for every shard and checks job even when one fails, and itself fails
  // unless this cell's jobs all passed.
  const verifyRuns = [...aggregator.matchAll(/^        run: node scripts\/verify-ci-shards\.mjs (.*)$/gmu)]
    .map((match) => match[1]);
  if (!CELL_NAME.test(aggregator)
    || !/^    needs: \[test-shard, test-checks\]$/mu.test(aggregator)
    || !/^    runs-on: ubuntu-latest$/mu.test(aggregator)
    || !/^    permissions:\n      actions: read\n      contents: read\n/mu.test(aggregator)
    || verifyRuns.join("|") !== [AGGREGATOR_ARGS, `${AGGREGATOR_ARGS} --require-executed`].join("|")
    || (aggregator.match(/^          MATRIX_OS: \$\{\{ matrix\.os \}\}$/gmu) ?? []).length !== 2
    || (aggregator.match(/^          MATRIX_NODE: \$\{\{ matrix\.node \}\}$/gmu) ?? []).length !== 2
    || (aggregator.match(/^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/gmu) ?? []).length !== 2
    || /\|\| true|continue-on-error/u.test(aggregator)) {
    errors.push("CI sharded aggregator");
  }

  // Documentation-only changes skip the suite step by step, never the job.
  const layouts = [
    [fast, 6],
    [full, 7],
    [shard, 2],
    [checks, CHECKS_STEPS.length],
    [aggregator, 2],
  ];
  for (const [block, afterCount] of layouts) {
    const { leading, scope, after } = stepLayout(block);
    const alwaysRun = scope.includes(ALWAYS_RUN_ENV);
    if (alwaysRun !== (block === fast || block === full)
      || (scope.match(/CI_ALWAYS_RUN/gu) ?? []).length !== (block === fast || block === full ? 1 : 0)) {
      errors.push("CI reference cell skips");
    }
    if (leading.length !== 2
      || !/^uses: actions\/checkout@/u.test(leading[0])
      || !/^uses: actions\/setup-node@/u.test(leading[1])
      || !SCOPE_STEP.test(scope)
      || after.length !== afterCount) {
      errors.push("CI docs-only skip");
    }
    if (block !== aggregator && !after.every(stepIsGated)) errors.push("CI docs-only skip");
  }
  {
    const [verify, confirm] = stepLayout(aggregator).after;
    if (verify === undefined || confirm === undefined
      || stepName(verify) !== "Require every shard of this Node line"
      || /^\s+if:/mu.test(verify)
      || stepName(confirm) !== "Confirm every shard ran the test suite"
      || !stepIsGated(confirm)
      || !/--require-executed$/mu.test(confirm)) {
      errors.push("CI docs-only skip");
    }
  }
  if ((source.match(/run: node scripts\/ci-change-scope\.mjs$/gmu) ?? []).length !== CI_JOBS.length) errors.push("CI docs-only skip");

  const actions = actionReferences(source);
  const counts = new Map();
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1);
  const checkout = `actions/checkout@${ACTION_PINS.get("actions/checkout")}`;
  const setupNode = `actions/setup-node@${ACTION_PINS.get("actions/setup-node")}`;
  const setupPython = `actions/setup-python@${ACTION_PINS.get("actions/setup-python")}`;
  if (actions.length !== 13
    || counts.get(checkout) !== 5
    || counts.get(setupNode) !== 5
    || counts.get(setupPython) !== 3
    || actions.some((action) => {
      const separator = action.lastIndexOf("@");
      return separator < 1
        || ACTION_PINS.get(action.slice(0, separator)) !== action.slice(separator + 1);
    })) {
    errors.push("CI immutable action pins");
  }
  if ((source.match(/persist-credentials: false/gu) ?? []).length !== 5
    || (source.match(/package-manager-cache: false/gu) ?? []).length !== 5) {
    errors.push("CI checkout and cache policy");
  }
  if ([fast, full, checks].some((block) => (
    (block.match(/node --test test\/unit\/test-suite-runner\.test\.mjs/gu) ?? []).length !== 1
  ))) {
    errors.push("CI test-runner bootstrap canary");
  }
  return errors;
}


function releaseContractErrors(source) {
  const errors = [];
  const jobs = jobBlocks(source);
  const verify = jobs.get("verify") ?? "";
  const packageJob = jobs.get("package") ?? "";
  const publish = jobs.get("publish") ?? "";
  const jobNames = [...jobs.keys()];

  if (jobNames.join(",") !== "verify,package,publish") errors.push("job order");
  if (!/^permissions: \{\}$/mu.test(source)) errors.push("default permissions");
  if (!/^  cancel-in-progress: false$/mu.test(source)) errors.push("concurrency cancellation");
  if (/continue-on-error:/u.test(source)) errors.push("release fail-open policy");
  if (/workflow_dispatch|pull_request|schedule:/u.test(source)) errors.push("tag-only trigger");
  if (!/^    tags:\n      - "v\*"$/mu.test(source)) errors.push("release tag trigger");
  if (!/timeout-minutes: 75/u.test(verify)
    || !/timeout-minutes: 15/u.test(packageJob)
    || !/timeout-minutes: 15/u.test(publish)) errors.push("job timeouts");
  if (!/needs: verify/u.test(packageJob) || !/needs: package/u.test(publish)) errors.push("job dependencies");
  if (!/^    permissions:\n      actions: read\n      contents: read\n/mu.test(verify)
    || /contents: write|id-token|attestations/u.test(verify)) errors.push("verify permissions");
  if (!/^    runs-on: ubuntu-latest$/mu.test(verify)
    || /strategy:|matrix[.:]|npm test|npm run benchmark:enterprise|npm pack /u.test(verify)) {
    errors.push("release gate is a single job that does not re-run the matrix");
  }
  if ((verify.match(/^        run: node scripts\/verify-ci-gate\.mjs$/gmu) ?? []).length !== 1
    || !/GITHUB_TOKEN: \$\{\{ github\.token \}\}/u.test(verify)
    || /continue-on-error:|\|\| true|if:/u.test(verify)) errors.push("exact-SHA full-matrix CI gate");
  if (!/attestations: write/u.test(packageJob)
    || !/contents: write/u.test(packageJob)
    || !/id-token: write/u.test(packageJob)) errors.push("package permissions");
  if (!/attestations: read/u.test(publish)
    || !/contents: write/u.test(publish)
    || /id-token: write/u.test(publish)) errors.push("publish permissions");

  const actions = [...source.matchAll(/^\s+-?\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
  if (actions.length !== 10) errors.push("action count");
  for (const action of actions) {
    const separator = action.lastIndexOf("@");
    const name = action.slice(0, separator);
    const ref = action.slice(separator + 1);
    if (separator < 1 || ACTION_PINS.get(name) !== ref || !/^[0-9a-f]{40}$/u.test(ref)) {
      errors.push(`unpinned action: ${action}`);
    }
  }
  for (const name of ACTION_PINS.keys()) {
    if (!actions.some((action) => action.startsWith(`${name}@`))) errors.push(`missing action: ${name}`);
  }

  const pythonAction = `actions/setup-python@${ACTION_PINS.get("actions/setup-python")}`;
  if (actions.filter((action) => action === pythonAction).length !== 1
    || (source.match(/python-version: "3\.13\.14"/gu) ?? []).length !== 1
    || (source.match(/update-environment: false/gu) ?? []).length !== 1
    || /PYTHON/u.test(verify)
    || (packageJob.match(/PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}/gu) ?? []).length !== 1
    || (source.match(/--python "\$PYTHON"/gu) ?? []).length !== 1) {
    errors.push("explicit Python provisioning");
  }
  if (!/scripts\/verify-release-package\.mjs/u.test(packageJob)
    || /scripts\/verify-release-package\.mjs/u.test(verify)
    || (packageJob.match(/^        run: npm run check$/gmu) ?? []).length !== 1
    || packageJob.indexOf("run: npm run check") > packageJob.indexOf("npm pack ")) {
    errors.push("package job source check and policy verifier");
  }
  if (!/npm install[\s\S]*"file:\$ARCHIVE_PATH"/u.test(packageJob)) {
    errors.push("SBOM local archive spec");
  }
  if (!/verification\.value\?\.smoke\?\.installer_v2_plan !== "passed"/u.test(packageJob)
    || !/verification\.value\?\.smoke\?\.installer_v2_zero_write !== true/u.test(packageJob)) {
    errors.push("installer v2 seal gate");
  }
  if ((packageJob.match(/npm pack /gu) ?? []).length !== 1
    || /npm pack /u.test(publish)) errors.push("single-build handoff");
  if (!/pack_report="\$RUNNER_TEMP\/npm-pack\.json"/u.test(packageJob)
    || !/test ! -e "\$pack_report"/u.test(packageJob)
    || !/> "\$pack_report"/u.test(packageJob)
    || !/' "\$pack_report"\)"/u.test(packageJob)
    || /release\/npm-pack\.json/u.test(packageJob)) errors.push("isolated pack report");
  if (!packageJob.includes(`syft/releases/download/v${SYFT_PINS.version}/`)
    || !packageJob.includes(SYFT_PINS.amd64)
    || !packageJob.includes(SYFT_PINS.arm64)
    || !/sha256sum --check --strict/u.test(packageJob)
    || !/--proto '=https'[\s\S]*--proto-redir '=https'/u.test(packageJob)
    || !/npm install[\s\S]*--ignore-scripts[\s\S]*--offline/u.test(packageJob)
    || !/dir:\$SBOM_SOURCE/u.test(packageJob)
    || !/--override-default-catalogers javascript-package-cataloger/u.test(packageJob)
    || !/spdx-json=/u.test(packageJob)
    || !/cyclonedx-json=/u.test(packageJob)
    || /anchore\/sbom-action|raw\.githubusercontent\.com\/anchore\/syft\/main/u.test(packageJob)
    || !/validateReleaseBundleDirectory/u.test(publish)) errors.push("SBOM gates");
  if (!/actions\/attest-build-provenance@/u.test(packageJob)
    || !/gh attestation verify/u.test(packageJob)
    || !/gh attestation verify/u.test(publish)) errors.push("provenance gates");
  if (!/overwrite: false/u.test(packageJob)
    || !/artifact_digest/u.test(packageJob)
    || !/artifact_id/u.test(packageJob)
    || !/EXPECTED_ARTIFACT_DIGEST/u.test(publish)
    || !/actions\/artifacts\/\$EXPECTED_ARTIFACT_ID\/zip/u.test(publish)
    || !/test "\$actual_artifact_digest" = "\$expected_artifact_digest"/u.test(publish)
    || !/actions\/download-artifact@/u.test(publish)) errors.push("immutable artifact handoff");
  if ((source.match(/package-manager-cache: false/gu) ?? []).length !== 3) errors.push("setup-node cache policy");
  const recoveryValidation = packageJob.indexOf("const result = validateMatchingReleaseBundles");
  const recoveryDeletion = packageJob.indexOf('gh release delete "$GITHUB_REF_NAME" --yes');
  if (!/GITHUB_RUN_ID-attempt-\$GITHUB_RUN_ATTEMPT/u.test(packageJob)
    || recoveryValidation < 0
    || recoveryDeletion < recoveryValidation
    || !/already_published=/u.test(packageJob)
    || (packageJob.match(/steps\.remote_state\.outputs\.already_published != 'true'/gu) ?? []).length !== 2
    || !/gh release delete "\$GITHUB_REF_NAME" --yes/u.test(packageJob)
    || /--cleanup-tag/u.test(packageJob)) errors.push("retry recovery");
  if (!source.includes("[A-Za-z0-9._+-]*\\.tgz")
    || !/parseReleaseTag/u.test(packageJob)
    || !/EXPECTED_PRERELEASE/u.test(packageJob)
    || /includes\("-"\)|== \*-\*/u.test(source)) errors.push("strict SemVer identity");
  if (!/gh release create/u.test(packageJob)
    || !/--draft/u.test(packageJob)
    || !/remote draft/u.test(packageJob)
    || /--draft=false/u.test(packageJob)) errors.push("draft-first package gate");
  if (!/gh release download/u.test(packageJob)
    || !/gh release download/u.test(publish)
    || (source.match(/const result = validateMatchingReleaseBundles/gu) ?? []).length < 4) errors.push("remote byte verification");
  const publishValidation = publish.indexOf("const result = validateMatchingReleaseBundles");
  const publishEdit = publish.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false');
  const finalPublishValidation = publish.lastIndexOf("const result = validateMatchingReleaseBundles");
  if (!/startsWith\(github\.ref, 'refs\/tags\/v'\)/u.test(publish)
    || (source.match(/git rev-parse --verify/gu) ?? []).length !== 4
    || !/gh release edit "\$GITHUB_REF_NAME" --draft=false/u.test(publish)
    || publishValidation < 0
    || publishEdit < publishValidation
    || finalPublishValidation < publishEdit
    || !/ALREADY_PUBLISHED/u.test(publish)
    || !/timeout --signal=TERM --kill-after=15s 60s/u.test(publish)
    || !/publication_deadline=\$\(\(SECONDS \+ 120\)\)/u.test(publish)) errors.push("publish gate");
  return errors;
}


function inlineNodeModule(stepName) {
  const marker = `      - name: ${stepName}\n`;
  const stepStart = workflow.indexOf(marker);
  assert.notEqual(stepStart, -1, `missing workflow step: ${stepName}`);
  const stepEnd = workflow.indexOf("\n      - name: ", stepStart + marker.length);
  const step = workflow.slice(stepStart, stepEnd === -1 ? workflow.length : stepEnd);
  const heredoc = "node --input-type=module <<'NODE'\n";
  const scriptStart = step.indexOf(heredoc);
  assert.notEqual(scriptStart, -1, `missing inline Node module: ${stepName}`);
  const bodyStart = scriptStart + heredoc.length;
  const bodyEnd = step.indexOf("\n          NODE", bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated inline Node module: ${stepName}`);
  return `${step.slice(bodyStart, bodyEnd).replace(/^ {10}/gmu, "")}\n`;
}


function runInlineModule(script, { cwd, env }) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: script,
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 10_000,
  });
}


function sha256(file) {
  return crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
}


test("release workflow is tag-only, least-privilege, ordered, and bounded", () => {
  assert.deepEqual(releaseContractErrors(workflow), []);
  assert.equal(workflow.includes("\t"), false, "workflow must not contain tab indentation");
});


test("workflow source normalization accepts Windows checkouts", () => {
  for (const source of [ciWorkflow, workflow]) {
    const crlf = source.replace(/\n/gu, "\r\n");
    assert.equal(normalizeLineEndings(crlf), source);
  }
  assert.deepEqual(
    releaseContractErrors(normalizeLineEndings(workflow.replace(/\n/gu, "\r\n"))),
    [],
  );
});


test("CI pins actions and separates the fast tier from the full suite and the performance gate", () => {
  assert.deepEqual(ciContractErrors(ciWorkflow), []);
  assert.match(
    ciWorkflow,
    /- id: python\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+uses: actions\/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1\n\s+with:\n\s+python-version: "3\.13\.14"\n\s+update-environment: false/u,
  );
  const jobs = jobBlocks(ciWorkflow);
  assert.match(jobs.get("fast"), FAST_TEST_STEP);
  assert.match(jobs.get("test-full"), FULL_TEST_STEP);
  for (const id of ["fast", "test-full", "test-checks"]) {
    assert.match(
      jobs.get(id),
      /- name: Verify bounded test-runner bootstrap\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+run: node --test test\/unit\/test-suite-runner\.test\.mjs/u,
      id,
    );
  }
  // The runner refuses a tier under CI unless the workflow names this opt-in.
  assert.equal(TEST_TIER_IN_CI_ENV, "AGENTIC_SDLC_TEST_TIER_IN_CI");
  assert.equal(TEST_TIER_ENV, "AGENTIC_SDLC_TEST_TIER");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts["test:fast"], "node scripts/run-test-suite.mjs --tier=fast");
  assert.equal(manifest.scripts.test, "node scripts/run-test-suite.mjs");
});


test("pushes and pull requests run the fast job; schedule and manual dispatch run the full suite", () => {
  for (const event of ["pullRequest", "push", "full"]) {
    assert.deepEqual(eventChecks(ciWorkflow, event), EXPECTED_CHECKS[event], event);
  }
  assert.equal(EXPECTED_CHECKS.pullRequest.length, 4);
  assert.equal(EXPECTED_CHECKS.push.length, 6);
  assert.equal(EXPECTED_CHECKS.full.length, 12);
  const jobs = jobBlocks(ciWorkflow);
  assert.equal(jobIf(jobs.get("fast")), FAST_IF);
  for (const id of ["test-full", "test-shard", "test-checks"]) assert.equal(jobIf(jobs.get(id)), FULL_IF, id);
  assert.equal(jobIf(jobs.get("test-sharded")), `always() && (${FULL_IF})`);
  assert.match(
    ciWorkflow,
    /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[^"\n]+"\n  workflow_dispatch:\n/mu,
  );
  // A newer push or pull request update cancels the older fast run; full runs are never cancelled.
  assert.ok(ciWorkflow.includes(`\n${CONCURRENCY_BLOCK}`));
  // Every fast cell stays bounded; the full Linux job is Linux only.
  assert.match(jobs.get("fast"), new RegExp(`^    timeout-minutes: ${FAST_TIMEOUT_MINUTES}$`, "mu"));
  assert.ok(FAST_TIMEOUT_MINUTES <= 8);
  assert.deepEqual([...new Set(staticMatrix(jobs.get("test-full")).map((cell) => cell.os))], ["ubuntu-latest"]);
});


test("the fast job carries the required check names, one job per cell on its own OS", () => {
  const fast = jobBlocks(ciWorkflow).get("fast");
  assert.match(fast, CELL_NAME);
  assert.match(fast, /^    runs-on: \$\{\{ matrix\.os \}\}$/mu);
  for (const name of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(eventChecks(ciWorkflow, "pullRequest").includes(name), name);
    assert.ok(eventChecks(ciWorkflow, "push").includes(name), name);
  }
  for (const command of SHARD_INDEPENDENT_COMMANDS) {
    assert.equal((fast.match(new RegExp(`run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length, 1, command);
  }
  assert.doesNotMatch(fast, /npm test$|AGENTIC_SDLC_TEST_SHARD|benchmark:enterprise/mu);
});


test("macOS and Windows run the full suite as three shards per Node line, each carrying its own shard selector", () => {
  const jobs = jobBlocks(ciWorkflow);
  const shard = jobs.get("test-shard");
  const aggregator = jobs.get("test-sharded");
  assert.equal(SHARD_TOTAL, CI_SHARD_TOTAL);
  assert.deepEqual([...SHARDED_PLATFORMS].sort(), ["macos-latest", "windows-latest"]);
  const cells = staticMatrix(aggregator);
  assert.deepEqual([...new Set(cells.map((cell) => cell.os))].sort(), [...SHARDED_PLATFORMS].sort());
  assert.deepEqual(
    staticMatrix(shard).map((cell) => shardJobName(cell.os, cell.node, ...cell.shard.split("/").map(Number))).sort(),
    cells.flatMap(({ os: osName, node }) => [1, 2, 3].map((index) => shardJobName(osName, node, index, CI_SHARD_TOTAL))).sort(),
  );
  assert.match(shard, /AGENTIC_SDLC_TEST_SHARD: \$\{\{ matrix\.shard \}\}/u);
  assert.equal(TEST_SHARD_ENV, "AGENTIC_SDLC_TEST_SHARD");
  assert.match(shard, new RegExp(`- name: ${escapeRegExp(SHARD_TEST_STEP)}\\n`, "u"));
  assert.match(aggregator, new RegExp(`--shards ${CI_SHARD_TOTAL}`, "u"));
  for (const command of SHARD_INDEPENDENT_COMMANDS) assert.equal(shard.includes(command), false, command);
  const checks = jobs.get("test-checks");
  assert.deepEqual(
    staticMatrix(checks).map(({ os: osName, node }) => checksJobName(osName, node)).sort(),
    cells.map(({ os: osName, node }) => checksJobName(osName, node)).sort(),
  );
  for (const name of CHECKS_STEPS) assert.match(checks, new RegExp(`- name: ${escapeRegExp(name)}\\n`, "u"), name);
  assert.doesNotMatch(checks, /npm test|setup-python/u);
  assert.match(aggregator, CELL_NAME);
  assert.match(aggregator, /^    needs: \[test-shard, test-checks\]$/mu);
  assert.match(aggregator, /^      actions: read$/mu);
  assert.doesNotMatch(aggregator, /continue-on-error|\|\| true/u);
});


test("the release gate requires exactly the cells that the fast push run produces", () => {
  assert.deepEqual([...requiredCiJobNames()].sort(), eventChecks(ciWorkflow, "push"));
  assert.equal(requiredCiJobNames().length, 6);
  assert.deepEqual(
    CI_GATE_POLICY.cells.map(({ platform, node }) => `${platform}|${node}`),
    [
      "ubuntu-latest|18.20.3",
      "ubuntu-latest|20.12.0",
      "ubuntu-latest|21.6.0",
      "ubuntu-latest|24",
      "macos-latest|24",
      "windows-latest|24",
    ],
  );
  assert.equal(CI_GATE_POLICY.workflowFile, "ci.yml");
  assert.equal(CI_GATE_POLICY.event, "push");
  assert.equal(CI_GATE_POLICY.branch, "main");
  for (const name of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(requiredCiJobNames().includes(name), `${name} must also be required by the release gate`);
  }
  // The gate's "the suite ran" marker is the fast job's gated test step on every platform,
  // and no platform is judged as a shard aggregator because the push run shards nothing.
  const fast = jobBlocks(ciWorkflow).get("fast");
  assert.deepEqual(CI_GATE_POLICY.shardedPlatforms, []);
  for (const { platform } of CI_GATE_POLICY.cells) {
    const marker = stepLayout(fast).after.find((step) => stepName(step) === CI_GATE_POLICY.executedStep(platform));
    assert.ok(marker !== undefined && stepIsGated(marker), platform);
  }
});


test("a documentation-only change skips steps, never jobs, and never counts as verification", () => {
  const jobs = jobBlocks(ciWorkflow);
  for (const id of CI_JOBS) {
    const { scope, after } = stepLayout(jobs.get(id));
    assert.match(scope, SCOPE_STEP, id);
    assert.ok(after.length > 0);
  }
  const { after } = stepLayout(jobs.get("test-sharded"));
  assert.equal(stepIsGated(after[0]), false);
  assert.equal(stepIsGated(after[1]), true);
  assert.match(ciWorkflow, /CI_EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  // Tests read README.md and docs/, so ubuntu Node 24 never skips; nothing else opts out.
  for (const id of ["fast", "test-full"]) assert.ok(stepLayout(jobs.get(id)).scope.includes(ALWAYS_RUN_ENV), id);
  for (const id of ["test-shard", "test-checks", "test-sharded"]) {
    assert.doesNotMatch(jobs.get(id), /CI_ALWAYS_RUN/u, id);
  }
  for (const id of ["fast", "test-full", "test-shard", "test-checks"]) {
    assert.ok(stepLayout(jobs.get(id)).after.every(stepIsGated), id);
  }
});


test("CI serializes only macOS Node 18.20.3 shards and gives the fast and full Linux jobs four workers", () => {
  const jobs = jobBlocks(ciWorkflow);
  const policy = ciConcurrencyPolicy(jobs.get("test-shard"));
  assert.notEqual(policy, null);
  assert.deepEqual(
    [policy.serializedOs, policy.serializedNode, policy.serializedValue, policy.defaultValue],
    ["macos-latest", "18.20.3", "1", "2"],
  );
  const perCell = staticMatrix(jobs.get("test-shard")).map((cell) => [`${cell.os}/${cell.node}`, policy.forCell(cell)]);
  assert.deepEqual([...new Set(perCell.filter(([, value]) => value === "1").map(([name]) => name))], ["macos-latest/18.20.3"]);
  assert.equal(new Set(perCell.filter(([, value]) => value === "2").map(([name]) => name)).size, 7);
  for (const id of ["fast", "test-full"]) {
    assert.match(jobs.get(id), /AGENTIC_SDLC_TEST_CONCURRENCY: "4"$/mu, id);
    assert.doesNotMatch(jobs.get(id), /matrix\.os == 'macos-latest'/u, id);
  }
  // The release no longer runs tests, so it must not carry its own concurrency policy.
  assert.equal(/AGENTIC_SDLC_TEST_CONCURRENCY/u.test(workflow), false);
});


// Replaces text inside one job of the workflow only, so a fixture cannot
// accidentally change a similar line of another job.
function replaceInJob(source, id, from, to) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `${id} must exist`);
  const next = /\n  [a-z][a-z0-9_-]*:\n/u.exec(source.slice(start + 1));
  const end = next ? start + 1 + next.index : source.length;
  const block = source.slice(start, end);
  assert.ok(block.includes(from), `${id} must contain: ${from}`);
  return source.slice(0, start) + block.replace(from, () => to) + source.slice(end);
}


const SHARD_STEP_HEAD = "      - name: Run this shard of the test suite\n";


test("CI guards reject weakened fast, full, shard, aggregator, and skip policies", () => {
  const doctorStep = "      - name: Run the installation doctor\n        if: steps.scope.outputs.docs_only != 'true'\n        run: npm run doctor\n";
  const fixtures = [
    ["fast job runs the full suite", replaceInJob(ciWorkflow, "fast", "run: npm run test:fast", "run: npm test"), "CI fast tier"],
    ["fast tier without the CI opt-in", ciWorkflow.replace('          AGENTIC_SDLC_TEST_TIER_IN_CI: "true"\n', ""), "CI fast tier"],
    ["full suite runs the fast tier", replaceInJob(ciWorkflow, "test-full", "run: npm test\n", "run: npm run test:fast\n"), "CI full suite"],
    ["fast job without its bound", replaceInJob(ciWorkflow, "fast", `timeout-minutes: ${FAST_TIMEOUT_MINUTES}\n`, "timeout-minutes: 35\n"), "CI job timeout"],
    ["fast job on schedule too", replaceInJob(ciWorkflow, "fast", `    if: ${FAST_IF}\n`, ""), "CI event split"],
    ["full suite on every push", replaceInJob(ciWorkflow, "test-full", `    if: ${FULL_IF}\n`, ""), "CI event split"],
    ["aggregator skipped when a shard fails", replaceInJob(ciWorkflow, "test-sharded", `    if: always() && (${FULL_IF})\n`, `    if: ${FULL_IF}\n`), "CI event split"],
    ["superseded runs not cancelled", ciWorkflow.replace("  cancel-in-progress: ${{ github.event_name == 'push' || github.event_name == 'pull_request' }}\n", "  cancel-in-progress: false\n"), "CI run cancellation"],
    ["required pull request cell dropped", replaceInJob(ciWorkflow, "fast", ',{"os":"windows-latest","node":24}]}\' ||', "]}' ||"), "CI pull request matrix"],
    ["push cell dropped", replaceInJob(ciWorkflow, "fast", ',{"os":"ubuntu-latest","node":"21.6.0"}', ""), "CI push matrix"],
    ["schedule removed", ciWorkflow.replace(/  schedule:\n    - cron: "[^"]+"\n/u, ""), "CI triggers"],
    ["manual dispatch removed", ciWorkflow.replace("  workflow_dispatch:\n", ""), "CI triggers"],
    ["shard job removed", withoutJob(ciWorkflow, "test-shard"), "CI job boundary"],
    ["a shard dropped", ciWorkflow.replaceAll('"shard":["1/3","2/3","3/3"]', '"shard":["1/3","2/3"]'), "CI shards"],
    ["shard without its selector", ciWorkflow.replace("          AGENTIC_SDLC_TEST_SHARD: ${{ matrix.shard }}\n", ""), "CI shards"],
    ["shard carrying a shard-independent step", replaceInJob(ciWorkflow, "test-shard", SHARD_STEP_HEAD, `${doctorStep}${SHARD_STEP_HEAD}`), "CI shards"],
    ["shard on the wrong runner", replaceInJob(ciWorkflow, "test-shard", "    runs-on: ${{ matrix.os }}\n", "    runs-on: ubuntu-latest\n"), "CI shards"],
    ["aggregator without its checks dependency", ciWorkflow.replace("    needs: [test-shard, test-checks]\n", "    needs: test-shard\n"), "CI sharded aggregator"],
    ["benchmark moved to the fast job", replaceInJob(ciWorkflow, "fast", "      - name: Run the installation doctor\n", "      - name: Enforce enterprise performance on the required reference runtime\n        if: steps.scope.outputs.docs_only != 'true'\n        run: npm run benchmark:enterprise\n      - name: Run the installation doctor\n"), "CI reference performance gate"],
    ["ungated fast test step", replaceInJob(ciWorkflow, "fast", "        if: steps.scope.outputs.docs_only != 'true'\n        run: npm run test:fast\n", "        run: npm run test:fast\n"), "CI docs-only skip"],
    ["fail-open step", replaceInJob(ciWorkflow, "fast", "        run: npm run doctor\n", "        run: npm run doctor\n        continue-on-error: true\n"), "CI fail-open policy"],
    ["mutable action", ciWorkflow.replace("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10", "actions/checkout@v4"), "CI immutable action pins"],
    ["serialized shard concurrency changed", ciWorkflow.replace("&& '1' ||", "&& '2' ||"), "CI test concurrency policy"],
  ];
  for (const [name, source, expected] of fixtures) {
    assert.notEqual(source, ciWorkflow, `${name} must change the workflow`);
    assert.ok(ciContractErrors(source).includes(expected), `${name}: ${JSON.stringify(ciContractErrors(source))}`);
  }
});


test("the release gate is one Linux job instead of a re-run of the test matrix", () => {
  const verify = jobBlocks(workflow).get("verify");
  assert.doesNotMatch(verify, /strategy:|matrix[.:]|npm test|benchmark:enterprise|npm pack |setup-python/u);
  assert.match(verify, /runs-on: ubuntu-latest/u);
  assert.match(verify, /actions: read\n\s+contents: read/u);
  assert.match(verify, /run: node scripts\/verify-ci-gate\.mjs/u);
  assert.match(jobBlocks(workflow).get("package"), /needs: verify/u);
  assert.match(workflow, /^concurrency:\n  group: release-.*\n  cancel-in-progress: false$/mu);
  // The packed artifact is still smoke-verified exactly once, in the package job.
  assert.equal((workflow.match(/node scripts\/verify-release-package\.mjs|scripts\/verify-release-package\.mjs/gu) ?? []).length, 1);
  assert.equal((workflow.match(/^\s+run: npm run check$/gmu) ?? []).length, 1);
  // The benchmark that used to run in the release matrix runs with the full suite.
  assert.match(
    jobBlocks(ciWorkflow).get("test-full"),
    /if: steps\.scope\.outputs\.docs_only != 'true' && matrix\.os == 'ubuntu-latest' && matrix\.node == 24\n\s+run: npm run benchmark:enterprise/u,
  );
});


test("release workflow guards detect unsafe maintenance regressions", () => {
  const fixtures = [
    {
      name: "mutable action",
      source: workflow.replace(`actions/checkout@${ACTION_PINS.get("actions/checkout")}`, "actions/checkout@v6"),
      expected: "unpinned action",
    },
    {
      name: "manual release trigger",
      source: workflow.replace("  push:\n", "  workflow_dispatch:\n  push:\n"),
      expected: "tag-only trigger",
    },
    {
      name: "cancellable release",
      source: workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"),
      expected: "concurrency cancellation",
    },
    {
      name: "release gate turned back into a matrix",
      source: workflow.replace("    runs-on: ubuntu-latest\n    steps:\n      - name: Check out the tagged source", "    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check out the tagged source"),
      expected: "release gate is a single job",
    },
    {
      name: "fail-open release gate",
      source: workflow.replace(
        "        run: node scripts/verify-ci-gate.mjs\n",
        "        run: node scripts/verify-ci-gate.mjs\n        continue-on-error: true\n",
      ),
      expected: "release fail-open policy",
    },
    // Merged from "CI fails closed without the independent runner canary and the release without its CI gate".
    {
      name: "release gate verification replaced by a no-op",
      source: workflow.replace("run: node scripts/verify-ci-gate.mjs", "run: true"),
      expected: "exact-SHA full-matrix CI gate",
      exact: true,
    },
    {
      name: "release gate marked fail-open before its run step",
      source: workflow.replace("        run: node scripts/verify-ci-gate.mjs", "        continue-on-error: true\n        run: node scripts/verify-ci-gate.mjs"),
      expected: "exact-SHA full-matrix CI gate",
      exact: true,
    },
    {
      name: "release gate without its GitHub token",
      source: workflow.replace("          GITHUB_TOKEN: ${{ github.token }}\n", ""),
      expected: "exact-SHA full-matrix CI gate",
      exact: true,
    },
    {
      name: "release gate without Actions read permission",
      source: workflow.replace("      actions: read\n", ""),
      expected: "verify permissions",
      exact: true,
    },
    {
      name: "release gate with write permission",
      source: workflow.replace("      actions: read\n      contents: read\n", "      actions: read\n      contents: write\n"),
      expected: "verify permissions",
    },
    {
      name: "package job without the source check",
      source: workflow.replace("      - name: Check source syntax\n        run: npm run check\n", ""),
      expected: "package job source check",
    },
    {
      name: "package job not waiting for the gate",
      source: workflow.replace("    needs: verify\n", ""),
      expected: "job dependencies",
    },
    {
      name: "package without draft",
      source: workflow.replace("            --draft\n", ""),
      expected: "draft-first package gate",
    },
    {
      name: "rebuild during publish",
      source: workflow.replace("          set -euo pipefail\n          tag_commit=", "          set -euo pipefail\n          npm pack --ignore-scripts\n          tag_commit="),
      expected: "single-build handoff",
    },
    {
      name: "publish without provenance verification",
      source: workflow.replace("          gh attestation verify \"release/$ARCHIVE_NAME\" --repo \"$GITHUB_REPOSITORY\"", "          true"),
      expected: "provenance gates",
    },
    {
      name: "mutable Syft installer",
      source: workflow.replace(
        `https://github.com/anchore/syft/releases/download/v${SYFT_PINS.version}/$syft_asset`,
        "https://raw.githubusercontent.com/anchore/syft/main/install.sh",
      ),
      expected: "SBOM gates",
    },
    {
      name: "archive path parsed as a Git shorthand",
      source: workflow.replace('"file:$ARCHIVE_PATH"', '"$ARCHIVE_PATH"'),
      expected: "SBOM local archive spec",
    },
    {
      name: "npm pack report stored inside the sealed bundle",
      source: workflow.replace(
        'pack_report="$RUNNER_TEMP/npm-pack.json"',
        'pack_report="release/npm-pack.json"',
      ),
      expected: "isolated pack report",
    },
    {
      name: "implicit setup-node cache",
      source: workflow.replace("          package-manager-cache: false\n", ""),
      expected: "setup-node cache policy",
    },
    {
      name: "implicit Python interpreter",
      source: workflow.replace('            --python "$PYTHON" \\\n', ""),
      expected: "explicit Python provisioning",
    },
    {
      name: "digest format without enforcement",
      source: workflow.replace("          test \"$actual_artifact_digest\" = \"$expected_artifact_digest\"\n", ""),
      expected: "immutable artifact handoff",
    },
    {
      name: "draft deletion before complete byte proof",
      source: workflow.replace("const result = validateMatchingReleaseBundles({", "const result = validateReleaseMetadata({"),
      expected: "retry recovery",
    },
    {
      name: "published rerun forced through draft creation",
      source: workflow.replace("        if: ${{ steps.remote_state.outputs.already_published != 'true' }}\n", ""),
      expected: "retry recovery",
    },
    {
      name: "unbounded publication client",
      source: workflow.replace("timeout --signal=TERM --kill-after=15s 60s", "gh-timeout-removed"),
      expected: "publish gate",
    },
    {
      name: "release seal without installer v2 plan proof",
      source: workflow.replace('            || verification.value?.smoke?.installer_v2_plan !== "passed"\n', ""),
      expected: "installer v2 seal gate",
    },
  ];
  for (const fixture of fixtures) {
    const errors = releaseContractErrors(fixture.source);
    assert.ok(
      fixture.exact ? errors.includes(fixture.expected) : errors.some((error) => error.includes(fixture.expected)),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
});


test("the exact inline seal and publish validators accept a valid fixture and reject tampering", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-fixture-"));
  try {
    const releaseRoot = path.join(temporary, "release");
    mkdirSync(releaseRoot);
    mkdirSync(path.join(temporary, "config"));
    mkdirSync(path.join(temporary, "lib", "release"), { recursive: true });
    mkdirSync(path.join(temporary, "lib", "runtime"), { recursive: true });
    for (const module of [["release", "workflow-guard.mjs"], ["runtime", "host.mjs"], ["runtime", "bounded-child-process.mjs"]]) {
      copyFileSync(path.join(repoRoot, "lib", ...module), path.join(temporary, "lib", ...module));
    }
    writeFileSync(
      path.join(temporary, "config", "release-artifact-policy.json"),
      readFileSync(path.join(repoRoot, "config", "release-artifact-policy.json")),
    );
    const archiveName = "agentic-sdlc-1.2.3.tgz";
    const archivePath = path.join(releaseRoot, archiveName);
    const cyclonedxPath = `${archivePath}.cdx.json`;
    const sbomPath = `${archivePath}.spdx.json`;
    const verificationPath = path.join(releaseRoot, "release-verification.json");
    const outputPath = path.join(temporary, "github-output.txt");
    const sourceSha = "a".repeat(40);
    writeFileSync(archivePath, Buffer.from("immutable release archive fixture\n"));
    writeFileSync(sbomPath, `${JSON.stringify({
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      documentNamespace: "https://example.invalid/spdx/fixture",
      creationInfo: { creators: ["Tool: syft-fixture"] },
      packages: [{ name: "agentic-sdlc" }],
    })}\n`);
    writeFileSync(cyclonedxPath, `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "agentic-sdlc" }],
    })}\n`);
    const validVerification = {
      status: "passed",
      package: { name: "agentic-sdlc", version: "1.2.3", tag: "v1.2.3" },
      artifact: { sha256: sha256(archivePath) },
      smoke: {
        npm_install: "passed",
        cli_help: "passed",
        doctor: "passed",
        installer_plan: "passed",
        installer_zero_write: true,
        installer_v2_plan: "passed",
        installer_v2_zero_write: true,
      },
    };
    writeFileSync(verificationPath, `${JSON.stringify(validVerification)}\n`);

    const commonEnv = {
      ARCHIVE_NAME: archiveName,
      ARCHIVE_PATH: archivePath,
      CYCLONEDX_PATH: cyclonedxPath,
      EXPECTED_ARCHIVE_NAME: archiveName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_REPOSITORY: "aantenore/agentic-sdlc",
      GITHUB_RUN_ID: "123456789",
      GITHUB_SHA: sourceSha,
      POLICY_PATH: "config/release-artifact-policy.json",
      SBOM_PATH: sbomPath,
      VERIFICATION_PATH: verificationPath,
    };
    const sealManifest = () => runInlineModule(
      inlineNodeModule("Verify both SBOMs and seal the release manifest"),
      { cwd: temporary, env: commonEnv },
    );
    for (const [field, value] of [
      ["installer_v2_plan", "not_run"],
      ["installer_v2_zero_write", false],
    ]) {
      const weakened = JSON.parse(JSON.stringify(validVerification));
      weakened.smoke[field] = value;
      writeFileSync(verificationPath, `${JSON.stringify(weakened)}\n`);
      const rejectedSeal = sealManifest();
      assert.notEqual(rejectedSeal.status, 0, field);
      assert.match(rejectedSeal.stderr, /did not pass every smoke gate/u, field);
    }
    writeFileSync(verificationPath, `${JSON.stringify(validVerification)}\n`);
    const seal = sealManifest();
    assert.equal(seal.status, 0, seal.stderr);
    writeFileSync(
      `${archivePath}.sha256`,
      `${sha256(archivePath)}  ${archiveName}\n`,
    );

    const validate = () => runInlineModule(
      inlineNodeModule("Validate the artifact identity and sealed bundle"),
      { cwd: temporary, env: commonEnv },
    );
    const valid = validate();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(readFileSync(outputPath, "utf8"), new RegExp(`archive_name=${archiveName}\\n`, "u"));

    appendFileSync(archivePath, "tampered\n");
    const changedArchive = validate();
    assert.notEqual(changedArchive.status, 0);
    assert.match(changedArchive.stderr, /asset does not match its sealed record/u);
    writeFileSync(archivePath, Buffer.from("immutable release archive fixture\n"));

    const unexpectedPath = path.join(releaseRoot, "npm-pack.json");
    writeFileSync(unexpectedPath, "unexpected\n");
    const unexpectedEntry = validate();
    assert.notEqual(unexpectedEntry.status, 0);
    assert.match(unexpectedEntry.stderr, /unexpected entry/u);
    unlinkSync(unexpectedPath);

    const manifestPath = path.join(releaseRoot, "release-manifest.json");
    const originalCyclonedx = readFileSync(cyclonedxPath);
    writeFileSync(cyclonedxPath, `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "different-package" }],
    })}\n`);
    let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cyclonedx.bytes = readFileSync(cyclonedxPath).length;
    manifest.cyclonedx.sha256 = sha256(cyclonedxPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const falseCyclonedxIdentity = validate();
    assert.notEqual(falseCyclonedxIdentity.status, 0);
    assert.match(falseCyclonedxIdentity.stderr, /CycloneDX SBOM does not describe/u);
    writeFileSync(cyclonedxPath, originalCyclonedx);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cyclonedx.bytes = readFileSync(cyclonedxPath).length;
    manifest.cyclonedx.sha256 = sha256(cyclonedxPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const weakenedVerification = JSON.parse(readFileSync(verificationPath, "utf8"));
    weakenedVerification.smoke.installer_zero_write = false;
    writeFileSync(verificationPath, `${JSON.stringify(weakenedVerification)}\n`);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.verification.bytes = readFileSync(verificationPath).length;
    manifest.verification.sha256 = sha256(verificationPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const weakenedGate = validate();
    assert.notEqual(weakenedGate.status, 0);
    assert.match(weakenedGate.stderr, /verification does not prove every required smoke gate/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
