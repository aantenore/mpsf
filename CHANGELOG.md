# Changelog

User-visible changes of the plugin, newest first. Design notes live in [docs/plans](docs/plans); this file says what changed for you and what to do about it.

## 0.155.0

- The plugin is now **mpsf** (My Personal Software Factory): plugin `mpsf@aantenore`, slash commands `/mpsf:...`, package `mpsf`, product name MPSF in the docs, the CLI messages, the Codex plugin and the Change Observatory.
- Switching: the marketplace keeps an `agentic-sdlc` entry that is only a bridge. The usual `claude plugin marketplace update aantenore && claude plugin update agentic-sdlc@aantenore`, then a new session: the bridge installs `mpsf@aantenore` and uninstalls `agentic-sdlc@aantenore`; then `/reload-plugins`. By hand: `claude plugin install mpsf@aantenore && claude plugin uninstall agentic-sdlc@aantenore`.
- Unchanged, so older plugins and existing projects keep working together: `.sdlc/`, `refs/agentic-sdlc/*`, `sdlc-state`, config keys, `~/.config/agentic-sdlc`, `.git/agentic-sdlc`, the skill ids `agentic-sdlc` and `agentic-sdlc-assessment`, the Codex install id, record schemas, the messaging channel, `AGENTIC_SDLC_*` variables (`MPSF_*` are aliases) and the `agentic-sdlc` command (alias of `mpsf`).
- Release workflow and its guard accept both package names.
- Change Observatory: the header and empty states say MPSF.

## 0.154.0

