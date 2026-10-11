import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PLUGIN_VERSION } from "../lib/plugin-compatibility.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const hook = path.join(repoRoot, "hooks", "agentic-sdlc-guard.mjs");
const tempPaths = new Set();

after(() => {
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function run(args, cwd) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "AGENTIC_SDLC_HOST_LABEL"]) delete env[key];
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initializedProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-plugin-compat-"));
  tempPaths.add(project);
  git(project, ["init", "-q"]);
  git(project, ["config", "user.name", "Compat"]);
  git(project, ["config", "user.email", "compat@example.invalid"]);
  const init = run(["init", "--root", project, "--project-name", "Compat"], project);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return project;
}

function requireVersion(project, version) {
  const directory = path.join(project, ".sdlc", "compatibility");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "future-feature.json"), `${JSON.stringify({
    schema_version: "plugin-compatibility-requirement:v1",
    feature: "future-feature",
    minimum_plugin_version: version,
    summary: "A feature this plugin predates",
  }, null, 2)}\n`);
}

// Merged scenario, one project for both plugin-compatibility outcomes:
// 1. "a project whose records this plugin understands runs normally and its cache follows the plugin version"
// 2. "an older plugin refuses changes, keeps reads working, and says how to update"
test("a project runs normally while this plugin understands its records, and an older plugin refuses changes and says how to update", () => {
  const project = initializedProject();

  // 1. A project whose records this plugin understands runs normally and its cache follows the plugin version.
  requireVersion(project, PLUGIN_VERSION);
  const rebuild = run(["cache", "rebuild", "--root", project, "--json"], project);
  assert.equal(rebuild.status, 0, rebuild.stdout + rebuild.stderr);
  const cachePath = path.join(project, ".sdlc", "cache", "kb-cache.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.plugin_version, PLUGIN_VERSION);
  const healthy = JSON.parse(run(["doctor", "--root", project, "--json"], project).stdout);
  assert.equal(healthy.checks.find((item) => item.id === "plugin-compatibility").status, "passed");

  // A cache written by another plugin version is derived data: it is reported stale, not trusted.
  fs.writeFileSync(cachePath, `${JSON.stringify({ ...cache, plugin_version: "0.0.1" }, null, 2)}\n`);
  const cacheStatus = JSON.parse(run(["cache", "status", "--root", project, "--json"], project).stdout);
  assert.equal(cacheStatus.valid, false);
  assert.equal(cacheStatus.plugin_version_mismatch, true);

  // 2. An older plugin refuses changes, keeps reads working, and says how to update.
  requireVersion(project, "999.0.0");

  const write = run(["cache", "rebuild", "--root", project, "--json"], project);
  assert.notEqual(write.status, 0);
  assert.match(write.stdout + write.stderr, /PLUGIN_UPDATE_REQUIRED/u);
  assert.match(write.stdout + write.stderr, /claude plugin update mpsf@/u);

  const status = run(["status", "--root", project, "--json"], project);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.plugin_compatibility.required_plugin_version, "999.0.0");
  assert.equal(payload.plugin_compatibility.satisfied, false);

  const human = run(["status", "--root", project, "--locale", "it"], project);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Aggiorna il plugin: claude plugin marketplace update/u);

  const doctor = JSON.parse(run(["doctor", "--root", project, "--json"], project).stdout);
  const check = doctor.checks.find((item) => item.id === "plugin-compatibility");
  assert.equal(check.status, "failed");
  assert.match(check.details, /999\.0\.0/u);

  const session = spawnSync(process.execPath, [hook, "session-start"], {
    input: JSON.stringify({ cwd: project }),
    encoding: "utf8",
  });
  assert.equal(session.status, 0);
  assert.match(session.stdout, /Update the plugin: claude plugin marketplace update/u);
});
