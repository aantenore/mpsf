import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_GATE_POLICY,
  CiGateError,
  checkCiGateOnce,
  createGithubJsonFetcher,
  evaluateCiGate,
  requiredCiJobNames,
  unmetCells,
  waitForCiGate,
} from "../../lib/release/ci-gate.mjs";
import {
  CHECKS_STEPS,
  CI_SHARD_TOTAL,
  SHARDED_PLATFORMS,
  SHARD_TEST_STEP,
  checksJobName,
  shardJobName,
} from "../../lib/release/ci-jobs.mjs";


const SHA = "a".repeat(40);
const REPOSITORY = "aantenore/agentic-sdlc";
// The aggregator mechanism the gate still supports for sharded cells, although
// the push run it reads today shards nothing.
const SHARDED_POLICY = Object.freeze({
  ...CI_GATE_POLICY,
  // Every sharded platform needs a Node 24 cell here, Windows included, although the push run has none.
  cells: Object.freeze([
    ...CI_GATE_POLICY.cells,
    ...SHARDED_PLATFORMS
      .filter((platform) => !CI_GATE_POLICY.cells.some((cell) => cell.platform === platform && cell.node === "24"))
      .map((platform) => Object.freeze({ platform, node: "24" })),
  ]),
  executedStep: (platform) => (
    SHARDED_PLATFORMS.includes(platform) ? "Confirm every shard ran the test suite" : "Run the test suite"
  ),
  shardedPlatforms: SHARDED_PLATFORMS,
});
const FAST = Object.freeze({
  ...CI_GATE_POLICY,
  pollIntervalMs: 10,
  pendingTimeoutMs: 100,
  missingRunTimeoutMs: 30,
});


