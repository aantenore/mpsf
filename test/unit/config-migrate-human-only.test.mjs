import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { humanOnlyEdits } from "../../lib/engine/config-human-only.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "bin", "mpsf.mjs");

function cli(args, env = {}) {
  const base = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete base[key];
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...base, ...env }, timeout: 30_000 });
}

test("only edits under a human-only pointer, or unknown edits, need a person", () => {
  const paths = ["/authority_policy", "/gate_policy"];
  assert.deepEqual(humanOnlyEdits(null, paths), []);
  assert.deepEqual(humanOnlyEdits({ status: "unchanged", changes: [] }, paths), []);
  assert.deepEqual(humanOnlyEdits({ status: "changed", change_count: 1, changes: [{ path: "/budget_policy/x" }] }, paths), []);
  assert.deepEqual(humanOnlyEdits({ status: "changed", change_count: 1, changes: [{ path: "/authority_policy/trusted_host_keys" }] }, paths), ["/authority_policy"]);
  assert.deepEqual(humanOnlyEdits({ status: "changed", change_count: 1, changes: [{ path: "" }] }, paths), paths);
  assert.deepEqual(humanOnlyEdits({ status: "changed", change_count: null, changes: [] }, paths), paths);
});

test("config migrate --apply of a gate edit is refused inside an agent session and works for the person", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "migrate-human-")));
  try {
    assert.equal(cli(["init", "--root", project, "--project-name", "T", "--force"]).status, 0);
    const configPath = path.join(project, ".sdlc", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.gate_policy.merge_requires_code_review = !config.gate_policy.merge_requires_code_review;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const preview = JSON.parse(cli(["config", "migrate", "--root", project, "--json"]).stdout);
    const apply = ["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--json"];
    const refused = cli(apply, { CLAUDECODE: "1" });
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /\/gate_policy can only be confirmed by the user/u);
    const applied = cli(apply);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).status, "applied");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
