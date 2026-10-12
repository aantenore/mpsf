# Windows

The CLI, hooks, messaging, claims, waits, delivery through pull requests and the Change Observatory run on Windows with Node.js. `mpsf run --timeout` stops a command and everything it started (`taskkill /T /F`).

A **local release** (`autonomy delivery propose --kind local_release`) runs its smoke test in a read-only sandbox with no network. On Windows 10 1809 or later the plugin uses a per-run AppContainer with no capabilities (`windows-appcontainer-readonly-no-network`), started by Windows PowerShell with a launcher script shipped in the plugin and hash-sealed into the authorization. No admin rights and nothing to install. Compared with macOS and Linux it also denies loopback and lets the smoke process read only the smoke directory, the runtime's folder and the system folders; a temporary read-only permission for the per-run container is added to those folders and removed after the run.

The provider is unavailable when Windows PowerShell cannot run the launcher in FullLanguage mode (AppLocker or WDAC Constrained Language Mode, or an execution policy forced by Group Policy). Then the proposal stops at once, before anything is recorded, and lists the options:

1. allow Windows PowerShell in FullLanguage mode for the launcher;
2. run the whole CLI inside a WSL2 Linux distribution with the project on the Linux filesystem (`bwrap` installed there);
3. deliver through a pull request (`--kind pull_request`), which runs no local smoke test.

There is no setting that turns the sandbox off. Design: [windows-local-release](plans/windows-local-release.md).
