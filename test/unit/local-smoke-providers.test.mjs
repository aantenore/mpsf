import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE,
  assertLocalSmokeProviderAvailableForProposal,
  localSmokeExecutionBoundary,
  localSmokeProviderIds,
  localSmokeSandboxCommand,
} from "../../lib/delivery/local-smoke-providers.mjs";

const host = (platform, present = [], env = {}, probe = () => true) => ({
  platform,
  exists: (candidate) => present.includes(candidate),
  env,
  probe,
});

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const anyScript = (candidate) => candidate.endsWith("windows-appcontainer-launcher.ps1");
const windowsHost = (probe = () => true, env = {}) => ({
  platform: "win32",
  exists: (candidate) => candidate === POWERSHELL || anyScript(candidate),
  env: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Users\\me\\AppData\\Local\\Temp", ...env },
  probe,
});

test("each supported host maps to exactly one read-only, no-network provider", () => {
  assert.deepEqual(localSmokeProviderIds(), [
    "macos-sandbox-exec-readonly-no-network",
    "linux-bwrap-readonly-no-network",
    "windows-appcontainer-readonly-no-network",
  ]);
  const mac = localSmokeExecutionBoundary(host("darwin", ["/usr/bin/sandbox-exec"]));
  assert.equal(mac.provider, "macos-sandbox-exec-readonly-no-network");
  assert.equal(mac.provider_available, true);
  assert.equal(mac.filesystem_writes, "denied");
  assert.equal(mac.external_network, "denied");
  assert.equal(mac.loopback_network, "denied");
  const linux = localSmokeExecutionBoundary(host("linux", ["/usr/bin/bwrap"]));
  assert.equal(linux.provider, "linux-bwrap-readonly-no-network");
  assert.equal(linux.loopback_network, "isolated_namespace_only");
});

test("a missing wrapper keeps the provider name but reports it unavailable", () => {
  const linux = localSmokeExecutionBoundary(host("linux"));
  assert.equal(linux.provider, "linux-bwrap-readonly-no-network");
  assert.equal(linux.provider_available, false);
});

test("Windows without a working AppContainer launcher fails closed with options", () => {
  for (const windows of [
    host("win32", [], { SYSTEMROOT: "C:\\Windows" }),
    windowsHost(() => false),
  ]) {
    const boundary = localSmokeExecutionBoundary(windows);
    assert.equal(boundary.provider, "windows-appcontainer-readonly-no-network");
    assert.equal(boundary.provider_available, false);
    assert.throws(
      () => localSmokeSandboxCommand("C:\\release", ["C:\\node\\node.exe", "smoke.mjs"], windows),
      (error) => error.message.startsWith(LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE)
        && /FullLanguage/u.test(error.message)
        && /WSL2/u.test(error.message)
        && /--kind pull_request/u.test(error.message),
    );
    assert.throws(
      () => assertLocalSmokeProviderAvailableForProposal(windows),
      /cannot be proposed[\s\S]*AppContainer smoke isolation provider is not available[\s\S]*Nothing was recorded/u,
    );
  }
});