function run(overrides = {}) {
  return {
    id: 1,
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}


function ranSteps(name, conclusion = "success", policy = CI_GATE_POLICY) {
  const platform = /^test \((.+?), /u.exec(name)[1];
  return [
    { name: "Set up job", conclusion: "success" },
    { name: policy.executedStep(platform), conclusion },
  ];
}


function successfulJob(name, id, steps, attempt = 1) {
  return {
    id,
    name,
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({ name: step, conclusion: "success" })),
  };
}


// The shard jobs and the checks job behind one aggregator cell of a sharded platform.
function memberJobs(platform, node, attempt = 1) {
  return [
    ...Array.from({ length: CI_SHARD_TOTAL }, (_, offset) => (
      successfulJob(shardJobName(platform, node, offset + 1, CI_SHARD_TOTAL), 1000 + offset, [SHARD_TEST_STEP], attempt)
    )),
    successfulJob(checksJobName(platform, node), 1100, CHECKS_STEPS, attempt),
  ];
}


// What a push run holds: every required cell, plus, under a policy with
// sharded platforms, their shard and checks jobs (what the aggregators aggregate).
function jobs(overrides = {}, attempt = 1, policy = CI_GATE_POLICY) {
  const cells = requiredCiJobNames(policy).map((name, index) => ({
    id: 100 + index,
    name,
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
    steps: ranSteps(name, "success", policy),
    ...(overrides[name] ?? {}),
  }));
  const members = policy.cells
    .filter(({ platform }) => policy.shardedPlatforms.includes(platform))
    .flatMap(({ platform, node }) => memberJobs(platform, node, attempt));
  return [...cells, ...members];
}


// Replaces one member job (a shard or the checks job) by name.
function withMember(name, change) {
  return shardedJobs().map((job) => (job.name === name ? { ...job, ...change } : job));
}


function shardedJobs(overrides = {}) {
  return jobs(overrides, 1, SHARDED_POLICY);
}


function evaluate(runs, jobsByRun = new Map([[1, jobs()]]), policy = CI_GATE_POLICY) {
  return evaluateCiGate({ runs, jobsByRunId: jobsByRun, sha: SHA, policy });
}


test("a green run whose suite was skipped (documentation-only change) cannot release", () => {
  for (const name of requiredCiJobNames()) {
    for (const steps of [
      ranSteps(name, "skipped"),
      ranSteps(name, "failure"),
      [{ name: "Set up job", conclusion: "success" }],
      [],
      undefined,
    ]) {
      const verdict = evaluate([run()], new Map([[1, jobs({ [name]: { steps } })]]));
      assert.equal(verdict.state, "failed", `${name} ${JSON.stringify(steps)}`);
      assert.match(verdict.reason, /test suite did not run/u);
    }
  }
  const allSkipped = jobs().map((job) => ({
    ...job,
    steps: requiredCiJobNames().includes(job.name)
      ? ranSteps(job.name, "skipped")
      : job.steps.map((step) => ({ ...step, conclusion: "skipped" })),
  }));
  assert.equal(evaluate([run()], new Map([[1, allSkipped]])).state, "failed");
  // The wrong marker (the full-suite aggregator one) does not count either.
  for (const name of requiredCiJobNames()) {
    const crossed = jobs({
      [name]: { steps: [{ name: "Confirm every shard ran the test suite", conclusion: "success" }] },
    });
    assert.equal(evaluate([run()], new Map([[1, crossed]])).state, "failed", name);
  }
});


test("the push run is judged on the fast job alone: one job per cell, no shard or checks jobs", () => {
  assert.deepEqual(CI_GATE_POLICY.shardedPlatforms, []);
  for (const { platform } of CI_GATE_POLICY.cells) {
    assert.equal(CI_GATE_POLICY.executedStep(platform), "Run the test suite", platform);
  }
  const all = jobs();
  assert.equal(all.length, 5);
  assert.deepEqual(unmetCells(all), []);
  assert.equal(evaluate([run()], new Map([[1, all]])).state, "passed");
});


test("cells that only the scheduled full matrix produces are not required", () => {
  const names = requiredCiJobNames();
  for (const extra of [
    "test (macos-latest, 18.20.3)",
    "test (windows-latest, 24)",
    "test (windows-latest, 18.20.3)",
    "test (windows-latest, 21.6.0)",
    "test (macos-latest, 20.12.0)",
  ]) {
    assert.equal(names.includes(extra), false, extra);
  }
  // The shard and checks jobs are not required cells; the per-OS, per-Node aggregator job is.
  assert.equal(names.some((name) => name.startsWith("test shard") || name.startsWith("checks")), false);
});


test("a policy with sharded platforms accepts aggregators plus their shards and checks jobs", () => {
  const all = shardedJobs();
  assert.equal(all.length, SHARDED_POLICY.cells.length + 2 * (CI_SHARD_TOTAL + 1));
  assert.deepEqual(unmetCells(all, SHARDED_POLICY), []);
  assert.equal(evaluate([run()], new Map([[1, all]]), SHARDED_POLICY).state, "passed");
  // Cells of the same platform on another Node line do not interfere.
  const extra = [...all, ...memberJobs("windows-latest", "18.20.3").map((job) => ({ ...job, conclusion: "failure" }))];
  assert.deepEqual(unmetCells(extra, SHARDED_POLICY), []);
});


// Merged from "a green aggregator cannot hide a missing, failed, or skipped shard" and
// "a green aggregator cannot hide a missing, failed, or skipped checks job". The full
// conclusion matrix is tested directly on unmetShardedJobs in release-ci-shards.test.mjs;
// this covers only the gate's wrapper contract: requireExecuted is applied, members are
// labelled "(part of <aggregator>)", and the verdict names the failing job.
test("a green aggregator cannot hide a failed or skipped shard or checks job", () => {
  for (const platform of SHARDED_PLATFORMS) {
    const aggregator = `test (${platform}, 24)`;
    const shard = shardJobName(platform, "24", CI_SHARD_TOTAL, CI_SHARD_TOTAL);
    assert.deepEqual(unmetCells(withMember(shard, { conclusion: "failure" }), SHARDED_POLICY), [`${shard} (part of ${aggregator})`], `${shard} failure`);
    // A shard that skipped its test step (a documentation-only change) does not count either.
    const skipped = withMember(shard, { steps: [{ name: SHARD_TEST_STEP, conclusion: "skipped" }] });
    assert.deepEqual(unmetCells(skipped, SHARDED_POLICY), [`${shard} (part of ${aggregator})`], `${shard} skipped step`);

    const checks = checksJobName(platform, "24");
    assert.deepEqual(unmetCells(withMember(checks, { conclusion: "failure" }), SHARDED_POLICY), [`${checks} (part of ${aggregator})`], `${checks} failure`);
    const skippedStep = CHECKS_STEPS[0];
    const steps = CHECKS_STEPS.map((step) => ({ name: step, conclusion: step === skippedStep ? "skipped" : "success" }));
    const verdict = evaluate([run()], new Map([[1, withMember(checks, { steps })]]), SHARDED_POLICY);
    assert.equal(verdict.state, "failed", `${checks} ${skippedStep}`);
    assert.ok(verdict.reason.includes(checks), `${checks} ${skippedStep}`);
  }
});


test("a failed or missing aggregator fails even when every shard and checks job passed", () => {
  for (const platform of SHARDED_PLATFORMS) {
    const aggregator = `test (${platform}, 24)`;
    for (const conclusion of ["failure", "cancelled", "skipped", null]) {
      assert.equal(evaluate([run()], new Map([[1, shardedJobs({ [aggregator]: { conclusion } })]]), SHARDED_POLICY).state, "failed", `${aggregator} ${conclusion}`);
    }
    // Shards and checks alone never stand in for the aggregator that vouches for them.
    const without = shardedJobs().filter((job) => job.name !== aggregator);
    assert.equal(unmetCells(without, SHARDED_POLICY)[0], aggregator);
    assert.equal(evaluate([run()], new Map([[1, without]]), SHARDED_POLICY).state, "failed");
  }
});


test("only the latest attempt of a shard or checks job decides", () => {
  const shard = shardJobName("windows-latest", "24", 2, CI_SHARD_TOTAL);
  const checks = checksJobName("macos-latest", "24");
  const recovered = [
    ...withMember(shard, { conclusion: "failure" }),
    successfulJob(shard, 8000, [SHARD_TEST_STEP], 2),
  ];
  assert.deepEqual(unmetCells(recovered, SHARDED_POLICY), []);
  const regressed = [
    ...shardedJobs(),
    { ...successfulJob(checks, 8001, CHECKS_STEPS, 2), conclusion: "failure" },
  ];
  assert.deepEqual(unmetCells(regressed, SHARDED_POLICY), [`${checks} (part of test (macos-latest, 24))`]);
});


test("a successful push run with every cell passes", () => {
  assert.deepEqual(
    { state: evaluate([run()]).state, runId: evaluate([run()]).runId },
    { state: "passed", runId: 1 },
  );
});


test("no run for the commit is missing, not passed", () => {
  assert.equal(evaluate([]).state, "missing");
  for (const stray of [
    run({ head_sha: "b".repeat(40) }),
    run({ event: "pull_request" }),
    run({ event: "workflow_dispatch" }),
    run({ event: "schedule" }),
    run({ head_branch: "feature" }),
  ]) {
    assert.equal(evaluate([stray]).state, "missing", JSON.stringify(stray));
  }
});


test("failed, cancelled, and skipped conclusions fail closed", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral", null]) {
    const verdict = evaluate([run({ conclusion })]);
    assert.equal(verdict.state, "failed", String(conclusion));
  }
});


