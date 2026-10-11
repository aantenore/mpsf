import assert from "node:assert/strict";
import test from "node:test";

import { buildDigest, digestDue } from "../../lib/coordinator/digest.mjs";
import { mainGreenStoryId, planMainGreen } from "../../lib/coordinator/main-green.mjs";
import { planMergeQueue, runMergeQueue, storyOfBranch } from "../../lib/coordinator/merge-queue.mjs";
import { checkStoryRecords } from "../../lib/coordinator/records-check.mjs";
import { checksState, normalizePullRequest } from "../../lib/coordinator/forges/github.mjs";
import { detectForge, resolveForge } from "../../lib/coordinator/forges/index.mjs";
import { coordinatorGate } from "../../lib/coordinator/project.mjs";
import { coordinatorDigestCommand, coordinatorMergeCommand } from "../../lib/coordinator/cli.mjs";
import { welcomeJoins } from "../../lib/messaging/join.mjs";
import { buildNowModel } from "../../lib/change-observatory/now-panel.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const notHolder = () => ({ holds: false, mode: "auto", holder: "pc-b" });

test("digest lists alive computers, stories and open P1, and goes out only on change and after the gap", () => {
  const digest = buildDigest({
    live: ["pc-b", "pc-a"],
    recap: { in_progress: ["ST-1 (pc-a)"], waiting: [], parked: ["ST-2"] },
    stories: [{ id: "ST-9", priority: "P1", status: "ready" }, { id: "ST-8", priority: "P1", status: "done" }, { id: "ST-7", priority: "P2" }],
  });
  assert.equal(digest.text, "digest: 2 computers alive (pc-a, pc-b); in progress ST-1 (pc-a); waiting none; parked ST-2; open P1 ST-9");
  assert.equal(digestDue(digest, {}).due, true);
  assert.equal(digestDue(digest, { digest_hash: digest.hash }).reason, "unchanged");
  assert.equal(digestDue(digest, { digest_hash: "x", digest_at: NOW - 60_000 }, { now: NOW }).reason, "too_soon");
  assert.equal(digestDue(digest, { digest_hash: digest.hash }, { force: true }).due, true);
});

test("main-green opens one P1 forward fix story when red, and nothing while one is open or the base is green", () => {
  const status = { state: "red", branch: "main", sha: "abcdef0123456789", failing: [{ name: "unit" }] };
  const plan = planMainGreen({ status, stories: [] });
  assert.equal(plan.action, "create");
  assert.equal(plan.story.id, mainGreenStoryId("abcdef0123456789"));
  assert.equal(plan.story.id, "ST-MAIN-GREEN-ABCDEF01");
  assert.equal(plan.story.priority, "P1");
  assert.match(plan.story.acceptance.join(" "), /nothing is reverted/u);
  assert.equal(planMainGreen({ status, stories: [{ id: "ST-MAIN-GREEN-11111111", status: "ready" }] }).action, "exists");
  assert.equal(planMainGreen({ status, stories: [{ id: "ST-MAIN-GREEN-11111111", status: "done" }] }).action, "create");
  assert.equal(planMainGreen({ status: { ...status, state: "green" } }).action, "none");
  assert.equal(planMainGreen({ status: { ...status, state: "pending" } }).action, "none");
});

test("check-records finds orphan, broken and inconsistent story records", () => {
  const files = new Map([
    [".sdlc/stories/ST-1/story.json", JSON.stringify({ id: "ST-1", status: "done", priority: "P9", fixes: { story_id: "ST-404" } })],
    [".sdlc/stories/ST-2/story.json", "{ broken"],
    [".sdlc/stories/ST-3/story.json", JSON.stringify({ id: "ST-X" })],
    [".sdlc/stories/ST-3/steps/design.json", "{}"],
    [".sdlc/stories/ST-5/story.json", JSON.stringify({ id: "ST-5" })],
    [".sdlc/stories/ST-5/claim.json", "{}"],
    [".sdlc/stories/ST-5/steps/design.json", "{}"],
  ]);
  const paths = [...files.keys(), ".sdlc/stories/ST-4/plan.md", ".sdlc/stories/ST-5/plan.md"];
  const result = checkStoryRecords({ paths, files });
  const codes = result.issues.map((item) => `${item.story}:${item.code}`).sort();
  assert.deepEqual(codes, [
    "ST-1:done_without_steps",
    "ST-1:invalid_priority",
    "ST-1:unknown_fixed_story",
    "ST-2:invalid_json",
    "ST-3:id_mismatch",
    "ST-3:steps_without_claim",
    "ST-4:missing_story",
  ]);
  assert.equal(result.errors, 4);
  assert.equal(result.stories, 5);
});