- **Operational records on the `sdlc-state` branch.** `state migrate` pushes delivery action receipts, autonomy executions and gate reports (final receipts `gates/<story>-final.json` excluded) to an orphan branch of the same remote, ignores them in `.sdlc/.gitignore` and stops tracking them; files and history stay. The base branch keeps requirements, contracts, decisions, baseline, config, stories, dependencies, final receipts, traces and workflow checkpoints. Works with any git host.
- New commands `state status|push|pull|sync|migrate`. The host hooks sync in the background (`state sync --if-due` at session start and stop, `state push` at session end). Pushes are throttled (2 minutes), fast-forward only with rebuild and backoff when another computer moved the branch, never delete records, and carry `[skip ci]`. A pull never overwrites a record changed here and not pushed.
- New records adapter `sdlc-state` (options `branch`, `remote`, `push_interval_seconds`, `pull_interval_seconds`); no configuration change is needed, the requirement file added by `state migrate` switches every computer.
- The Change Observatory fetches the state branch and lays its records over the base branch's.
- Needs 0.154.0 on every computer once a project runs `state migrate`; older plugins are told to update. See [Adapters and roles](docs/adapters-and-roles.md#operational-records-on-the-state-branch).

## 0.153.7

- The plugin repository no longer carries its own `.sdlc` folder: the plugin is not used on itself for now. Templates and the code that creates `.sdlc` in projects are unchanged.
- Change Observatory: no change needed.
- Compatibility: nothing changes for older plugins.

## 0.153.6

- No computer sends update requests to the others any more (`[auto] aggiorna il plugin` on the issue or the git channel). Each computer checks its own version against what the project needs (`config/plugin-compatibility.json`, the records' minimum version) and the newest version announced on the channel, and warns its own person in the session, with the update command.
- An outdated computer still appears in `wait list` and `message who` as information only. The `coordinator update-requests` duty and the `request_plugin_updates` coordinator task are gone; `plugin_update_request_every_minutes` in `host_policy.waits` is still accepted and ignored.
- Compatibility: older plugins keep sending update requests until they update; this version reads them as information (never unanswered, no reply, no block).
- Change Observatory: no change needed; it never showed update requests.

## 0.153.5

- `coordinator main-green` (every 30 minutes) and `knowledge distill` (every 60) now start by themselves on the computer holding the role. They run in the dedicated worktree on the base branch and push only the `.sdlc` records they wrote, with `[skip ci]`, never forced. `coordinator digest`, `update-requests` and `merge` stay manual. `AGENTIC_SDLC_ROLE_DUTIES=off` stops every duty on a computer.
- Change Observatory: no change needed.
- Compatibility: older plugins do not run duties; the records they read are the same.

## 0.153.4

- Fix: Known Error Database, machine identity, fresh state, `MPSF_*` env aliases, context budget and auto-pack, knowledge CLI and role duties/guard read the clock, process, files, git and hashing through the runtime host, so the host-seam unit test passes on main again. No behavior change.
- Compatibility: no new configuration keys. Change Observatory unaffected.

## 0.153.3

- Role duties that write records (`coordinator main-green`, `knowledge distill`) run in the dedicated worktree on the base branch, never in the person's checkout, and push what they wrote under `.sdlc` to the base branch with `[skip ci]`, never forced (on top of the base when it moved meanwhile). They stay manual until turned on in `config/role-duties.json` (`auto: true`).
- Change Observatory: no change needed.
- Compatibility: nothing changes for older plugins.

## 0.153.2

- `knowledge distill` reads the records of origin/<base> after one bounded fetch (`lib/engine/fresh-state.mjs`), so the knowledge role works on the shared state, not on this computer's checkout; without a base branch it reads the working tree as before. The JSON result names the `source`.

## 0.153.1

- The computer holding a role runs its duties by itself: the host hook starts each one, detached so no hook waits for it, at most every few minutes (`config/role-duties.json`). Automatic today: `coordinator free-claims` and `settle-waits` (once available) and `coordinator check-records`. `coordinator digest`, `update-requests`, `merge`, `main-green` and `knowledge distill` are listed but stay manual until a person turns them on, because they message other computers, merge into the base branch or write a story into the checkout. `roles status` lists the duties started here; `AGENTIC_SDLC_ROLE_DUTIES=off` stops them on a computer.
- A pinned coordinator (`host_policy.roles.coordinator`) is now enforced: on the other computers its reserved actions (merging a pull request through a delivery, publishing records, resolving waits, ...) are refused with the holder's name while it holds a valid lease, and with `fallback: hold` while nobody does. The lease is read from the remote right before the action. Automatic roles refuse nothing; without a shared remote nothing is refused; `AGENTIC_SDLC_ROLES=off` turns the check off on one computer.
- Change Observatory: no change needed; the "Now" panel already shows who holds each role.
- Compatibility: nothing new is written to the repository or the remote. Older plugins do not enforce a pinned coordinator and do not run duties.

## 0.153.0

- Shared knowledge in `.sdlc/knowledge/`: `knowledge distill` collects recurring traps (known errors, and gate failures seen in at least two stories), fix stories (`story create --fixes`) and channel questions with an answer. Entries with the same key merge (a known error and the same gate failure are one trap). Records and "seen" events carry no author or time of their own, so the same knowledge distilled on two computers is the same file and nothing conflicts. Only the computer holding the knowledge role distils (every computer when nobody holds a lease); `--force` runs it anyway. `knowledge list [--story]`, `knowledge retire --id --reason`.
- The context pack has a `knowledge` section with the entries that name the story (or a story it depends on) or touch its write scope; packs without such entries are unchanged.
- `story claim` and `task start --confirm-start` print the story's context pack inside an agent session (not with `--json`, not in a person's terminal), once per session while it is unchanged. `AGENTIC_SDLC_CONTEXT_PACK=off` turns it off.
- Context budget per worker: `context budget --set <tokens>` (or `AGENTIC_SDLC_CONTEXT_BUDGET`) caps what `context pack` and `context get` print in one agent session on this computer. Local, never published, no cap by default. A pack that does not fit what is left is rebuilt smaller; when the budget is used up, nothing more is printed.
- Change Observatory: "Knowledge" panel, and the context each agent session used in the Now panel.
- Compatibility: older plugins ignore `.sdlc/knowledge`; `host_policy.knowledge` is optional (defaults in `config/knowledge.json`).

## 0.152.1

- Coordinator tasks read the stories from the remote base branch after one bounded fetch (`lib/engine/fresh-state.mjs`), plus local stories not there yet; `coordinator check-records` checks the freshly fetched base.

## 0.152.0

- Coordinator tasks as standalone, idempotent commands with `--dry-run` and `--json`; each does nothing on a computer that does not hold the coordinator role (without roles every computer runs it, as before):
  - `coordinator digest [--force]`: one `[auto] digest:` summary (alive computers, stories in progress, waiting and parked, open P1), only when it changed and at most every 15 minutes, replacing the periodic heartbeat.
  - `coordinator check-records [--ref <git-ref>]`: consistency of the story records on the remote base branch, from git objects only; exit code 1 on errors.
  - `coordinator main-green [--failing <check>]`: one ready P1 fix story `ST-MAIN-GREEN-<commit>` when CI of the base branch is red, never a revert.
  - `coordinator merge [--max <n>] [--method merge|squash|rebase]`: ready pull requests merged one at a time in story priority order; forges are adapters, GitHub through `gh` first (`AGENTIC_SDLC_FORGE` to choose).
- Welcomes to computers joining the channel come only from the coordinator.
- Change Observatory: the latest digest has its own line in the "Now" panel and is never shown as its sender's status.

## 0.151.3

- Claims are renewed by work, not by a fixed date. Each computer's presence ref now carries, for each story it holds, when it was last worked on: branch reflog, worktree index and HEAD log, story records, workflow checkpoint. Every computer counts that like a push, so a claim being worked on never lapses and a forgotten one lapses one time to live after the last work, also when its computer is off.
- New projects get `claim_policy.default_ttl_seconds: 7200` (two hours) instead of 86400; existing projects keep their value.
- When a session ends and no other session of the same clone worked in the last 15 minutes, a detached push (outside the 3-second SessionEnd limit) marks the computer's presence expired and hands back its roles, so another computer takes them at its next tick. Claims are not released.
- Change Observatory: the "Now" panel shows the computers (alive or not, stories, roles, plugin version, last seen) and who holds each role.
- Compatibility: older plugins ignore the new presence field and read only `expires_at` and pushes, which is the conservative view; presences written by 0.149.1 count as activity at their time.

## 0.151.2

- Agent and channel texts that were only in Italian are now in English: hook instructions and notes (keep-going, watch, guard, prepared starts, process hygiene), channel `[auto]` status, free and join/welcome messages, wait suggestions, `next` and `roles status`. `wait add|resolve|list`, `roles status` and the "Waiting on" section of `status` print Italian with `--locale it`.
- The plugin update request keeps the `[auto] aggiorna il plugin` prefix that older plugins match, so they keep throttling it.
- Change Observatory: wait descriptions in the "Now" panel are in English.
- README shows the logo (light and dark); `package.json` has `homepage`, `repository` and `bugs`.
- Compatibility: no new configuration keys; older plugins read the new messages as before.

## 0.151.1

- Fresh state reader (`lib/engine/fresh-state.mjs`): one bounded fetch (5 s, at most once a minute per clone) of the base branch and of the presence and role refs; records read from `origin/<base>` with `git ls-tree`/`git show`, never from the working tree of the checked-out branch; how many commits the checkout is behind the base; a dedicated worktree on the base in `<git-common-dir>/agentic-sdlc/base-worktree` for role writes (moved to the base tip only when clean). A clone far behind main no longer trusts its stale claims once callers move to it.
- `context pack` prints `base: N commits behind origin/main` under its title (`base` in `--json`); the pack and its hash do not change. `AGENTIC_SDLC_FRESH_FETCH=off` skips the fetch.
- Change Observatory: no change needed, it already reads the base branch from git and shows how far the checkout is behind.
- Compatibility: nothing new is written to the repository or the remote; older plugins are unaffected.

## 0.151.0

- Local releases now run on Windows. The `release.local` smoke test runs in a fresh AppContainer with no capabilities (`windows-appcontainer-readonly-no-network`): no network, no loopback, writes only in the container's private storage, reads limited to the smoke directory, the runtime's folder and the system folders. Windows PowerShell starts it with a launcher script shipped in the plugin, whose SHA-256 is sealed into the authorization and checked again before the run. Windows 10 1809 or later, no admin rights.
- Where PowerShell cannot run the launcher in FullLanguage mode (AppLocker, WDAC, execution policy forced by Group Policy) the proposal still stops early with the options (WSL2, pull request).
- macOS and Linux authorizations are unchanged. Compatibility: the first Windows local release in a project records that it needs this version, so older plugins ask for an update instead of rejecting its receipt.

## 0.150.0

- New `git` messaging provider: the channel lives in the project's own remote, one ref per computer (`refs/agentic-sdlc/channel/<machine-id>`), each message a small signed commit. Any git host, no other service or account; each computer pushes only to its own ref, so there are no conflicts. Reads fetch only the channel refs and walk only new commits; a message pushed late is still delivered; each computer compacts its ref to the last 14 days. Hosts that refuse custom refs get branches `agentic-sdlc/channel/<machine-id>` (with `[skip ci]`), detected at the first refused push.
- `message setup` uses `git` for new channels; a project that already has a GitHub channel issue keeps it (TravelOps does), and `--repo`/`--issue` or `--provider github` still choose GitHub. Nothing already configured is rewritten.
- Signed messages on every provider that the plugin writes (git and the GitHub issue), with this computer's Ed25519 key. `message setup` proposes the public key in `.sdlc/machines/<machine-id>.json`: commit and merge it, then the other computers trust that computer. Unregistered keys read as `[unverified: key not registered]`, missing or wrong signatures as `[untrusted]`; a hand-written GitHub comment is trusted when its author is owner, member or collaborator. `message status` shows this computer's key.
- Change Observatory: the "Now" panel marks unverified and untrusted messages.
- Compatibility: older plugins do not know the `git` provider and say messaging needs a newer plugin; they keep using the issue on projects that use it. To join a git channel, update the plugin.

## 0.149.3

- First step of the rename to **mpsf** (My Personal Software Factory). The CLI also answers as `mpsf` (`bin/mpsf.mjs`); `agentic-sdlc` keeps working.
- Every `MPSF_<NAME>` variable is an alias of `AGENTIC_SDLC_<NAME>`; an explicit `AGENTIC_SDLC_*` value wins. The old names are never dropped.
- The guard, the run registry and the automatic update recognize the plugin under both names.
- Compatibility: nothing changes for older plugins; records, refs and config are untouched.

## 0.149.1

- Computers and roles without messages: each computer keeps a presence ref on the project's remote (`refs/agentic-sdlc/presence/<id>`, 30 minutes, renewed every 10 by the host hook), and the `coordinator` and `knowledge` roles go to one alive computer each through create-only lease refs (`refs/agentic-sdlc/roles/<role>/<epoch>`): the pinned host of `host_policy.roles.coordinator` first, else rendezvous hashing among the alive computers. The holder renews after half of the lease and hands over at that renewal when another computer should hold it; a lease of a computer that disappears expires. Alone, a computer holds every role. Without a valid lease, a shared remote, or with `AGENTIC_SDLC_ROLES=off`, every computer does every duty itself, as before. Older plugins ignore these refs.
- `roles status [--offline] [--json]` shows the alive computers and who holds each role.

## 0.149.0

- Known error database in `.sdlc/known-errors/`: a recurring failure with its diagnosis and fix, keyed by a deterministic signature (check or command, exit code, message with ids, hashes, numbers, times and absolute paths masked, project path involved). The same failure gives the same id on every computer and in every story.
- When `gate check` fails, `test record` records a failing run, or a command ends in an error, the CLI prints the known fix right away (`agentic-sdlc: known error KE-...`) and remembers the failure on this computer. A new signature is announced once with the command to record it.
- `known-error add --from-last-failure [--signature <KE-id>] --title --diagnosis --fix-step...` records a fix; agents never write the folder by hand. `known-error outcome --id <KE-id> --result worked|failed` reports how it went: a failed fix makes the entry suspect. `known-error list|show|match|retire`.
- Safe fixes (`--remove-path` of an untracked path, `--gitignore <pattern>`, with `--safe`) run with `known-error apply` only after a person accepts them (`known-error accept --actor-type human`). Every other entry is a suggestion, never an instruction.
- The entry is immutable; uses, acceptance and retirement are append-only event files, so several computers never conflict. Entries unused for 90 days are stale, entries outside their plugin version range are not proposed. `host_policy.known_errors` (optional) tunes it or turns it off; defaults in `config/known-errors.json`.
- Change Observatory: "Known errors" panel with each entry's state, how often its fix worked, and the analyses saved.
- Compatibility: older plugins ignore the new folder.

## 0.148.5

- This computer's id is decided once and kept in `~/.config/agentic-sdlc/machine.json` (`AGENTIC_SDLC_MACHINE_DIR` to move it). It is the same id as before (`pc-` and a short hash of the host name), so claims, stories and messages keep pointing at this computer, but it no longer changes when the host name changes (a laptop on another network). Every clone, worktree, session and subagent on the computer uses it; `AGENTIC_SDLC_HOST_LABEL` still wins.
- Each computer gets an Ed25519 key (`machine-key.pem`, mode 0600) made on first use, for signed coordination messages.

## 0.148.4

- Waits that need a person (pending approvals, expired delegations, expired waits on a person) are shown once to the person working with the computer that waits, in its own session (agent context and Stop hook note), with the exact command. They are no longer sent to the channel as `[auto] serve una persona`. keep-going never blocks on them, and a story whose next step is that command waits for the person.
- Plugin update requests go only to computers seen on the channel in the last 2 hours (`plugin_update_active_minutes` in the plugin's `config/waits.json`): a computer that is off is no longer asked every hour.
- A `request` written by the plugin itself (`[auto]`: update request, reminder) no longer counts as an unanswered question; reminders are sent as `info`.
- Phase changes, commits, pushes, pull requests, test results and strict gates are no longer sent to the channel; the records and the Change Observatory show them. `AGENTIC_SDLC_MESSAGING_TECHNICAL_EVENTS=on` sends them again.
- Automatic alerts are deduplicated by state (what happened, story, state) instead of by text; a failed gate with the same blocker, numbers and paths aside, is sent once an hour.
- An unanswered question of this computer now suggests deciding only on its own work, never assigning work to other computers.

## 0.148.3

- One order for story work everywhere: P1 > P2 > P3 > no priority, then the oldest story. `next`, the end-of-turn hook, the stories unblocked in offers, `orchestrate plan`, `status` and `story park` propose the most urgent story first.
- A fix story opened with `--incident` inherits its priority from the incident severity (sev1 P1, sev2 P2, sev3/sev4 P3) unless `--priority` is given.
- Change Observatory: the priority is shown on the story and stories can be sorted by priority.
- A broken main is never reverted: the agent opens a P1 fix story for it.

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
