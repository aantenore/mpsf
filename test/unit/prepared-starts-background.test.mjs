import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startPreparedStartsInBackground } from "../../lib/host-hooks/prepared-starts.mjs";

test("Stop hook: prepared starts resolve detached, at most once per window per clone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-bg-"));
  try {
    const stateDir = path.join(root, "state");
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ args, options });
      return { unref() {} };
    };
    assert.equal(startPreparedStartsInBackground(root, { env: {}, stateDir, now: 1000, spawn }).started, false, "nothing waiting");
    fs.mkdirSync(path.join(root, ".sdlc", "prepared-starts"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "prepared-starts", "ST-1.json"), JSON.stringify({ story_id: "ST-1", state: "waiting" }));
    assert.equal(startPreparedStartsInBackground(root, { env: {}, stateDir, now: 1000, spawn }).started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.detached, true);
    assert.ok(calls[0].args.includes("--resolve"));
    assert.equal(startPreparedStartsInBackground(root, { env: {}, stateDir, now: 2000, spawn }).started, false, "throttled");
    assert.equal(startPreparedStartsInBackground(root, { env: {}, stateDir, now: 1000 + 5 * 60 * 1000, spawn }).started, true);
    assert.equal(startPreparedStartsInBackground(root, { env: { AGENTIC_SDLC_PREPARED_STARTS: "off" }, stateDir, now: 10 ** 9, spawn }).started, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