test("merge queue orders by story priority, merges serially and updates a behind branch when none is ready", () => {
  const pr = (number, extra) => normalizePullRequest({ number, headRefName: `feature/${extra.story ?? "x"}`, headRefOid: `sha${number}`, mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], createdAt: `2026-10-0${number}T00:00:00Z`, ...extra.raw });
  const stories = [{ id: "ST-LOW", priority: "P3" }, { id: "ST-HOT", priority: "P1" }];
  assert.equal(storyOfBranch("feature/st-hot-fix", ["ST-HOT", "ST-HOT-FIX"]), "ST-HOT-FIX");
  let open = [
    pr(1, { story: "ST-LOW" }),
    pr(2, { story: "ST-HOT" }),
    pr(3, { story: "none", raw: { isDraft: true } }),
    pr(4, { story: "none", raw: { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] } }),
    pr(5, { story: "none", raw: { reviewDecision: "CHANGES_REQUESTED" } }),
  ];
  const plan = planMergeQueue(open, stories);
  assert.deepEqual(plan.queue.map((item) => [item.pr.number, item.state]), [[2, "ready"], [1, "ready"], [3, "draft"], [4, "checks_red"], [5, "changes_requested"]]);
  const calls = [];
  const forge = {
    listPullRequests: () => open,
    mergePullRequest: ({ number, headSha }) => {
      calls.push(`merge ${number} ${headSha}`);
      open = open.filter((item) => item.number !== number).map((item) => (item.number === 1 ? { ...item, mergeable: "behind" } : item));
    },
    updateBranch: ({ number }) => calls.push(`update ${number}`),
  };
  assert.deepEqual(runMergeQueue({ forge, base: "main", stories, dryRun: true }).merged, []);
  assert.deepEqual(calls, []);
  const run = runMergeQueue({ forge, base: "main", stories, max: 3 });
  assert.deepEqual(run.merged.map((item) => item.number), [2]);
  assert.deepEqual(calls, ["merge 2 sha2"]);
  const next = runMergeQueue({ forge, base: "main", stories });
  assert.deepEqual(next.updated, { number: 1, url: null });
  assert.deepEqual(calls, ["merge 2 sha2", "update 1"]);
});

test("github checks and forge resolution", () => {
  assert.equal(checksState([]), "none");
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "green");
  assert.equal(checksState([{ status: "IN_PROGRESS", conclusion: null }]), "pending");
  assert.equal(checksState([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "QUEUED" }]), "red");
  assert.equal(detectForge("git@github.com:a/b.git"), "github");
  assert.equal(detectForge("https://github.com/a/b"), "github");
  assert.equal(detectForge("https://example.com/a/b"), null);
  assert.equal(resolveForge("/x", { env: {}, url: "https://example.com/a/b" }).forge, null);
  assert.equal(resolveForge("/x", { env: { AGENTIC_SDLC_FORGE: "github" }, url: null }).forge.id, "github");
});

test("every task does nothing where the coordinator role is held elsewhere; welcome too", async () => {
  assert.equal(coordinatorGate("/x", { holds: () => { throw new Error("boom"); } }).holds, true, "a failing read never blocks");
  const context = { root: "/nonexistent", sdlcRoot: "/nonexistent/.sdlc" };
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    let sent = 0;
    const digest = await coordinatorDigestCommand(context, { json: true }, { holds: notHolder, send: () => { sent += 1; } });
    assert.equal(digest.status, "skipped");
    assert.equal(digest.holder, "pc-b");
    assert.equal(sent, 0);
    const merged = await coordinatorMergeCommand(context, { json: true }, { holds: notHolder, forge: { listPullRequests: () => assert.fail("must not list") } });
    assert.equal(merged.status, "skipped");
  } finally {
    console.log = original;
  }
  const provider = { publish: () => assert.fail("must not welcome") };
  const welcomed = await welcomeJoins("/nonexistent", { settings: { statePath: "/nonexistent/state.json" }, messages: [{ kind: "join", id: "1", from: "pc-c", time: new Date(NOW).toISOString() }], provider, env: {}, now: NOW, holds: notHolder });
  assert.deepEqual(welcomed, []);
});

test("Observatory shows the latest digest apart and never as its sender's status", () => {
  const messages = [
    { id: "1", from: "pc-a", kind: "info", text: "[auto] ST-1 in fase design", time: "2026-10-11T11:00:00Z" },
    { id: "2", from: "pc-a", kind: "info", text: "[auto] digest: 2 computers alive", time: "2026-10-11T11:30:00Z" },
  ];
  const model = buildNowModel({ messages, messaging: "on", nowMs: NOW });
  assert.equal(model.digest.text, "2 computers alive");
  assert.equal(model.senders[0].status.text, "[auto] ST-1 in fase design");
  assert.equal(buildNowModel({ messages: null, nowMs: NOW }).digest, null);
});
