// Isolation providers for the release.local smoke test.
//
// A provider turns the approved smoke argv into a wrapper invocation that runs
// read-only and without external network. Its identity (provider id, wrapper
// executable, arguments, environment) is hash-sealed into the release.local
// authorization, so adding a provider never weakens an existing one: hosts
// without an available provider fail closed.
import path from "node:path";
import { fail } from "../cli/user-error.mjs";
import { fs, os, process } from "../runtime/host.mjs";

export const LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE =
  "Local smoke-test execution requires a configured read-only, no-network sandbox on this host.";

const COMMON_BOUNDARY = Object.freeze({
  schema_version: "local-smoke-execution-boundary:v1",
  filesystem_writes: "denied",
  readable_files: "host_account_scope",
  confidentiality_isolation: "not_provided",
  transitive_code_attestation: "not_provided",
  external_network: "denied",
  reviewed_code_required: true,
  explicit_entrypoint_binding: "artifact_manifest_bound",
  portable_recommendation: "do_not_depend_on_network_or_listeners",
  recommended_patterns: Object.freeze([
    "exercise an exported API handler in-process",
    "validate built artifact files without opening sockets",
  ]),
});

const MACOS_SANDBOX_PROFILE =
  "(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) (allow mach-lookup)";

const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "macos-sandbox-exec-readonly-no-network",
    platform: "darwin",
    executable: "/usr/bin/sandbox-exec",
    boundary: Object.freeze({
      loopback_network: "denied",
      listener_based_smoke: "unsupported",
    }),
    args: (_cwd, argv) => ["-p", MACOS_SANDBOX_PROFILE, argv[0], ...argv.slice(1)],
  }),
  Object.freeze({
    id: "linux-bwrap-readonly-no-network",
    platform: "linux",
    executable: "/usr/bin/bwrap",
    boundary: Object.freeze({
      loopback_network: "isolated_namespace_only",
      listener_based_smoke: "namespace_local_only",
    }),
    args: (cwd, argv) => [
      "--unshare-net",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--chdir", cwd,
      "--", argv[0], ...argv.slice(1),
    ],
  }),
]);

const UNAVAILABLE_BOUNDARY = Object.freeze({
  provider: "unavailable",
  provider_available: false,
  loopback_network: "unavailable",
  listener_based_smoke: "unsupported",
});

function resolveHost(host = {}) {
  return {
    platform: host.platform ?? process.platform,
    exists: host.exists ?? ((candidate) => fs.existsSync(candidate)),
    env: host.env ?? process.env,
  };
}

// Test-only simulation of a host without any provider. It can only remove
// isolation capability, never grant it.
function providersForcedUnavailable(env) {
  return env.NODE_ENV === "test" && env.AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER === "unavailable";
}

export function localSmokeProviderForPlatform(platform) {
  return PROVIDERS.find((provider) => provider.platform === platform) || null;
}

export function localSmokeProviderIds() {
  return PROVIDERS.map((provider) => provider.id);
}

function availableProvider(resolved) {
  if (providersForcedUnavailable(resolved.env)) return null;
  const provider = localSmokeProviderForPlatform(resolved.platform);
  return provider && resolved.exists(provider.executable) ? provider : null;
}

export function localSmokeExecutionBoundary(host) {
  const resolved = resolveHost(host);
  const provider = providersForcedUnavailable(resolved.env)
    ? null
    : localSmokeProviderForPlatform(resolved.platform);
  if (!provider) {
    return { ...COMMON_BOUNDARY, recommended_patterns: [...COMMON_BOUNDARY.recommended_patterns], ...UNAVAILABLE_BOUNDARY };
  }
  return {
    ...COMMON_BOUNDARY,
    recommended_patterns: [...COMMON_BOUNDARY.recommended_patterns],
    provider: provider.id,
    provider_available: resolved.exists(provider.executable),
    ...provider.boundary,
  };
}

function minimalSmokeEnvironment(argv, platform, env) {
  const governedPathEntries = [
    path.dirname(path.resolve(argv[0])),
    ...(platform === "win32" ? [] : ["/usr/bin", "/bin"]),
  ].filter((entry, index, values) => values.indexOf(entry) === index);
  return Object.fromEntries([
    ["PATH", governedPathEntries.join(path.delimiter)],
    ["TMPDIR", env.TMPDIR || os.tmpdir()],
    ["SYSTEMROOT", env.SYSTEMROOT],
    ["WINDIR", env.WINDIR],
  ].filter(([, value]) => Boolean(value)));
}

export function localSmokeProviderOptionsText(platform = process.platform) {
  const options = [
    "run the plugin and the local release on macOS (uses /usr/bin/sandbox-exec)",
    "run them on Linux with bubblewrap installed at /usr/bin/bwrap; on Windows this works today by "
      + "running the whole CLI inside a WSL2 Linux distribution with the project on the Linux filesystem",
    "deliver through a pull request (--kind pull_request), which does not execute a local smoke test",
  ];
  const host = platform === "win32"
    ? "Windows has no supported smoke isolation provider yet (see docs/plans/windows-local-release.md)"
    : `this ${platform} host has no supported smoke isolation provider available`;
  return `${host}. Options: ${options.map((option, index) => `(${index + 1}) ${option}`).join("; ")}.`;
}

export function localSmokeSandboxCommand(cwd, argv, host) {
  const resolved = resolveHost(host);
  const provider = availableProvider(resolved);
  if (!provider) {
    fail(`${LOCAL_SMOKE_SANDBOX_UNAVAILABLE_MESSAGE} ${localSmokeProviderOptionsText(resolved.platform)}`);
  }
  return {
    kind: provider.id,
    executable: provider.executable,
    args: provider.args(cwd, argv),
    env: minimalSmokeEnvironment(argv, resolved.platform, resolved.env),
  };
}

// Proposal preflight: a local release on a host with no available provider can
// never be authorized, so stop before any delivery record is written. The
// deferral switch only postpones the same fail-closed check to release.local
// authorization; it is used by the test runner on hosts without a sandbox.
export function assertLocalSmokeProviderAvailableForProposal(host) {
  const resolved = resolveHost(host);
  if (availableProvider(resolved)) return;
  if (resolved.env.AGENTIC_SDLC_TEST_DEFER_SMOKE_PROVIDER_PREFLIGHT === "1") return;
  fail(
    "This local release cannot be proposed: release.local runs the smoke test on the released "
    + "artifact inside a read-only, no-network sandbox, and "
    + localSmokeProviderOptionsText(resolved.platform)
    + " Nothing was recorded.",
  );
}
