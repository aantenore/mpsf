# Plan: `release.local` on Windows

Status: early proposal failure and the provider seam are implemented in 0.146.17. A native Windows provider is not implemented yet.

## Current behaviour (verified on 0.146.17)

- `release.local` runs the approved smoke argv against the released artifact bytes. It runs from the governed `--smoke-cwd`, behind an isolation wrapper. The wrapper identity is sealed at authorization in `local-smoke-sandbox-policy:v2`: provider id, wrapper executable and its SHA-256, wrapper args, minimal environment, command and runtime executables with their hashes, payload bindings, plugin build, and host platform. The seal is checked again before spawn and at completion (`lib/engine/delivery.mjs`: `localSmokeSandboxPolicyAttestation`, `runApprovedLocalSmokeTests`, and the `release.local` completion path).
- Providers now live in `lib/delivery/local-smoke-providers.mjs`. There are two:
  - `macos-sandbox-exec-readonly-no-network` (`/usr/bin/sandbox-exec`, deny-default profile, `file-read*` only, no network or loopback);
  - `linux-bwrap-readonly-no-network` (`/usr/bin/bwrap --unshare-net --ro-bind / /`).
  Any other host gets `provider: "unavailable"`, and `localSmokeSandboxCommand` fails closed.
- Since 0.146.17, `autonomy delivery propose --kind local_release` fails before anything is recorded when no provider is available. The error lists the options. Before this release it only printed `Smoke execution provider: unavailable` and failed later, at the `release.local` checkpoint.
- No configuration option disables the sandbox or substitutes another isolation. This plan keeps it that way: every new provider is a code-defined, hash-pinned entry. Configuration can only select among providers the code accepts, and it is sealed into the human-approved delivery profile.

## Guarantees any provider must keep

1. The filesystem is read-only for the smoke process. The artifact manifest must be unchanged before and after the smoke run (this is already enforced).
2. No external network.
3. The wrapper identity is hash-verifiable at authorization and again immediately before spawn.
4. Exit status, stdout and stderr are relayed faithfully. A wrapper fault must never look like a passing smoke run.
5. Availability is probed, and the provider is reported unavailable when the probe fails (fail closed).
6. The boundary record states what the provider gives (loopback policy, read scope, confidentiality) and does not overstate it.

## Options

### (a) Native Windows: AppContainer (recommended primary)

- **Mechanism.** Use a per-run AppContainer profile (`CreateAppContainerProfile`) with **no capabilities**. Launch the process with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`. Without `internetClient` or `privateNetworkClientServer` the process has no network. Loopback is also blocked unless an exemption exists (`CheckNetIsolation LoopbackExempt`); a fresh per-run container name can never have one. Writes are denied everywhere except the container's private storage under `%LOCALAPPDATA%\Packages\<name>\AC`. The profile is deleted after the run.
- **Reads.** AppContainer reads only objects whose ACL grants `ALL APPLICATION PACKAGES` or the container SID. System32 and Program Files are readable by default. The smoke cwd, and the runtime directory when it sits outside Program Files (for example an nvm or user-profile Node), need a temporary read-only ACE for the per-run SID. That ACE is removed afterwards. ACL metadata is not part of the content manifest. Result: reads are narrower than on macOS or Linux (`readable_files: "granted_paths_and_system"`), which is stronger than today.
- **Wrapper.** Use `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (hash-pinned like `sandbox-exec`) running a launcher script shipped in the plugin (`lib/delivery/providers/windows-appcontainer-launcher.ps1`). It uses `Add-Type` P/Invoke and relays stdout, stderr and the exit code. The script's SHA-256 goes into the launcher subject as `wrapper_script_sha256` and is checked before spawn. The alternative is a small compiled helper, which needs signing and a build pipeline; reject it for now.
- **Availability.** Windows 10 1809+ and 11, every edition including Home. No admin rights and no install needed. If AppLocker or WDAC puts PowerShell in Constrained Language Mode, `Add-Type` is blocked. The probe then fails and the provider reports unavailable (fail closed).
- **Honest labelling.** Use `filesystem_writes: "denied_outside_private_container_storage"`, `loopback_network: "denied"`, `listener_based_smoke: "unsupported"`.
- **Fit.** This is the best fit. The smoke run uses the same host runtime (`node.exe`) that is already resolved and hashed, so the launcher subject keeps its meaning and only the wrapper changes.

### (a') Windows Sandbox `.wsb` (rejected)

It is available only on Pro, Enterprise and Education with virtualization on, and only one instance runs at a time. `WindowsSandbox.exe` returns before the guest finishes, so exit code and output need an out-of-band channel through a mapped folder, which then has to be writable. Startup takes tens of seconds, and the guest runtime differs from the host runtime. It fails guarantees 3, 4 and 5 without heavy machinery.

### (b) WSL2 + bwrap

- **Works today with zero code.** Run the whole CLI inside a WSL2 distribution (`process.platform === "linux"`) with `bubblewrap` installed and the project on the Linux filesystem. The existing Linux provider applies unchanged, and the proposal error already suggests this. This is the **recommended fallback**.
- **Bridge provider** (Windows-native CLI calling `wsl.exe -e bwrap ...`) is not recommended:
  - the smoke run would use the Linux runtime inside WSL rather than the hashed Windows runtime, so the runtime identity in the launcher subject no longer matches what runs;
  - paths need mapping (`C:\x` to `/mnt/c/x` via `wslpath`), and `/mnt/c` drvfs semantics differ;
  - only `wsl.exe` is hash-verifiable from Windows, and the inner `bwrap` is hashed only through `\\wsl$`;
  - detection (`wsl.exe --status`, the default distro, and `command -v bwrap` inside it) is slow and stateful.

