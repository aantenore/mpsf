// Isolation providers for the release.local smoke test.
//
// A provider turns the approved smoke argv into a wrapper invocation that runs
// read-only and without external network. Its identity (provider id, wrapper
// executable, arguments, environment) is hash-sealed into the release.local
// authorization, so adding a provider never weakens an existing one: hosts
// without an available provider fail closed.
import path from "node:path";
import { fail } from "../cli/user-error.mjs";
import { childProcess, fs, os, process } from "../runtime/host.mjs";
import { PLUGIN_ROOT } from "../runtime/paths.mjs";

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

export const WINDOWS_APPCONTAINER_PROVIDER_ID = "windows-appcontainer-readonly-no-network";

const WINDOWS_LAUNCHER_SCRIPT = path.join(
  PLUGIN_ROOT, "lib", "delivery", "providers", "windows-appcontainer-launcher.ps1",
);
const POWERSHELL_PREFIX = Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);

function windowsPowerShell(env) {
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// Directories the per-run container may read: the smoke cwd and the folder of
// every absolute argv path outside it (the runtime, an entrypoint elsewhere).
// The launcher skips system folders, which AppContainers can already read.
function windowsReadPaths(cwd, argv) {
  const inside = (candidate) => {
    const relative = path.win32.relative(cwd, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  };
  const extra = argv
    .filter((argument) => path.win32.isAbsolute(argument) && /^[A-Za-z]:\\/u.test(argument))
    .map((argument) => path.win32.dirname(argument))
    .filter((directory) => !inside(directory));
  return [cwd, ...extra].filter((entry, index, values) => values.indexOf(entry) === index);
}

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
  Object.freeze({
    id: WINDOWS_APPCONTAINER_PROVIDER_ID,
    platform: "win32",
    executable: windowsPowerShell,
    script: WINDOWS_LAUNCHER_SCRIPT,
    boundary: Object.freeze({
      filesystem_writes: "denied_outside_private_container_storage",
      readable_files: "granted_paths_and_system",
      loopback_network: "denied",
      listener_based_smoke: "unsupported",
    }),
    // The request travels as base64 JSON, so no argument needs PowerShell or
    // command-line quoting; the launcher rebuilds the exact argv.
    args: (cwd, argv) => [
      ...POWERSHELL_PREFIX,
      "-File", WINDOWS_LAUNCHER_SCRIPT,
      "-Request", Buffer.from(JSON.stringify({
        cwd,
        argv,
        read_paths: windowsReadPaths(cwd, argv),
      }), "utf8").toString("base64"),
    ],
    probeArgs: () => [...POWERSHELL_PREFIX, "-File", WINDOWS_LAUNCHER_SCRIPT, "-Probe"],
  }),
]);

const UNAVAILABLE_BOUNDARY = Object.freeze({
  provider: "unavailable",
  provider_available: false,
  loopback_network: "unavailable",
  listener_based_smoke: "unsupported",
});

// A provider with a launcher dry run (Windows) is available only when the dry
// run passes; the result is cached per process.
const probeCache = new Map();

function defaultProbe(provider, executable, env) {
  if (!provider.probeArgs) return true;
  const key = `${provider.id}\0${executable}`;
  if (!probeCache.has(key)) {
    const result = childProcess.spawnSync(executable, provider.probeArgs(), {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      windowsHide: true,
      env: { SYSTEMROOT: env.SYSTEMROOT, WINDIR: env.WINDIR, TEMP: env.TEMP, TMP: env.TMP },
    });
    probeCache.set(key, !result.error && result.status === 0);
  }
  return probeCache.get(key);
}

function resolveHost(host = {}) {
  return {
    platform: host.platform ?? process.platform,
    exists: host.exists ?? ((candidate) => fs.existsSync(candidate)),
    env: host.env ?? process.env,
    probe: host.probe ?? defaultProbe,
  };
}

function providerExecutable(provider, env) {
  return typeof provider.executable === "function" ? provider.executable(env) : provider.executable;
}

function providerAvailable(provider, resolved) {
  const executable = providerExecutable(provider, resolved.env);
  return resolved.exists(executable)
    && (!provider.script || resolved.exists(provider.script))
    && resolved.probe(provider, executable, resolved.env) === true;
}

// Test-only simulation of a host without any provider. It can only remove
// isolation capability, never grant it. The test runner uses it on Windows so
// the suite keeps exercising the fail-closed path there.
function providersForcedUnavailable(env) {
  return (env.NODE_ENV === "test" || env.AGENTIC_SDLC_TEST_DEFER_SMOKE_PROVIDER_PREFLIGHT === "1")
    && env.AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER === "unavailable";
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
  return provider && providerAvailable(provider, resolved) ? provider : null;
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
    provider_available: providerAvailable(provider, resolved),
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
    // PowerShell compiles the AppContainer API into TEMP; the smoke process
    // itself gets TEMP pointed at its private container storage.
    ...(platform === "win32" ? [["TEMP", env.TEMP || os.tmpdir()], ["TMP", env.TMP || env.TEMP || os.tmpdir()]] : []),
  ].filter(([, value]) => Boolean(value)));
}

export function localSmokeProviderOptionsText(platform = process.platform) {
  const options = [
    ...(platform === "win32"
      ? ["on Windows 10 1809 or later, allow Windows PowerShell in FullLanguage mode (not blocked by "
        + "AppLocker or WDAC, execution policy not forced by Group Policy) so the AppContainer provider can run"]
      : []),
    "run the plugin and the local release on macOS (uses /usr/bin/sandbox-exec)",
    "run them on Linux with bubblewrap installed at /usr/bin/bwrap; on Windows this works today by "
      + "running the whole CLI inside a WSL2 Linux distribution with the project on the Linux filesystem",
    "deliver through a pull request (--kind pull_request), which does not execute a local smoke test",
  ];
  const host = platform === "win32"
    ? "the Windows AppContainer smoke isolation provider is not available on this host "
      + "(see docs/plans/windows-local-release.md)"
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
    executable: providerExecutable(provider, resolved.env),
    ...(provider.script ? { script: provider.script } : {}),
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