test("an unfinished run is pending", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested"]) {
    assert.equal(evaluate([run({ status, conclusion: null })]).state, "pending", status);
  }
});


test("a successful run missing a cell or holding a non-success cell fails", () => {
  const withoutCell = jobs().filter((job) => job.name !== "test (macos-latest, 24)");
  const missing = evaluate([run()], new Map([[1, withoutCell]]));
  assert.equal(missing.state, "failed");
  assert.match(missing.reason, /macos-latest, 24/u);

  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    const verdict = evaluate([run()], new Map([[1, jobs({
      "test (ubuntu-latest, 20.12.0)": { conclusion },
    })]]));
    assert.equal(verdict.state, "failed", String(conclusion));
  }
  const unfinished = evaluate([run()], new Map([[1, jobs({
    "test (macos-latest, 24)": { status: "in_progress", conclusion: null },
  })]]));
  assert.equal(unfinished.state, "failed");

  const reducedPullRequestMatrix = jobs().filter((job) => /, 24\)$|ubuntu-latest, 18\.20\.3/u.test(job.name));
  assert.ok(
    reducedPullRequestMatrix.filter((job) => requiredCiJobNames().includes(job.name)).length < requiredCiJobNames().length,
  );
  assert.equal(
    evaluate([run()], new Map([[1, reducedPullRequestMatrix]])).state,
    "failed",
    "a run with only the pull-request cells is not enough to release",
  );
});


