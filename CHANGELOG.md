# Changelog

User-visible changes of the plugin, newest first. Design notes live in [docs/plans](docs/plans); this file says what changed for you and what to do about it.

## 0.148.2

- Presence on the channel: `[auto] stato` goes out only when the set of claimed stories or their phase changes, instead of every 15 minutes. A story that stays in the same phase gets one notice after 4 hours (`AGENTIC_SDLC_MESSAGING_STALL_HOURS`, 0 turns it off). Setting `AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES` explicitly brings back the periodic status.
- A claim released or replaced on another computer (its release or a later epoch is in the shared claim refs of this clone) no longer counts as active here: presence, join/welcome and keep-going stop reporting a story from an outdated checkout or worktree.
- Presence covers every worktree of the clone; the record in the story's own worktree wins over an older copy elsewhere.

## 0.148.1

- `task start` with an invalid delivery profile no longer aborts while reading the profile for the drift check: the decision is returned blocked with `autonomy_profile_invalid`.
- `requirement propose` with an unknown `--autonomy-ceiling` now ends in a user error that lists the allowed values.
- The Codex installer recognizes a plugin installed under the previous package name (`agentic-sdlc-codex-plugin`) and updates it; candidates still have to use the current name.
- The `integration-review` workflow template now carries `host_policy` in its configuration.
- Docs: plugin hooks work in Codex too; it reads the same `hooks/hooks.json` and exports `CLAUDE_PLUGIN_ROOT` to each hook command ([Hooks](docs/claude-code-install.md#hooks)).
- Tests: a release trace without evidence is refused when it is appended; the merged-records test accepts the story title in the status line; several tests no longer depend on the local hooks, the installed output filter or the single-flight lock.

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
- Records publication makes up to 4 attempts, so up to 3 retries after waits of 1s, 2s and 4s, each on a fresh base tip; the failure reason is the remote's own line. `AGENTIC_SDLC_PUBLISH_BACKOFF_MS` sets the first delay in milliseconds (default 1000, doubled each time).
- Three more actions can be delegated by a person with `autonomy delegation grant --actions`: `delivery.approve`, `baseline.approve`, `story.supersede`.
