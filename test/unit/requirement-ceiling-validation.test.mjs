import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, AGENTIC_SDLC_AUTO_PUBLISH: "off" },
    timeout: 60_000,
  });
}

test("requirement propose refuses an unknown autonomy ceiling as a user error that lists the allowed values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-ceiling-"));
  try {
    spawnSync("git", ["init", "-q", root]);
    assert.equal(cli(root, ["init"]).status, 0);
    const result = cli(root, [
      "requirement", "propose",
      "--id", "REQ-CEILING-001",
      "--title", "Ceiling check",
      "--summary", "Refuse an unknown ceiling",
      "--acceptance", "The command names the allowed values",
      "--autonomy-ceiling", "bogus",
      "--json",
    ]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, "USER_ERROR");
    for (const level of ["supervised", "checkpointed", "bounded-autonomous"]) {
      assert.match(report.error.message, new RegExp(level, "u"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
