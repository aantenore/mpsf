import { createBareOrigin, createFixtureDir } from "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { baseFreshness, createBaseReader, ensureBaseWorktree, fetchFreshState, freshnessLine, freshState } from "../../lib/engine/fresh-state.mjs";
import { renderPackText } from "../../lib/context/pack.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const CONFIG = { orchestration_policy: { coordination: { mode: "auto", remote: "origin", timeout_seconds: 5 } } };

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, file, value, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), `${JSON.stringify(value)}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

test("the reader sees the base as the remote has it, not the stale working tree", () => {
  const seed = createFixtureDir("fresh-seed-");
  git(seed, "init", "-q", "--initial-branch=main");
  commit(seed, ".sdlc/config.json", CONFIG, "config");
  commit(seed, ".sdlc/stories/ST-1/claim.json", { holder: "pc-old" }, "claim");
  const bare = createBareOrigin(seed);
  git(seed, "push", "-q", "origin", "main");

  const stale = createFixtureDir("fresh-stale-");
  git(stale, "clone", "-q", bare, ".");
  const context = { root: stale, sdlcRoot: path.join(stale, ".sdlc"), config: CONFIG };

  // The team moves on: the claim is released and two more commits land.
  fs.rmSync(path.join(seed, ".sdlc/stories/ST-1/claim.json"));
  commit(seed, ".sdlc/stories/ST-1/story.json", { id: "ST-1", status: "done" }, "done");
  commit(seed, ".sdlc/stories/ST-2/story.json", { id: "ST-2" }, "next");
  commit(seed, "README.md", "x", "readme");
  git(seed, "push", "-q", "origin", "main");

  assert.equal(baseFreshness(context).behind, 0, "before the fetch the local copy looks current");
  const first = fetchFreshState(context, { now: NOW });
  assert.equal(first.fetched, true, first.error ?? "");
  assert.equal(fetchFreshState(context, { now: NOW + 1000 }).skipped, "recent", "throttled");
  assert.equal(fetchFreshState(context, { now: NOW + 1000, env: { AGENTIC_SDLC_FRESH_FETCH: "off" } }).skipped, "disabled");

  const fresh = baseFreshness(context);
  assert.equal(fresh.behind, 3);
  assert.equal(fresh.ahead, 0);
  assert.equal(freshnessLine(fresh).startsWith("3 commits behind origin/main"), true);
  assert.equal(freshnessLine({ ...fresh, behind: 0 }), "up to date with origin/main");
  assert.equal(freshnessLine({ behind: null }), null);

  const reader = createBaseReader(stale, fresh.ref);
  assert.equal(fs.existsSync(path.join(stale, ".sdlc/stories/ST-1/claim.json")), true, "the working tree still has the old claim");
  assert.equal(reader.readJson(".sdlc/stories/ST-1/claim.json"), null, "the base no longer has it");
  assert.deepEqual(reader.list(".sdlc/stories"), ["ST-1", "ST-2"]);
  assert.equal(reader.readJson(".sdlc/stories/ST-1/story.json").status, "done");
  assert.equal(typeof reader.hash(".sdlc/stories/ST-2/story.json"), "string");

  const worktree = ensureBaseWorktree(context);
  assert.equal(worktree.created, true, worktree.error ?? "");
  assert.equal(worktree.path.includes(`${path.sep}agentic-sdlc${path.sep}base-worktree`), true);
  assert.equal(fs.existsSync(path.join(worktree.path, ".sdlc/stories/ST-2/story.json")), true);
  assert.equal(ensureBaseWorktree(context).updated, false, "already on the base tip");
  fs.writeFileSync(path.join(worktree.path, "pending.txt"), "x");
  assert.equal(ensureBaseWorktree(context).dirty, true, "a write in progress is never discarded");

  const text = renderPackText({ story_id: "ST-1", phase: "design", budget_tokens: 100, pack_hash: "abc", sections: [] }, { baseLine: freshnessLine(fresh) });
  assert.match(text.split("\n")[1], /^base: 3 commits behind origin\/main/u);
});

test("without a remote nothing is fetched and the line is omitted", () => {
  const dir = createFixtureDir("fresh-local-");
  git(dir, "init", "-q", "--initial-branch=main");
  commit(dir, "a.txt", 1, "a");
  const context = { root: dir, sdlcRoot: path.join(dir, ".sdlc"), config: {} };
  const state = freshState(context, { now: NOW });
  assert.equal(state.fetch.fetched, false);
  assert.equal(state.behind, null);
  assert.equal(freshnessLine(state), null);
});
