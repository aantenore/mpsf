import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pathsTouchedByCommits, storyOwnCommitRange } from "../../lib/engine/story-branch-commits.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

function commitFile(root, name, content, message) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-base-"));
  const root = path.join(dir, "work");
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", dir);
  const start = commitFile(root, "a.txt", "a", "start");
  git(root, "update-ref", "refs/remotes/origin/main", start);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "feature/story");
  return { dir, root, start, context: { root, sdlcRoot: path.join(root, ".sdlc"), config: {} } };
}

test("commits reachable from the remote base branch are not the story's own", () => {
  const { dir, root, start, context } = setup();
  try {
    const fromBase = commitFile(root, "packages/agents/x.txt", "x", "direct to main");
    git(root, "update-ref", "refs/remotes/origin/main", fromBase);
    const own = commitFile(root, "story.txt", "s", "story work");
    const range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: own });
    assert.deepEqual(range.commits, [own]);
    assert.ok(range.set_aside.some((item) => item.sha === fromBase && item.kind === "base"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit not on the remote base branch stays the story's", () => {
  const { dir, root, start, context } = setup();
  try {
    const foreign = commitFile(root, "packages/agents/x.txt", "x", "not on base");
    const own = commitFile(root, "story.txt", "s", "story work");
    const range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: own });
    assert.deepEqual(range.commits, [foreign, own]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a long story range costs a fixed number of Git processes", () => {
  const { dir, root, start, context } = setup();
  const trace = path.join(dir, "git-trace.log");
  try {
    const records = commitFile(root, ".sdlc/stories/x.json", "{}", "records only");
    const own = [];
    for (let index = 0; index < 12; index += 1) own.push(commitFile(root, `src/f${index}.txt`, String(index), `work ${index}`));
    git(root, "checkout", "-q", "-b", "side", start);
    const side = commitFile(root, "side.txt", "s", "side work");
    git(root, "checkout", "-q", "feature/story");
    git(root, "merge", "-q", "--no-edit", side);
    const merge = git(root, "rev-parse", "HEAD");
    process.env.GIT_TRACE = trace;
    let range;
    try {
      range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: merge });
    } finally {
      delete process.env.GIT_TRACE;
    }
    assert.deepEqual(range.commits, [...own, side, merge]);
    assert.ok(range.set_aside.some((item) => item.sha === records && item.kind === "records"));
    const spawned = fs.readFileSync(trace, "utf8").split("\n").filter((line) => /trace: (?:built-in|exec): git /u.test(line)).length;
    // Before batching: one ancestry check, one diff-tree and one rev-parse per commit (over 60 here).
    assert.ok(spawned <= 10, `expected a fixed number of Git processes, got ${spawned}`);
    assert.deepEqual(pathsTouchedByCommits(context, [...own, side, merge]), [...own.map((_, index) => `src/f${index}.txt`), "side.txt"].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit and its exact revert are set aside with batched diffs", () => {
  const { dir, root, start, context } = setup();
  try {
    const original = commitFile(root, "src/a.txt", "one\n", "add");
    git(root, "revert", "--no-edit", original);
    const revert = git(root, "rev-parse", "HEAD");
    const own = commitFile(root, "src/b.txt", "two\n", "keep");
    const range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: own });
    assert.deepEqual(range.commits, [own]);
    assert.deepEqual(range.set_aside.filter((item) => item.kind === "reverted").map((item) => item.sha).sort(), [original, revert].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
