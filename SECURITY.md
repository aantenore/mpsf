# Security policy

MPSF runs hooks inside your coding agent, guards git pushes and merges, and records evidence that people rely on. A flaw in any of these is a security issue.

## Supported versions

Only the latest release receives fixes. Update with `claude plugin marketplace update aantenore && claude plugin update mpsf@aantenore`, or rerun the Codex installer.

## Report a vulnerability

Report it privately through [GitHub private vulnerability reporting](https://github.com/aantenore/mpsf/security/advisories/new) (Security tab, "Report a vulnerability"). Do not open a public issue with details. If the form is not available, open an issue that only asks for a private contact.

Useful in a report: the version (`/mpsf:doctor` prints it), the host (Claude Code or Codex) and operating system, the steps or command that reproduce it, and what an attacker gains.

You get an answer within a week. A confirmed issue is fixed in a patch release and credited in the [changelog](CHANGELOG.md) unless you prefer otherwise.

## In scope

- the PreToolUse guard letting an agent bypass a protected path, a governed push or merge, or the host settings protection;
- forged or altered records accepted as valid (`trace verify`, signatures, approvals, delegations);
- the Change Observatory exposing data beyond 127.0.0.1 or accepting writes other than its chat route;
- the smoke-test sandbox escaping its folder;
- secrets leaking into records, logs or channel messages.
