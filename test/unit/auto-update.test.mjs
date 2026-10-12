import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cacheLayout,
  marketplaceOf,
  maybeAutoUpdate,
  newerSibling,
  SYNC_MARKER,
  syncInPlace,
  syncRememberedRoots,
} from "../../lib/runtime/auto-update.mjs";
import { forwardToNewerVersion } from "../../lib/runtime/self-forward.mjs";

function cache(versions) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-"));
  const versionsDir = path.join(base, ".claude", "plugins", "cache", "mkt", "agentic-sdlc");
  for (const [version, files] of Object.entries(versions)) {
    const dir = path.join(versionsDir, version);
    fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agentic-sdlc", version }));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
  }
  return { base, dir: (version) => path.join(versionsDir, version) };
}

test("the marketplace comes from the install path and the newest complete sibling is chosen", () => {
  const c = cache({ "0.9.0": {}, "0.10.0": {}, "0.11.0": {} });
  try {
    assert.equal(marketplaceOf(c.dir("0.9.0")), "mkt");
    assert.equal(cacheLayout(c.dir("0.9.0")).version, "0.9.0");
    assert.equal(cacheLayout(path.join(c.base, "elsewhere")), null);
    assert.equal(newerSibling(c.dir("0.9.0")).version, "0.11.0");
    fs.writeFileSync(path.join(c.dir("0.11.0"), ".orphaned_at"), "1");
    assert.equal(newerSibling(c.dir("0.9.0")).version, "0.10.0");
    assert.equal(newerSibling(c.dir("0.10.0")), null);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test("sync copies the newer tree over the active folder without leftovers and only once", () => {
  const c = cache({
    "0.1.0": { "skills/a/SKILL.md": "old", "lib/x.mjs": "same", "keep.txt": "mine" },
    "0.2.0": { "skills/a/SKILL.md": "new", "skills/b/SKILL.md": "added", "lib/x.mjs": "same", "keep.txt": "ignored" },
  });
  try {
    const first = syncInPlace(c.dir("0.1.0"));
    assert.deepEqual({ synced: first.synced, version: first.version, files: first.files }, { synced: true, version: "0.2.0", files: 2 });
    assert.equal(fs.readFileSync(path.join(c.dir("0.1.0"), "skills/a/SKILL.md"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(c.dir("0.1.0"), "skills/b/SKILL.md"), "utf8"), "added");
    assert.equal(fs.readFileSync(path.join(c.dir("0.1.0"), "keep.txt"), "utf8"), "mine");
    assert.equal(fs.readFileSync(path.join(c.dir("0.1.0"), SYNC_MARKER), "utf8").trim(), "0.2.0");
    assert.deepEqual(fs.readdirSync(path.join(c.dir("0.1.0"), "skills", "a")), ["SKILL.md"]);
    assert.equal(syncInPlace(c.dir("0.1.0")).reason, "already-synced");
    // Nothing newer, or not a cache folder: untouched.
    assert.equal(syncInPlace(c.dir("0.2.0")).reason, "no-newer-version");
    assert.equal(syncInPlace(path.join(c.base, "plain")).reason, "not-in-cache");
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test("the update is opt-in, throttled, bounded, and starts one detached worker", () => {
  const c = cache({ "0.1.0": { "skills/a/SKILL.md": "old" }, "0.2.0": { "skills/a/SKILL.md": "new" } });
  const launches = [];
  const launch = (command, args, options) => {
    launches.push({ args, options });
    return { on() {}, unref() {} };
  };
  const data = path.join(c.base, "data");
  const env = { AGENTIC_SDLC_AUTO_UPDATE: "1", CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: c.dir("0.1.0") };
  const run = (extra, now) => maybeAutoUpdate({ reason: "session-start", env: { ...env, ...extra }, now, pluginRoot: c.dir("0.1.0"), launch });
  try {
    assert.equal(run({ AGENTIC_SDLC_AUTO_UPDATE: "" }, 0).started, false);
    assert.equal(launches.length, 0);
    assert.equal(run({}, 1_000_000).started, true);
    const job = JSON.parse(launches[0].args[1]);
    assert.deepEqual({ marketplace: job.marketplace, plugin: job.plugin, timeoutMs: job.timeoutMs }, { marketplace: "mkt", plugin: "agentic-sdlc", timeoutMs: 120_000 });
    assert.equal(launches[0].options.detached, true);
    assert.equal(launches[0].options.stdio, "ignore");
    assert.equal(run({}, 1_000_000 + 14 * 60_000).reason, "throttled");
    assert.equal(run({}, 1_000_000 + 16 * 60_000).started, true);
    // A newly announced version bypasses the throttle once.
    const announce = (version, now) => maybeAutoUpdate({ reason: "announced", announcedVersion: version, env, now, pluginRoot: c.dir("0.1.0"), launch });
    assert.equal(announce("0.3.0", 1_000_000 + 17 * 60_000).started, true);
    assert.equal(announce("0.3.0", 1_000_000 + 18 * 60_000).reason, "throttled");
    // The running folder was remembered and synced from the cache sibling.
    assert.equal(fs.readFileSync(path.join(c.dir("0.1.0"), "skills/a/SKILL.md"), "utf8"), "new");
    assert.equal(syncRememberedRoots({ env }).length, 1);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test("the entry delegates to a newer version once, with arguments and the exit status", () => {
  const c = cache({ "0.1.0": { "bin/cli.mjs": "" }, "0.2.0": { "bin/cli.mjs": "" } });
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ args, options });
    return { status: 7 };
  };
  const base = { entry: path.join(c.dir("0.1.0"), "bin", "cli.mjs"), argv: ["status", "--json"], root: c.dir("0.1.0"), run };
  try {
    assert.equal(forwardToNewerVersion({ ...base, env: {} }), null);
    assert.equal(forwardToNewerVersion({ ...base, env: { AGENTIC_SDLC_AUTO_UPDATE: "1" } }), 7);
    assert.deepEqual(calls[0].args, [path.join(c.dir("0.2.0"), "bin", "cli.mjs"), "status", "--json"]);
    assert.equal(calls[0].options.stdio, "inherit");
    assert.equal(calls[0].options.env.AGENTIC_SDLC_FORWARDED, "1");
    assert.equal(forwardToNewerVersion({ ...base, env: { AGENTIC_SDLC_AUTO_UPDATE: "1", AGENTIC_SDLC_FORWARDED: "1" } }), null);
    assert.equal(forwardToNewerVersion({ ...base, root: c.dir("0.2.0"), entry: path.join(c.dir("0.2.0"), "bin", "cli.mjs"), env: { AGENTIC_SDLC_AUTO_UPDATE: "1" } }), null);
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test("sync also brings the manifests, so the active folder declares the version of its code", () => {
  const c = cache({ "0.1.0": { "package.json": JSON.stringify({ version: "0.1.0" }), "lib/x.mjs": "old" }, "0.2.0": { "package.json": JSON.stringify({ version: "0.2.0" }), "lib/x.mjs": "new" } });
  try {
    const result = syncInPlace(c.dir("0.1.0"));
    assert.equal(result.synced, true);
    assert.equal(result.manifests, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir("0.1.0"), "package.json"), "utf8")).version, "0.2.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir("0.1.0"), ".claude-plugin", "plugin.json"), "utf8")).version, "0.2.0");
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});

test("with a host install record only an installed version is forwarded to or synced from", () => {
  const c = cache({ "0.1.0": {}, "0.2.0": {}, "0.3.0": {} });
  const record = path.join(c.base, ".claude", "plugins", "installed_plugins.json");
  try {
    assert.equal(newerSibling(c.dir("0.1.0")).version, "0.3.0", "no record: the newest sibling");
    fs.writeFileSync(record, JSON.stringify({ version: 2, plugins: { "agentic-sdlc@mkt": [{ scope: "user", installPath: c.dir("0.2.0"), version: "0.2.0" }] } }));
    assert.equal(newerSibling(c.dir("0.1.0")).version, "0.2.0", "the pinned version, not the leftover 0.3.0");
    assert.equal(newerSibling(c.dir("0.2.0")), null);
    fs.writeFileSync(record, JSON.stringify({ version: 1, plugins: { "agentic-sdlc@mkt": { installPath: c.dir("0.3.0"), version: "0.3.0" } } }));
    assert.equal(newerSibling(c.dir("0.1.0")).version, "0.3.0");
    fs.writeFileSync(record, JSON.stringify({ version: 2, plugins: { "other@mkt": [{ version: "0.3.0" }] } }));
    assert.equal(newerSibling(c.dir("0.1.0")), null, "not installed for the host: nothing runs");
  } finally {
    fs.rmSync(c.base, { recursive: true, force: true });
  }
});
