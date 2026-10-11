import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSharedRefSource } from "../../lib/change-observatory/shared-ref-source.mjs";
import { pullStateRecords, pushStateRecords, stateMigrateCommand } from "../../lib/engine/state-branch.mjs";
import { isStateRecordPath, stateShardKey, withStateGitignore } from "../../lib/state-branch.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

const read = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "state-branch-"));
  const shared = path.join(base, "shared.git");
  const one = path.join(base, "one");
  const two = path.join(base, "two");
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", shared);
  git(base, "clone", "--quiet", shared, one);
  write(one, ".sdlc/config.json", "{}\n");
  write(one, ".sdlc/stories/ST-1/story.json", "{\"id\":\"ST-1\"}\n");
  write(one, ".sdlc/gates/ST-1-final.json", "{\"final\":true}\n");
  write(one, ".sdlc/gates/ST-1-strict.json", "{\"v\":1}\n");
  write(one, ".sdlc/autonomy/actions/AUT-ACT-1.json", "{\"delivery\":{\"id\":\"PR-1\"}}\n");
  git(one, "add", ".");
  git(one, "commit", "--quiet", "-m", "first");
  git(one, "push", "--quiet", "origin", "HEAD:main");
  return { base, one, two, shared };
}

test("state paths, shard keys and ignore lines", () => {
  assert.equal(isStateRecordPath(".sdlc/autonomy/actions/AUT-ACT-1.json"), true);
  assert.equal(isStateRecordPath(".sdlc/autonomy/executions/AUT-PR-X/start.json"), true);
  assert.equal(isStateRecordPath(".sdlc/gates/ST-1-strict.json"), true);
  assert.equal(isStateRecordPath(".sdlc/gates/ST-1-final.json"), false);
  assert.equal(isStateRecordPath(".sdlc/traces/project.jsonl"), false);
  assert.equal(isStateRecordPath(".sdlc/stories/ST-1/story.json"), false);
  assert.equal(stateShardKey(".sdlc/autonomy/executions/AUT-PR-X/start.json"), "ST-X");
  assert.equal(stateShardKey(".sdlc/gates/ST-1-strict.json"), "ST-1");
  assert.equal(stateShardKey(".sdlc/autonomy/actions/A.json", { delivery: { id: "PR-UX-2" } }), "ST-UX-2");
  const ignore = withStateGitignore("cache/**/*\n");
  assert.match(ignore, /!gates\/\*-final\.json/u);
  assert.equal(withStateGitignore(ignore), null);
});

test("migrate, push from one clone, pull in another, observatory overlay", async (t) => {
  const { base, one, two } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const quiet = { json: true };
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await stateMigrateCommand({ root: one }, quiet);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(read(one, ".sdlc/config.json"), "{}\n");
  assert.ok(fs.existsSync(path.join(one, ".sdlc/compatibility/sdlc-state-records.json")));
  // Untracked but still here; the final gate stays tracked.
  assert.equal(git(one, "ls-files", ".sdlc/autonomy", ".sdlc/gates"), ".sdlc/gates/ST-1-final.json");
  assert.ok(fs.existsSync(path.join(one, ".sdlc/autonomy/actions/AUT-ACT-1.json")));
  git(one, "add", "-A");
  git(one, "commit", "--quiet", "-m", "move records [skip ci]");
  git(one, "push", "--quiet", "origin", "HEAD:main");
  const stateLog = git(one, "log", "-1", "--format=%s", "origin/sdlc-state");
  assert.match(stateLog, /\[skip ci\]$/u);

  // A new record is pushed; nothing changed is not.
  write(one, ".sdlc/autonomy/actions/AUT-ACT-2.json", "{\"n\":2}\n");
  assert.equal(pushStateRecords({ root: one }, { force: true }).pushed, 1);
  assert.equal(pushStateRecords({ root: one }, { force: true }).status, "up_to_date");
  assert.equal(pushStateRecords({ root: one }).status, "not_due");

  git(base, "clone", "--quiet", path.join(base, "shared.git"), two);
  assert.ok(!fs.existsSync(path.join(two, ".sdlc/autonomy/actions/AUT-ACT-1.json")));
  const pulled = pullStateRecords({ root: two }, { force: true });
  assert.equal(pulled.pulled, 3);
  assert.equal(read(two, ".sdlc/autonomy/actions/AUT-ACT-2.json"), "{\"n\":2}\n");
  assert.equal(git(two, "status", "--porcelain"), "");

  // Concurrent writers: the second push lands on the moved tip (fast-forward, no lost record).
  write(two, ".sdlc/gates/ST-1-strict.json", "{\"v\":2}\n");
  write(one, ".sdlc/autonomy/actions/AUT-ACT-3.json", "{\"n\":3}\n");
  assert.equal(pushStateRecords({ root: two }, { force: true }).status, "pushed");
  assert.equal(pushStateRecords({ root: one }, { force: true }).status, "pushed");
  pullStateRecords({ root: one }, { force: true });
  assert.equal(read(one, ".sdlc/gates/ST-1-strict.json"), "{\"v\":2}\n");
  // A record changed here and not pushed is never overwritten by a pull.
  write(two, ".sdlc/autonomy/actions/AUT-ACT-3.json", "{\"local\":true}\n");
  pullStateRecords({ root: two }, { force: true });
  assert.equal(read(two, ".sdlc/autonomy/actions/AUT-ACT-3.json"), "{\"local\":true}\n");

  const snapshotRoot = path.join(base, "snapshot");
  // The second clone was made after main existed, so it knows origin/HEAD.
  const source = createSharedRefSource(two, { snapshotRoot, fetchSeconds: 0 });
  assert.ok(fs.existsSync(path.join(snapshotRoot, ".sdlc/stories/ST-1/story.json")));
  assert.ok(fs.existsSync(path.join(snapshotRoot, ".sdlc/autonomy/actions/AUT-ACT-3.json")));
  assert.equal(read(snapshotRoot, ".sdlc/gates/ST-1-strict.json"), "{\"v\":2}\n");
  assert.equal(source.info().stateRef, "refs/remotes/origin/sdlc-state");
});
