import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE,
  assertLocalSmokeProviderAvailableForProposal,
  localSmokeExecutionBoundary,
  localSmokeProviderIds,
  localSmokeSandboxCommand,
} from "../../lib/delivery/local-smoke-providers.mjs";

const host = (platform, present = [], env = {}) => ({
  platform,
  exists: (candidate) => present.includes(candidate),
  env,
});

test("each supported host maps to exactly one read-only, no-network provider", () => {
  assert.deepEqual(localSmokeProviderIds(), [
    "macos-sandbox-exec-readonly-no-network",
    "linux-bwrap-readonly-no-network",
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

test("Windows has no provider and every smoke path fails closed with options", () => {
  const windows = host("win32", [], { SYSTEMROOT: "C:\\Windows" });
  const boundary = localSmokeExecutionBoundary(windows);
  assert.equal(boundary.provider, "unavailable");
  assert.equal(boundary.provider_available, false);
  assert.throws(
    () => localSmokeSandboxCommand("C:\\release", ["C:\\node\\node.exe", "smoke.mjs"], windows),
    (error) => error.message.startsWith(LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE)
      && /WSL2/u.test(error.message)
      && /--kind pull_request/u.test(error.message),
  );
  assert.throws(
    () => assertLocalSmokeProviderAvailableForProposal(windows),
    /cannot be proposed[\s\S]*Windows has no supported smoke isolation provider[\s\S]*Nothing was recorded/u,
  );
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
