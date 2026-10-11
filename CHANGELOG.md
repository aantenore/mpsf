# Changelog

User-visible changes of the plugin, newest first. Design notes live in [docs/plans](docs/plans); this file says what changed for you and what to do about it.

## 0.148.0

- **Context packs.** `context pack --story <id>` prints a small, deterministic summary of one story for the phase you are in (accepted criteria, the contract essentials, decisions, dependencies, write scope with a file index, recent tests and gates, waits, next step). `context get <ref>` reads the detail of any section or record the pack points to. Secrets are redacted. See [Token efficiency](docs/token-efficiency.md#context-packs-and-compact-output).
- **Short output for agents.** Inside an agent session commands print outcome, next step, ids and the exact error instead of the long explanation. `--verbose` brings the full text back, `--compact` forces the short form, `AGENTIC_SDLC_OUTPUT=auto|compact|full` sets it for the computer.
- **Agent JSON profile.** `--json` inside an agent session returns the essentials with `rec:` references; `--json-profile full` or `AGENTIC_SDLC_JSON_PROFILE=full` returns the complete payload (scripts should ask for it).
- **Hook budgets.** Host hooks no longer repeat the same text on every tool call: per-session deduplication, a line cap and a token budget per event, all in `host_policy.context.hooks`.
- Needs 0.148.0 on every computer once a project sets `host_policy.context`; older plugins are told to update.

## 0.147.0

- **Messaging is optional and pluggable.** Providers: `github` (default), `local` (a channel file in a folder) and `none` (off). Claims, waits, delegations and records publication never depend on messaging. See [Messages between computers](docs/messaging.md) and [Adapters and roles](docs/adapters-and-roles.md).
- **Record stores.** `git-sdlc` (default: the `.sdlc` folder in git with shared refs) and `local-fs` (plain files, no git). Every store declares what it guarantees; a gate refuses a certification level the store cannot back.
- **New configuration.** `host_policy.adapters.messaging` / `.records` (credentials only by reference) and `host_policy.roles.coordinator` (hosts, lease, fallback, reserved actions). Role resolution exists; enforcement is planned.
- Fixed: a refused announcement in `story prepare` no longer ends in an unhandled rejection.

## 0.146.17

- `autonomy delivery propose --kind local_release` stops before recording anything when the computer has no read-only, no-network smoke sandbox, and lists the options (macOS, Linux with bubblewrap, the CLI inside WSL2, or a pull request). The release itself is still refused without a sandbox, as before. See [Windows status](docs/portable-install.md#windows).
- The agentic-sdlc skill is split: the front door stays short and the workflow steps moved, unchanged, into `skills/agentic-sdlc/references/` (about 31k tokens down to about 7k loaded each time).

## 0.146.16

- A failing gate check on a story that is already over (merged, closed, released, abandoned or superseded) no longer sends the automatic "need help" question to the other computers; it prints a local line only. Active stories still send it.

## 0.146.15

- `agentic-sdlc guard trust-remote --root <repo> --url <url> --actor-type human --approval-source explicit-user`: a person records once per repository the remote the merge and push guard reads the base branch from (stored in `~/.config/agentic-sdlc/trusted-remotes.json`). The guard ignores the repository's own git configuration for this and refuses the command and any agent write to that file.

## 0.146.14

- The base-branch exemption (`host_policy.guard.protect_base_branch: false`) is read only from the base branch as the remote reports it. Local branches are no longer trusted. With no origin, an unreachable remote or a failed check the guard stays on.

## 0.146.13

- The merge and push guard on the base branch applies to every repository that has `.sdlc/project.json` in the working tree, the index or the committed base branch; deleting the file locally does not lift it. Agent edits to `host_policy.guard` are denied.
- Here-document bodies are treated as data, not as commands, by the guard.
- Records publication retries up to 4 times (1s, 2s, 4s) on a fresh base tip; the failure reason is the remote's own line. `AGENTIC_SDLC_PUBLISH_BACKOFF_MS` sets the first delay in milliseconds (default 1000, doubled each time).
- Three more actions can be delegated by a person with `autonomy delegation grant --actions`: `delivery.approve`, `baseline.approve`, `story.supersede`.
