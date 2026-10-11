import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_POLICY_FILE, processHygieneAtStop, takePendingReapWarning, WARNING_STATE_FILE } from "../../lib/host-hooks/process-hygiene.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "agentic-sdlc-guard.mjs");
const NOW = Date.parse("2026-03-01T12:00:00Z");

function project(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-")));
  fs.mkdirSync(path.join(dir, ".sdlc"));
  if (config) fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), JSON.stringify(config));
  return dir;
}

const slow = (dir) => ({ pid: 4242, ppid: 1, age_seconds: 25 * 60, command: `npm test --prefix ${dir}` });

test("without the opt-in Stop only warns, naming count, limit and the command to run", async () => {
  const dir = project();
  const common = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-git-"));
  try {
    const stopped = [];
    const result = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW, rows: [slow(dir)], reap: async (options) => {
      stopped.push(options.dryRun);
      const { reapProcesses } = await import("../../lib/runtime/process-reaper.mjs");
      return reapProcesses({ ...options, platform: "linux", worktrees: [], selfPid: 1 });
    } });
    assert.deepEqual(stopped, [true], "dry run only");
    assert.match(result.message, /^1 processes older than 10 min: 4242 npm test --prefix .*, run `mpsf processes reap`\.$/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(common, { recursive: true, force: true });
  }
});

test("the warning is throttled to one every 5 minutes and handed to the agent once", async () => {
  const dir = project();
  const common = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-git-"));
  const reap = async () => ({ older_than_minutes: 10, processes: [{ pid: 7, age_minutes: 12, command: "node slow" }] });
  try {
    const first = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW, reap });
    assert.match(first.message, /1 processes older than 10 min/u);
    const again = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW + 4 * 60_000, reap });
    assert.equal(again.message, "");
    const later = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW + 5 * 60_000 + 1, reap });
    assert.match(later.message, /1 processes/u);

    assert.match(takePendingReapWarning(dir, { commonDir: common }), /1 processes older than 10 min: 7 node slow/u);
    assert.equal(takePendingReapWarning(dir, { commonDir: common }), "", "shown once");
    assert.ok(fs.existsSync(path.join(common, "agentic-sdlc", WARNING_STATE_FILE)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(common, { recursive: true, force: true });
  }
});

test("nothing over the limit leaves no warning and no throttle stamp", async () => {
  const dir = project();
  const common = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-git-"));
  try {
    const result = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW, reap: async () => ({ older_than_minutes: 10, processes: [] }) });
    assert.equal(result.message, "");
    assert.equal(takePendingReapWarning(dir, { commonDir: common }), "");
    assert.equal(fs.existsSync(path.join(common, "agentic-sdlc", WARNING_STATE_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(common, { recursive: true, force: true });
  }
});

test("the opt-in (env or machine-local file) reaps for real at Stop and reports what it stopped", async () => {
  for (const [local, env] of [[null, { AGENTIC_SDLC_REAP_ON_STOP: "1" }], [{ reap_on_stop: true }, {}]]) {
    const dir = project();
    const common = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-git-"));
    try {
      if (local) {
        fs.mkdirSync(path.join(common, "agentic-sdlc"));
        fs.writeFileSync(path.join(common, "agentic-sdlc", LOCAL_POLICY_FILE), JSON.stringify(local));
      }
      const calls = [];
      const result = await processHygieneAtStop(dir, { env, commonDir: common, now: NOW, reap: async (options) => {
        calls.push(options.dryRun);
        return { older_than_minutes: 10, processes: [{ pid: 7, age_minutes: 12, command: "x", outcome: "terminated" }, { pid: 8, age_minutes: 12, command: "y", outcome: "failed" }] };
      } });
      assert.deepEqual(calls, [false]);
      assert.equal(result.message, "Stopped 1 processes older than 10 min: 7.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(common, { recursive: true, force: true });
    }
  }
});

test("the shared config can neither enable reaping at Stop nor widen what is selected", async () => {
  const wide = { host_policy: { process_reaper: { reap_on_stop: true, use_default_patterns: false, include_patterns: [".*"], scope_paths: ["/usr", "/Applications"], older_than_minutes: 0.01 } } };
  const dir = project(wide);
  const common = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-git-"));
  const rows = [
    { pid: 501, ppid: 1, age_seconds: 60 * 60, command: "/Applications/Firefox.app/Contents/MacOS/firefox" },
    { pid: 502, ppid: 1, age_seconds: 60, command: `npm test --prefix ${dir}` },
  ];
  try {
    const calls = [];
    const result = await processHygieneAtStop(dir, { env: {}, commonDir: common, now: NOW, rows, reap: async (options) => {
      calls.push(options.dryRun);
      const { reapProcesses } = await import("../../lib/runtime/process-reaper.mjs");
      return reapProcesses({ ...options, platform: "linux", worktrees: [], selfPid: 1 });
    } });
    assert.deepEqual(calls, [true], "dry run only");
    assert.equal(result.message, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(common, { recursive: true, force: true });
  }
});

test("a failing reaper never breaks the hook", async () => {
  const dir = project();
  try {
    assert.deepEqual(await processHygieneAtStop(dir, { env: {}, reap: async () => { throw new Error("ps broke"); } }), { message: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook warns once at Stop, hands the warning to the next prompt, and reaps with the opt-in", { skip: process.platform === "win32" }, async () => {
  // The pattern holds this run's pid, so only the process spawned below can match it.
  const unique = `hygiene-${process.pid}-${Date.now()}`;
  const dir = project();
  spawnSync("git", ["init", "-q", dir]);
  // Machine-local settings: the shared .sdlc/config.json may not lower the limit or add patterns at Stop.
  fs.mkdirSync(path.join(dir, ".git", "agentic-sdlc"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "agentic-sdlc", LOCAL_POLICY_FILE), JSON.stringify({ older_than_minutes: 0.01, include_patterns: [unique] }));
  const marker = path.join(dir, unique);
  const hook = (event, env = {}) => spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ cwd: dir }),
    encoding: "utf8",
    env: { ...process.env, AGENTIC_SDLC_KEEP_GOING: "off", AGENTIC_SDLC_AUTO_UPDATE: "0", ...env },
  });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stop = hook("stop");
    assert.equal(stop.status, 0);
    assert.match(JSON.parse(stop.stdout).systemMessage, /^1 processes older than 0(?:\.\d)? min: \d+ .*run `mpsf processes reap`/u);
    assert.equal(process.kill(child.pid, 0), true, "not stopped without the opt-in");
    assert.equal(hook("stop").stdout.trim(), "", "throttled");
    const prompt = hook("user-prompt-submit");
    assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /1 processes older than/u);
    assert.equal(hook("user-prompt-submit").stdout.trim(), "", "handed over once");

    const reaped = hook("stop", { AGENTIC_SDLC_REAP_ON_STOP: "1" });
    assert.match(JSON.parse(reaped.stdout).systemMessage, new RegExp(`^Stopped 1 processes .*: ${child.pid}\\.$`, "u"));
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", resolve)));
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