test("the AppContainer wrapper runs a hash-sealable launcher script with an exact request", () => {
  const probes = [];
  const windows = windowsHost((provider, executable) => {
    probes.push([provider.id, executable]);
    return true;
  });
  const boundary = localSmokeExecutionBoundary(windows);
  assert.equal(boundary.provider, "windows-appcontainer-readonly-no-network");
  assert.equal(boundary.provider_available, true);
  assert.equal(boundary.external_network, "denied");
  assert.equal(boundary.loopback_network, "denied");
  assert.equal(boundary.listener_based_smoke, "unsupported");
  assert.equal(boundary.filesystem_writes, "denied_outside_private_container_storage");
  assert.equal(boundary.readable_files, "granted_paths_and_system");
  assert.doesNotThrow(() => assertLocalSmokeProviderAvailableForProposal(windows));

  const argv = ["C:\\Users\\me\\nvm\\node.exe", "C:\\release\\app\\smoke.mjs", "say \"hi\""];
  const command = localSmokeSandboxCommand("C:\\release\\app", argv, windows);
  assert.equal(command.kind, "windows-appcontainer-readonly-no-network");
  assert.equal(command.executable, POWERSHELL);
  assert.ok(anyScript(command.script));
  assert.deepEqual(probes[0], ["windows-appcontainer-readonly-no-network", POWERSHELL]);
  assert.deepEqual(command.args.slice(0, 8), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", command.script, "-Request",
  ]);
  assert.equal(command.args.length, 9);
  assert.match(command.args[8], /^[A-Za-z0-9+/=]+$/u);
  assert.deepEqual(JSON.parse(Buffer.from(command.args[8], "base64").toString("utf8")), {
    cwd: "C:\\release\\app",
    argv,
    read_paths: ["C:\\release\\app", "C:\\Users\\me\\nvm"],
  });
  assert.equal(command.env.SYSTEMROOT, "C:\\Windows");
  assert.equal(command.env.TEMP, "C:\\Users\\me\\AppData\\Local\\Temp");
  assert.equal(command.env.TMP, "C:\\Users\\me\\AppData\\Local\\Temp");
  assert.deepEqual(localSmokeSandboxCommand("C:\\release\\app", argv, windows), command);
});

test("the AppContainer launcher script keeps its fail-closed contract", () => {
  const script = fs.readFileSync(
    new URL("../../lib/delivery/providers/windows-appcontainer-launcher.ps1", import.meta.url),
    "utf8",
  );
  assert.match(script, /LanguageMode -ne "FullLanguage"/u);
  assert.match(script, /CreateAppContainerProfile\(name, name, [^,]+, IntPtr\.Zero, 0, out sid\)/u);
  assert.match(script, /PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES/u);
  assert.match(script, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(script, /\[Guid\]::NewGuid\(\)/u);
  assert.match(script, /\/remove:g/u);
  // The minimal launcher environment has no PATHEXT; icacls.exe must still run as an application.
  assert.match(script, /\$env:PATHEXT = /u);
  assert.match(script, /DeleteProfile\(\$name\)/u);
  assert.match(script, /exit 125/u);
  assert.doesNotMatch(script, /internetClient|privateNetworkClientServer|LoopbackExempt/u);
});

test("the bwrap wrapper binds the filesystem read-only and unshares the network", () => {
  const command = localSmokeSandboxCommand(
    "/srv/release/app",
    ["/usr/bin/node", "smoke.mjs"],
    host("linux", ["/usr/bin/bwrap"], { TMPDIR: "/tmp" }),
  );
  assert.equal(command.kind, "linux-bwrap-readonly-no-network");
  assert.equal(command.executable, "/usr/bin/bwrap");
  assert.deepEqual(command.args, [
    "--unshare-net",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--chdir", "/srv/release/app",
    "--", "/usr/bin/node", "smoke.mjs",
  ]);
  assert.equal(command.env.TMPDIR, "/tmp");
  if (process.platform !== "win32") assert.equal(command.env.PATH, "/usr/bin:/bin");
});

test("the test simulation can only remove a provider, and deferral only postpones the check", () => {
  const simulated = host("darwin", ["/usr/bin/sandbox-exec"], {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER: "unavailable",
  });
  assert.equal(localSmokeExecutionBoundary(simulated).provider, "unavailable");
  assert.throws(() => localSmokeSandboxCommand("/tmp", ["/usr/bin/true"], simulated));
  assert.throws(() => assertLocalSmokeProviderAvailableForProposal(simulated), /cannot be proposed/u);

  const outsideTests = host("darwin", ["/usr/bin/sandbox-exec"], {
    AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER: "unavailable",
  });
  assert.equal(localSmokeExecutionBoundary(outsideTests).provider_available, true);

  const deferred = host("win32", [], { AGENTIC_SDLC_TEST_DEFER_SMOKE_PROVIDER_PREFLIGHT: "1" });
  assert.doesNotThrow(() => assertLocalSmokeProviderAvailableForProposal(deferred));
  assert.throws(() => localSmokeSandboxCommand("C:\\release", ["C:\\node.exe"], deferred));
});