test("only the latest attempt of a cell decides", () => {
  const name = "test (ubuntu-latest, 21.6.0)";
  const recovered = [
    ...jobs({ [name]: { conclusion: "failure" } }, 1),
    { ...jobs()[0], name, id: 999, run_attempt: 2 },
  ];
  assert.equal(evaluate([run()], new Map([[1, recovered]])).state, "passed");
  const regressed = [
    ...jobs({}, 1),
    { ...jobs()[0], name, id: 999, run_attempt: 2, conclusion: "failure" },
  ];
  assert.equal(evaluate([run()], new Map([[1, regressed]])).state, "failed");
});


test("one fully green run is enough even if another run for the commit failed", () => {
  const verdict = evaluate(
    [run({ id: 2, conclusion: "failure" }), run({ id: 1 })],
    new Map([[1, jobs()]]),
  );
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.runId, 1);
});


test("a malformed commit SHA is rejected", () => {
  assert.throws(
    () => evaluateCiGate({ runs: [], jobsByRunId: new Map(), sha: "v1.2.3" }),
    (error) => error instanceof CiGateError && error.code === "INVALID_SHA",
  );
});


function fakeApi({ runs, jobsByRun = {}, failures = [] }) {
  const calls = [];
  const queue = [...failures];
  const fetchJson = async (route) => {
    calls.push(route);
    if (queue.length > 0) {
      const next = queue.shift();
      if (next) throw new CiGateError("API_ERROR", "boom");
    }
    const query = new URL(route, "https://api.invalid").searchParams;
    if (route.includes("/actions/workflows/ci.yml/runs")) {
      return { workflow_runs: query.get("page") === "1" ? runs() : [] };
    }
    const runId = /\/actions\/runs\/(\d+)\/jobs/u.exec(route)?.[1];
    return { jobs: query.get("page") === "1" ? (jobsByRun[runId] ?? []) : [] };
  };
  return { calls, fetchJson };
}


test("the exact-SHA query filters by commit and push event and reads all attempts", async () => {
  const api = fakeApi({ runs: () => [run()], jobsByRun: { 1: jobs() } });
  const verdict = await checkCiGateOnce({ fetchJson: api.fetchJson, repository: REPOSITORY, sha: SHA });
  assert.equal(verdict.state, "passed");
  assert.match(api.calls[0], new RegExp(`^/repos/${REPOSITORY}/actions/workflows/ci\\.yml/runs\\?head_sha=${SHA}&event=push&per_page=100&page=1$`, "u"));
  assert.match(api.calls[1], /\/actions\/runs\/1\/jobs\?filter=all&per_page=100&page=1$/u);
});


