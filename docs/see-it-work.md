# See it catch problems in one minute

Two checks from the README, run by hand in a throwaway folder, with the output they really print. No agent session is needed: these are the same CLI commands the agent runs for you.

You need the `mpsf` alias from [Run the CLI from your terminal](hosts/claude-code.md#run-the-cli-from-your-terminal) (or `node <plugin folder>/bin/mpsf.mjs`), Git with a user name and email set, and a POSIX shell (on Windows, Git Bash or WSL).

## 1. Someone edits the project history

Every recorded event is hash-linked to the previous one and to a checkpoint. Change one word in the history file and `trace verify` names the file and what broke.

```bash
mkdir mpsf-demo && cd mpsf-demo && git init
mpsf init
mpsf trace append --type decision --summary "Reject trips above the cost limit" --actor-type human
git add -A && git commit -m "Start"

mpsf trace verify
perl -pi -e 's/Reject trips/Accept all trips/' .sdlc/traces/project.jsonl
mpsf trace verify
```

The first check passes. The second prints:

```text
The project history changed unexpectedly.
next: Do not edit history files by hand. If the change was not intended, first back up the history files (events recorded since your last commit would be lost), then restore .sdlc/traces from version control (for example: git checkout -- .sdlc/traces) and run mpsf trace verify again.
decide: Decide whether the change was intended; do not approve work that relies on this history until it is resolved.
- Files checked: 1
- .sdlc/traces/project.jsonl: CHANGED (checkpoint_drift, trace_truncated, event_deleted_or_missing, last_event_hash_mismatch, rolling_hash_mismatch); 1 event, 0.0 MiB
```

It exits with status 1, so a script or CI job stops too. Put the file back and the check passes again:

```bash
git checkout -- .sdlc/traces
mpsf trace verify
```

This is tamper-evident, not tamper-proof: someone who can rewrite both the history and every copy of it (your clone, the remote, other computers) can still hide an edit. The point is that a quiet edit is no longer quiet.

## 2. A credential lands in a commit

Before a delivery is closed, the files it changed are scanned for credentials. Matches are recorded as story evidence and shown redacted.

```bash
mpsf story create --id ST-001 --title "Trip policy"
git add -A && git commit -m "Story"

mkdir -p src
printf 'export const apiKey = "AKIA%s";\n' Z7Q4M2X9P1L6K3J8 > src/config.mjs
git add src && git commit -m "Add config"

mpsf secret scan --story ST-001 --base HEAD~1
```

```text
The requested check found a problem.
next: Review the optional diagnosis, correct the problem, and run the check again.
- Found 2 credential match(es) in 1 scanned file(s) of story ST-001
- Path: .sdlc/security/ST-001-secret-scan-<timestamp>.json
- Source: git_range (head <commit>, base <commit>)
- src/config.mjs:1 assigned_credential_literal apiK…
- src/config.mjs:1 aws_access_key_id AKIA…
- Remove each credential from the file, rotate it at its provider, then run secret scan again.
```

The key is fake. The recorded result never stores it in clear text and the command exits with status 1. With the default settings (`gate_policy.secret_scan.enabled: true`) the validation and lifecycle-complete gates accept only a clean scan of the current head, so the delivery cannot be certified until the credential is gone.

## What you did not see

In a real session the agent runs these checks itself, alongside the ones that need an agreed requirement and work brief: changed files outside the agreed paths, actions outside the approved set, budgets, and tests recorded with their exact command and exit status. [Getting started](getting-started.md) walks through one full delivery; the [Change Observatory](change-observatory.md) shows the result.

Delete the `mpsf-demo` folder when you are done.
