// Real AppContainer runs; only meaningful on a Windows host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { localSmokeExecutionBoundary, localSmokeSandboxCommand } from "../../lib/delivery/local-smoke-providers.mjs";

function smokeEnvironment() {
  // process.env is case-insensitive on Windows; a plain copy is not.
  const env = { ...process.env };
  for (const key of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) env[key] = process.env[key];
  delete env.AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER;
  return env;
}

// A Windows host whose launcher probe fails (PowerShell not in FullLanguage mode, AppContainer
// profiles unavailable, as on some hosted CI runners) has no provider: the product fails closed
// there, which test/unit/local-smoke-providers.test.mjs covers, and no real container can run.
function appContainerSkip() {
  if (process.platform !== "win32") return "AppContainer exists only on Windows";
  if (localSmokeExecutionBoundary({ env: smokeEnvironment() }).provider_available) return false;
  return "the Windows AppContainer provider probe fails on this host, so no real container can run";
}

const skip = appContainerSkip();

function runSmoke(cwd, source) {
  const entry = path.join(cwd, "smoke.cjs");
  fs.writeFileSync(entry, source);
  const env = smokeEnvironment();
  // Node resolves the real path of its entry point by reading every ancestor folder, and some hosts
  // (GitHub's Windows runners) deny AppContainers read access to the drive root.
  const command = localSmokeSandboxCommand(cwd, [process.execPath, "--preserve-symlinks-main", entry], { env });
  return spawnSync(command.executable, command.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    env: command.env,
  });
}

function withRelease(callback) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "appcontainer-smoke-"));
  try {
    return callback(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("a passing smoke run relays output and exit 0", { skip }, () => withRelease((cwd) => {
  const result = runSmoke(cwd, "console.log('smoke ok'); console.error('to stderr');");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "smoke ok");
  assert.match(result.stderr, /to stderr/u);
}));

test("a failing smoke run keeps its exit code", { skip }, () => withRelease((cwd) => {
  assert.equal(runSmoke(cwd, "process.exit(7);").status, 7);
}));

test("writes into the release are denied", { skip }, () => withRelease((cwd) => {
  const result = runSmoke(cwd, "require('fs').writeFileSync(require('path').join(__dirname, 'x.txt'), 'x');");
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(cwd, "x.txt")), false);
}));

// Windows allows loopback inside one AppContainer (a listener and a client in the same container
// can talk), so the boundary that matters is the host: the listener runs in this test process,
// outside the container. The kernel completes the handshake from the listen backlog even while
// spawnSync blocks the event loop, so a reachable port would make the smoke exit 0.
test("loopback connections to the host are denied", { skip }, async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    withRelease((cwd) => {
      const result = runSmoke(cwd, [
        "const net = require('net');",
        `const socket = net.connect(${port}, '127.0.0.1');`,
        "socket.on('connect', () => process.exit(0));",
        "socket.on('error', () => process.exit(3));",
        "setTimeout(() => process.exit(5), 10000);",
      ].join("\n"));
      assert.notEqual(result.status, 0, result.stderr);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