test("listings of exactly one full page are followed to the next page", async () => {
  const pages = new Map();
  const filler = Array.from({ length: 100 }, (_, index) => run({ id: 1000 + index, head_sha: "c".repeat(40) }));
  const fetchJson = async (route) => {
    const page = Number(new URL(route, "https://api.invalid").searchParams.get("page"));
    pages.set(route, page);
    if (route.includes("/workflows/")) {
      return { workflow_runs: page === 1 ? filler : [run()] };
    }
    return { jobs: page === 1 ? jobs() : [] };
  };
  const verdict = await checkCiGateOnce({ fetchJson, repository: REPOSITORY, sha: SHA });
  assert.equal(verdict.state, "passed");
});


test("waiting resolves once an in-progress run completes", async () => {
  let reads = 0;
  const api = fakeApi({
    runs: () => {
      reads += 1;
      return [reads < 3 ? run({ status: "in_progress", conclusion: null }) : run()];
    },
    jobsByRun: { 1: jobs() },
  });
  let clock = 0;
  const verdict = await waitForCiGate({
    fetchJson: api.fetchJson,
    repository: REPOSITORY,
    sha: SHA,
    policy: FAST,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(verdict.state, "passed");
  assert.equal(reads, 3);
});


test("a run that never finishes times out instead of passing", async () => {
  const api = fakeApi({ runs: () => [run({ status: "in_progress", conclusion: null })] });
  let clock = 0;
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    (error) => error.code === "CI_TIMEOUT",
  );
});


test("a commit that has no CI run fails after the short grace period", async () => {
  const api = fakeApi({ runs: () => [] });
  let clock = 0;
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    (error) => error.code === "CI_RUN_MISSING" && clock <= FAST.missingRunTimeoutMs + FAST.pollIntervalMs,
  );
});


test("a failed run fails immediately without polling", async () => {
  const api = fakeApi({ runs: () => [run({ conclusion: "failure" })] });
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      sleep: async () => { throw new Error("must not wait"); },
    }),
    (error) => error.code === "CI_NOT_PASSED",
  );
});


test("API errors fail closed once they persist and a single blip is tolerated", async () => {
  const tolerated = fakeApi({ runs: () => [run()], jobsByRun: { 1: jobs() }, failures: [true] });
  const verdict = await waitForCiGate({
    fetchJson: tolerated.fetchJson,
    repository: REPOSITORY,
    sha: SHA,
    policy: FAST,
    sleep: async () => {},
  });
  assert.equal(verdict.state, "passed");

  const broken = fakeApi({ runs: () => [run()], failures: [true, true, true, true] });
  await assert.rejects(
    waitForCiGate({
      fetchJson: broken.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      sleep: async () => {},
    }),
    (error) => error.code === "API_ERROR",
  );
});


test("malformed API payloads and invalid inputs fail closed", async () => {
  await assert.rejects(
    checkCiGateOnce({ fetchJson: async () => ({}), repository: REPOSITORY, sha: SHA }),
    (error) => error.code === "API_SHAPE",
  );
  await assert.rejects(
    checkCiGateOnce({ fetchJson: async () => ({ workflow_runs: [] }), repository: "not a repo", sha: SHA }),
    (error) => error.code === "INVALID_REPOSITORY",
  );
});


test("the GitHub fetcher authenticates and maps transport and HTTP failures to API errors", async () => {
  assert.throws(() => createGithubJsonFetcher({ token: "" }), (error) => error.code === "TOKEN_REQUIRED");
  let seen;
  const ok = createGithubJsonFetcher({
    token: "secret",
    apiUrl: "https://api.example.test",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ ok: 1 }) };
    },
  });
  assert.deepEqual(await ok("/repos/x/y?z=1"), { ok: 1 });
  assert.equal(seen.url, "https://api.example.test/repos/x/y?z=1");
  assert.equal(seen.init.headers.Authorization, "Bearer secret");

  for (const fetchImpl of [
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
    async () => { throw new TypeError("fetch failed"); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError("bad"); } }),
  ]) {
    const failing = createGithubJsonFetcher({ token: "secret", fetchImpl });
    await assert.rejects(failing("/repos/x/y"), (error) => error.code === "API_ERROR" && !error.message.includes("secret"));
  }
});