### (c) Container provider (Docker or Podman, `--network none --read-only`)

This is strong and portable: `--network none`, `--read-only`, the artifact bind-mounted `:ro`, `--cap-drop ALL`, `--security-opt no-new-privileges`, and the image pinned by `@sha256:` digest. But:

- The runtime is the image's. The launcher subject must swap host runtime hashes for the image digest, and payload bindings must map to the mount path. This is a redesign of the launcher subject, not just a new wrapper.
- The daemon becomes part of the trusted base. The CLI hash proves little about Docker Desktop's VM.
- It needs a human-approved selection sealed in the delivery profile (`local_release_target.smoke_isolation: { provider: "container", engine: "docker", image: "<name>@sha256:..." }`).

Keep it as a later, team-level option (CI parity) and not as the Windows answer.

### (d) Attested external smoke (only as a labelled, lower-assurance mode)

A person runs the smoke test elsewhere and seals a signed attestation (artifact manifest hash, command, output hashes) with `--actor-type human --approval-source explicit-user`. It is never automatic, never from an agent or a standing approval, and it is refused under `bounded-autonomous`. The certificate would carry `smoke_isolation_assurance: "externally_attested"` against `"sandbox_enforced"`. It is acceptable only if a team explicitly needs it, so it is not planned now.

## Recommendation

- **Primary:** (a) AppContainer provider `windows-appcontainer-readonly-no-network`.
- **Fallback, available now:** (b) run the CLI inside WSL2 with bwrap.
- Defer (c) and (d).

## Design: provider seam (done in 0.146.17)

`lib/delivery/local-smoke-providers.mjs` holds a frozen provider table. Each entry has `{ id, platform, executable, boundary, args(cwd, argv) }`, and the host (`platform`, `exists`, `env`) is injectable for tests. Its exports:

- `localSmokeExecutionBoundary(host)`: the boundary record. Its output is byte-identical to 0.146.16 on macOS and Linux, so authorizations already in flight stay valid.
- `localSmokeSandboxCommand(cwd, argv, host)`: the wrapper invocation. It fails closed with the options text.
- `assertLocalSmokeProviderAvailableForProposal(host)`: the proposal preflight, called from `proposeDeliveryAutonomy` (`lib/engine/delivery.mjs`) for `local_release`.

To add the Windows provider:

1. Add the entry with `platform: "win32"` and `executable` resolved from `SYSTEMROOT`. Add `probe()`: a fast launcher dry run that creates and deletes a throwaway container. `available` becomes `exists && probe`, and the result is cached per process.
2. Extend the entry contract with an optional `script: { path, sha256 }`. `localSmokeSandboxPolicyAttestation` adds `wrapper_script_sha256` to the launcher subject, and `runApprovedLocalSmokeTests` re-verifies it next to `wrapper_executable_sha256`. The policy schema becomes `local-smoke-sandbox-policy:v3` only when a script is present; v2 records stay valid.
3. Make the boundary values for the new provider honest (see (a)).

## Configuration

No new switch is needed for (a) or (b): the provider is chosen by platform. If (c) ever lands, it gets an explicit per-delivery field sealed by the human approval of the profile, never a project-wide default:

```json
"local_release_target": {
  "smoke_isolation": { "provider": "container", "engine": "docker", "image": "node@sha256:<digest>" }
}
```

## Tests

- **Unit, any host** (`test/unit/local-smoke-providers.test.mjs`, added): simulated `darwin`, `linux` and `win32` hosts; exact bwrap argv; fail-closed text; the test simulation can only remove a provider.
- **E2E, any host** (`test/autonomy-cli.e2e.mjs`, added): with `NODE_ENV=test AGENTIC_SDLC_TEST_LOCAL_SMOKE_PROVIDER=unavailable`, `autonomy delivery propose --kind local_release` fails with the options and writes no profile.
- **Test runner:** `scripts/run-test-suite.mjs` sets `AGENTIC_SDLC_TEST_DEFER_SMOKE_PROVIDER_PREFLIGHT=1`. Local-release fixtures on hosts without a sandbox (Windows CI, Linux without bwrap) keep running and still hit the fail-closed `release.local` authorization. The switch defers the error, it never removes it.
- **For (a):** simulated tests cover argv and subject construction. Real execution runs only on the existing `windows-latest` CI matrix (`.github/workflows/ci.yml`). Cases:
  - a passing smoke run;
  - a failing smoke run that keeps its exit code;
  - a write into the artifact that is denied;
  - an outbound connect that is denied;
  - a loopback listener that is denied;
  - a tampered launcher script that is refused before spawn;
  - Constrained Language Mode that makes the provider unavailable.

  The macOS-only smoke e2e tests become parameterized by provider id.

## Assurance labelling

The completion receipt already embeds `authorized_policy.smoke_execution_policy.boundary.provider`. Also surface `smoke_isolation: <provider id>` and `smoke_isolation_assurance: sandbox_enforced` in the lifecycle-complete report and the delivery check table, so a reader sees which isolation backed `released`. Only (d) would ever use another value.

## Steps

1. Done (0.146.17): provider seam, early proposal failure with options, unit and e2e tests, doc notes.
2. AppContainer launcher script and provider entry, plus the windows-latest e2e cases. Release it only after CI on Windows passes.
3. Certificate and check-table assurance fields.
4. Revisit (c) only on a concrete team request.
