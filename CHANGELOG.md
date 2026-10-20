# Changelog

User-visible changes of the plugin, newest first. Design notes live in [docs/plans](docs/plans); this file says what changed for you and what to do about it.

## 1.0.0

- First stable release. No behaviour change from 0.164.7: the version moves to 1.0.0 to mark the plugin as stable. Since the last release (0.164.3): a shorter README that says what MPSF (My Personal Software Factory) is for and how to try it, Change Observatory screenshots, the complete overview in [docs/reference.md](docs/reference.md), and the new logo set in `assets/brand/` that also replaces the plugin images. The guides no longer name plugin versions in titles and examples, so they stay valid without manual edits; version numbers remain only where a minimum version matters. Upgrading needs nothing: older computers compare versions numerically, so 1.0.0 is simply newer than 0.164.x. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.7

- Maintenance: removed `scripts/generate-plugin-assets.mjs`, which drew the old Agentic SDLC artwork and was not used by any command or CI job. The plugin images come from `assets/brand/`. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.6

- Brand: the plugin images (`assets/logo.png`, `assets/logo-dark.png`, `assets/icon.png` and the skill icons) now show the MPSF mark instead of the old Agentic SDLC artwork. File names are unchanged. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.5

- Docs: a shorter README that says what MPSF is for, how it differs and how to try it, with Change Observatory screenshots made from sample data (`docs/images/`). The complete overview that used to fill the README is now [docs/reference.md](docs/reference.md); the guides link there. Example project names in the metering guides are now generic. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.4

- Brand: new logo set in `assets/brand/` (`logo.svg`, `logo-dark.svg`, `icon.svg`, `icon-512.png`). The mark is an M whose two strokes meet in a single node: separate lines of work joined into one signed record. SVGs have no external fonts. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.3

- Release: ships the 0.164.2 changes with a fully tested CI run (all gate cells, Windows included). No behaviour change. Change Observatory: no change. Compatibility: no record, ref or config key changed.

## 0.164.2

- Discussions: inside an agent session, `message discuss --decide` records only the agreed proposal of an agreed discussion, unchanged. An open, contested or escalated discussion is decided by a person in their own terminal; the agent is refused, and the check fails closed when the channel cannot be read. This closes the gap where an agent could skip an open objection by deciding on its own. Change Observatory: no change (the Chat cannot send a decision). Compatibility: no record, ref or config key changed.

## 0.164.1

- Discussions: the outcome at the time box or turn limit is final; a late objection or extra turns no longer turn an agreed discussion into an escalated one. A `decide` is outside the turn, time and participant limits, so a person can decide from any registered computer, also one that is not among the three participants. Change Observatory: the Now panel's discussions (topic, proposal, decision, command) now get the same redaction as messages. Compatibility: no record, ref or config key changed; older plugins may still count late turns.

## 0.164.0

- Change Observatory: the Chat block can write. Type in a room to post there (a story room sets the story), use Reply on any message (inside a discussion the reply joins the discussion), and Agree or Object on discussion messages. The local Observatory server sends the message as this computer, signed and queued like `message send`; the draft survives the panel refresh. Security: `/api/v1/chat/send` is the only route that accepts a write (`POST`, bearer token, `application/json`, at most 8 KB, same `Origin` when one is sent, single-project mode); every other route still answers `405` to anything but `GET` and `HEAD`. Change Observatory: Chat block gains the composer and the reply/agree/object buttons. Compatibility: no record, ref or config key changed; messages look the same as those sent from the CLI.

## 0.163.0

- Change Observatory: a Chat block under the Now panel shows the project channel as chat rooms, one per story plus General for messages about no story; a reply sits in the room of the message it answers. Each message shows sender, kind, signature warning, addressee, time, the message it answers and, for discussions, the proposed or decided action instead of the raw action line. Automatic `[auto]` messages are hidden unless "Show automatic messages" is ticked. Read-only; the "Latest from each computer" rows also drop the raw action line. Change Observatory: new Chat block; the `/now` model gains `chat` (rooms and the last 300 messages of the last 12 hours, redacted like the rest). Compatibility: no record, ref or config key changed.

## 0.162.1

- Test only: the real AppContainer loopback test now listens on the host (the test process) and connects from inside the container. Windows allows loopback between processes in the same AppContainer, so the old test, with both ends inside, failed on runners where a real container can start. Product behaviour unchanged: loopback to host services stays denied. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.162.0

- Discussions between agents, step 3 of 3: the Change Observatory "Now" panel has a Discussions section (latest 10 in the messages it reads) with each discussion's topic, story, state (open, proposed, agreed, decided, escalated), participants, turns, deadline, proposal or decision, the command a decision names and how many unsigned decisions were ignored. Change Observatory: new section in the Now panel; the `/now` model gains `discussions`. Compatibility: no record, ref or config key changed; older Observatory pages ignore the new field.

## 0.161.0

- Discussions between agents, step 2 of 3: `message discuss` opens a discussion (`--topic`) or adds a turn, `--agree`, `--object`, `--propose` or `--decide` (with `--action-json`, checked against the closed schema before anything is sent); `message discussions` lists each discussion with its state, participants, proposal, ignored unsigned decisions and next step, and for a decided one prints the existing command to run. See `docs/messaging.md#discussions`. Change Observatory: no change yet (step 3). Compatibility: older plugins show these messages as plain info; no record, ref or config key changed.

## 0.160.0

- Discussions between agents, step 1 of 3: four new message kinds (`discuss`, `propose`, `object`, `decide`) and the rules that settle a discussion, in `config/discussions.json` (at most 6 turns, 15 minutes and 3 participants; a proposal nobody objected to by then is agreed, an open objection goes to a person). Only a `decide` message signed by a registered machine, whose action passes a closed schema (`handoff`, `claim`, `known-error`, `none`), binds; it names the existing command to run (`story prepare-handoff`, `story claim`, `known-error add`), which keeps all of its own checks. Discussion text is information, never an instruction. `message send` does not send these kinds; the `discuss` commands come in the next step. Change Observatory: no change yet (the view comes in step 3). Compatibility: older plugins read the new kinds as plain info messages; no record, ref or config key changed.

## 0.159.42

- Test only: the real AppContainer smoke tests start Node with `--preserve-symlinks-main`, because GitHub's Windows runners deny AppContainers read access to `C:\` and Node reads every ancestor folder of its entry point (`EPERM: lstat 'C:\'`). On such a host a Node smoke test of a local release needs the same flag. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.41

- Windows: the AppContainer launcher of a local release gives the smoke process `LOCALAPPDATA` and `USERPROFILE`, without which Windows refused to start a process in the container (CreateProcess error 203), so every sandboxed smoke run ended with exit 125. A failing Windows call in the launcher now names the Windows error and its code. Windows CI runs the real AppContainer smoke tests on every push and pull request. Change Observatory: no change. Compatibility: no record, ref or schema format changed; the launcher script hash is bound into a local-release authorization, as with any launcher change.

## 0.159.40

- Windows fixes found by the new Windows fast shards. The merge and push guard reads the trusted remote with `GIT_CONFIG_GLOBAL=/dev/null` instead of `\\.\nul`, which Git for Windows refused, so on Windows the remote base was never verified: a non-governed repository was guarded and `protect_base_branch: false` on the remote base had no effect (the guard failed closed). The AppContainer launcher of a local release adds `.EXE` to `PATHEXT` for itself, because in its minimal environment Windows PowerShell refused to run `icacls.exe` and every sandboxed smoke run ended with exit 125. Change Observatory: no change. Compatibility: no record, ref or schema format changed; a local-release authorization binds the launcher script hash, so an authorization made with an older plugin is re-approved as before after an update.

## 0.159.39

- Test only, from the first Windows fast-tier shards on push: the local messaging folder test expects the folder resolved against the project root (on Windows the temporary folder can sit on another drive than the working directory), and the base-branch guard test trusts the origin URL exactly as git recorded it. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.38

- Test only: the concurrent workflow-start and task-start test now also fixes which start takes the story's single-flight lock. Both starts share that lock, so whichever takes it first runs to the end; under load the workflow start could take it first, leaving the task start queued and the workflow start waiting for a boundary the task start never reached. The workflow start now begins only once the task start holds the single-flight lock or has written its receipt, and the concurrent helper allows 60 seconds like the lock wait. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.37

- CI only: pushes and pull requests run the fast tier on Windows (Node 24) again, as three parallel shards `fast shard (windows-latest, 24, <i>/3)` with the same 6-minute job bound, so the Windows fixes of 0.159.35 are checked on every change. These jobs are not part of the release gate, which still requires the five Linux and macOS cells. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.36

- Test only: the concurrent workflow-start and task-start test no longer depends on a fixed 750 ms head start. The delayed workflow start now waits until the task start holds the story's task-start boundary lock or has written its receipt, so a slow process start under load cannot flip which side wins. The product already serializes both starts on that lock. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.35

- Windows fixes from the first Windows fast-tier run. Paths are compared through one helper that resolves Windows 8.3 short names (`C:\Users\RUNNER~1`) and case: the base worktree is no longer recreated on every call (which discarded a write in progress), records publish from a project whose root is spelled with a short name, a project in a subfolder publishes from the right base-worktree subfolder (asked of `git rev-parse --show-prefix`), and `AGENTIC_SDLC_UNGOVERNED_REPOS` and trusted remotes match the repository git reports. Trusted remotes recorded by earlier releases are still read. The run watchdog no longer holds the project folder as its working directory, and on Windows, where stopping a process runs none of its handlers, it removes the run record itself. Test-only fixes for Windows: POSIX file modes are not asserted, shell commands quote Windows paths, spawned module scripts import `file:` URLs, and the real AppContainer smoke tests skip when the provider probe fails on the host. The test runner accepts a tier together with `AGENTIC_SDLC_TEST_SHARD` and runs one slice of the tier (whole files split by cost, smoke files by selected tests). Windows stays in the nightly full suite and outside the release gate. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.34

- CI only: the fast push and pull request runs keep every cell within about five minutes (job timeout 6 minutes). Windows needs longer for the fast tier and now runs only in the nightly full suite, so the release gate requires five cells: `test (ubuntu-latest, 18.20.3|20.12.0|21.6.0|24)` and `test (macos-latest, 24)`. The test tier no longer reports every smoke test as missing on Node 18, 20 and 21, which name ES module test files by `file:` URL. The process-hygiene hook test no longer stops unrelated test processes. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.33

- CI only: pushes and pull requests run `npm run test:fast` (plus the source check, runner canary, doctor and pack dry-run) once per cell, bounded by an 8-minute job timeout, and a newer push cancels the older run. The full suite (every Node line on Linux, macOS and Windows, with the enterprise benchmark) runs only on the nightly schedule and on manual dispatch and no longer blocks releases. The release gate now accepts a green fast `push` run on `main` for the tagged commit, with the same six cells (`test (ubuntu-latest, 18.20.3|20.12.0|21.6.0|24)`, `test (macos-latest, 24)`, `test (windows-latest, 24)`). The test runner still refuses a tier under CI unless `AGENTIC_SDLC_TEST_TIER_IN_CI=true` is also set; `npm test` is unchanged. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.32

- Documentation only: host-specific pages moved to `docs/hosts/` (`README.md` with what Claude Code and Codex share and what differs, `claude-code.md`, `codex.md`, `codex-session-metering.md`); Windows support moved to `docs/windows.md`. The old paths (`docs/claude-code-install.md`, `docs/portable-install.md`, `docs/codex-session-metering.md`) stay as short pages pointing to the new ones. Every section that covered only Codex now gives the Claude Code counterpart, or says there is none: metering (CodeBurn or `budget usage record` on Claude Code), RTK autoconfiguration (Codex only), install, update, uninstall and doctor, the CLI path (`~/.claude/plugins/cache/aantenore/mpsf/<version>/bin/mpsf.mjs`). The README keeps one install/update/uninstall/doctor table and the last ten releases; the docs index is grouped by host, concepts, several computers and reference. A root `CLAUDE.md` imports `AGENTS.md` for contributors using Claude Code. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.31

- Test suite only: the slowest end-to-end files build their expensive, path-independent fixtures once and copy them per test, and one duplicated certification fixture is merged into the scenario that already builds it. Every behavior is still asserted; the touched files run about 290 seconds faster in total. Change Observatory: no change. Compatibility: no change.

## 0.159.30

- Documentation only: README, docs, skill references and templates no longer read as Codex-only. Generic "Codex" wording now says the agent (Codex or Claude Code), and the README install, update, uninstall and diagnose sections give the Claude Code commands too. Stale statements fixed: claim time to live is two hours by default (not 24), only `auto` coordinator duties run by themselves, `main-green` and `merge` work on GitHub, GitLab and Gitea/Forgejo, `git` is a valid `.sdlc/messaging.json` provider and the default for new channels, the messaging waits no longer include plugin update requests, the `sdlc-state` store and the `knowledge`, `known-errors`, `machines` and `compatibility` folders are described, the new-messages stderr prefix is `mpsf:`, and the adapters plan status matches what shipped. The README release section describes `npm run sync-version` for patch releases. Change Observatory: no change (its docs say `codex-generated` covers text from any agent). Compatibility: no record, ref or schema format changed.

## 0.159.29

- Documentation only: the guard's script-file and host-settings checks, agent-session actor inference, the new secret scan rules and `unscanned_paths`, the `pc-<hash>-<random>` computer id and key protection in `message setup`, `AGENTIC_SDLC_ROLES_TICK_TIMEOUT_SECONDS`, the trusted-remote 6 s budget and the shared keep-going cap are now described in the install, messaging, how-it-works, skill and command docs; version mentions say 0.159.29. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.28

- Guard: the host settings files (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`, `.codex/config.toml`) can no longer be used by the agent to set the variables the hooks and CLI read (`AGENTIC_SDLC_*`, `MPSF_*`, the session markers) or to turn the hooks or plugins off: a file-tool edit that changes their `env`, `hooks`, `enabledPlugins`, `disableAllHooks` or `shell_environment_policy` entries is refused, and so is any shell write to them. Other edits, such as permission rules, stay allowed. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.27

- Computers that start using the plugin get a unique id (`pc-<hash>-<random>`), so two machines with the same default host name no longer share presence, channel and key; ids already stored are kept. `message setup` refuses to replace another computer's registered key and says how to resolve it.
- The roles tick allows 20 s for its fetch and push (`AGENTIC_SDLC_ROLES_TICK_TIMEOUT_SECONDS`, 1-300), and `coordinator free-claims` waits 15 minutes after a computer's presence ends before freeing its claims (`holder_presence_late`).
- Known-error and knowledge text from other computers is schema-checked on read and shown quoted as data; only real `mpsf` commands are shown as commands. Distilled knowledge records are byte-identical on every computer; what each computer saw goes into a separate event.
- Change Observatory: knowledge entries show the richest description recorded for them. Compatibility: older plugins read the new ids, records and events, and show a knowledge entry's short key-derived title until they update.

## 0.159.26

- Hooks no longer loop or reach too far: two sessions on the same clone share the keep-going block cap, so they stop blocking each other; the Stop hook starts prepared stories in the background instead of running them inline; the trusted-remote base check fits a 6 s budget and keeps the push to the base blocked when it runs out of time; the stale-run cleanup only stops plugin commands of the current repository.
- With auto-update on, the active folder also gets the new `package.json` and plugin manifests, and self-forward runs only a version the host lists as installed (when that list is readable).
- Change Observatory: no change. Compatibility: the keep-going state gains an optional `blockedAt` field that older versions ignore; no record or ref format changes.

## 0.159.25

- Secret scan reads UTF-16 files (for example a `.env` saved by Windows tools) and catches unquoted `KEY=value` / `password: value` credentials and well-known token prefixes (Stripe live, Google API, GitHub, GitLab, npm, Anthropic, OpenAI). Binary or oversized files it cannot read are listed by `secret scan` (`unscanned_paths`) and warned about by the validation gate instead of counting as clean. The new rules change the rule set hash, so the next delivery check scans again.
- `context get rec:` refuses `.sdlc` symlinks that lead outside the project, and the hook dedupe no longer hides a new wait on a different story (lines with a record id may show once more per session after the update).
- Change Observatory: no change needed (it reads the same secret scan records). Compatibility: secret scan records keep the `secret-scan:v1` format; older plugins read them as before.

## 0.159.24

- Guard: a script file that a shell command runs (`bash x.sh`, `sh < x.sh`, `source`/`.`, `./x.sh`, `cat x.sh | bash`, `node x.mjs`, `python3 x.py`, nested in `bash -c` or `eval`) is read and checked as if its lines were typed in the command, when it is not tracked by git or has uncommitted changes. Shell scripts get every guard rule; other scripts are refused when they change the session markers, run a person-only mpsf subcommand, write the protected records or refs, or push or merge. A script created and run in the same command is refused (write it in one call, run it in the next); tracked, unchanged scripts are not read. Actor inference: inside an agent session (`CLAUDECODE`, `CODEX_THREAD_ID`) a record without `--actor-type` is attributed to the agent even when `--actor` names a person; an explicit `--actor-type` is unchanged. Change Observatory: no change. Compatibility: no record, ref or schema format changed; older plugins keep their own guard.

## 0.159.23

- `references/commands.md` now documents the roles, coordinator, known-error, knowledge and context budget commands. Messaging texts say `mpsf` and describe every provider correctly. The `free-claims` and `settle-waits` duties are marked as available from 0.156.1, and the config schema describes `delegation_policy`. Change Observatory: usage metrics, SLO and the support bundle label the now, claims, dependencies, remote-stories and source-ref requests instead of `unknown`; live updates no longer start git processes per remote story every 8 seconds while the base branch has not moved; the docs list the Known errors and Knowledge views. Compatibility: no record or ref format changes; the schema only gains an optional section.

## 0.159.22

- Internal cleanup: about 30 exported helpers, constants and aliases that nothing in the plugin, its tests or its docs referenced were removed. No change to CLI behavior or stored records. Change Observatory: no change. Compatibility: no record, ref or schema format changed.

## 0.159.21

- GitHub channel: a signed message copied into a new comment no longer reads as trusted. A signed comment counts only when its author is the repository's owner, a member or a collaborator, and only the first time in a read: a second comment carrying the same signed message is `[untrusted]`, so it cannot reopen answered questions or announce a version. Change Observatory: no change (it shows the trust it receives). Compatibility: message format unchanged; older plugins keep reading new messages as before. A teammate whose GitHub account is not a collaborator now sees their signed messages as untrusted on other computers: add them as collaborators.

## 0.159.20

- The release package check passes again: the manifest sync script is now `npm run sync-version` instead of an npm `version` lifecycle hook, which the package policy forbids. `npm run release` still syncs every manifest; after a manual `npm version`, run `npm run sync-version`. The GitHub Action example test follows the documented minimum, v0.21.0. Change Observatory: no change. Compatibility: no change for older plugins.

## 0.159.19

- Fast status no longer leaks into decisions: `gate check` (including `--lifecycle-complete`), workflow transition readiness, `story complete-step` and `autonomy delivery action` verify in full every final receipt they depend on, including other stories'. A stale certification (files changed after it), a voided one (a later trace line or a changed record), or a superseded one no longer unblocks or certifies dependent work. Read-only views (`status`, `orchestrate status|plan`, `story deps`, `dependency status`, `story overlap`) stay fast, but a story counted from a sealed receipt they did not verify again now carries `lifecycle_verification: "not_rechecked"`, and `status` adds `certifications_not_rechecked` with the count; `AGENTIC_SDLC_STATUS_CHECKS=full` still verifies everything. Change Observatory: a certification read from the records only is shown as "Certified, not re-checked" (its model carries `verification: "not_rechecked"`); models from older servers keep the plain "Certified" label. Compatibility: records from older plugin versions are read unchanged; a gate on a story with many certified dependencies takes longer, since each dependency receipt is verified once per check.

## 0.159.18

- The test suite runs faster: redundant scenarios were merged or removed while the behaviors they checked stay asserted, and the fast tier's smoke selections follow the merged tests. No change to the plugin itself. Change Observatory: no change. Compatibility: no change.

## 0.159.17

- Guard: un-exporting the session markers (`export -n`, `declare +x`), running mpsf with an emptied environment (`env -i`, `env -`, `exec -c`, `sudo`), and person-only subcommands hidden in a variable, substitution or xargs are refused. Merges and base-branch pushes through git or gh aliases (inline or configured), refspecs in variables, `push --all`, xargs, inline scripts, GraphQL merge or ref mutations and REST or curl writes to merge and ref endpoints are refused unless an authorization covers them; a target the guard cannot read is never covered, so write it out literally. Not closable by pattern matching: a script file the agent writes and then runs. Change Observatory: no change. Compatibility: nothing changes for older plugins.

## 0.159.16

- Channel messages injected into the agent's context now carry the same `[untrusted]` / `[unverified: key not registered]` marks as `message read`; an `[untrusted]` question or request is listed only among the other messages, never among those the agent must answer before continuing; and a newer version announced by an untrusted or unverified message no longer starts the opt-in auto-update. Change Observatory: no change. Compatibility: older plugins on other computers are unaffected; unsigned messages of the local provider behave as before.

## 0.159.15

- `config migrate --apply` inside an agent session is refused when the edits since the last confirmation touch a part of the rules only a person confirms (listed in `config/config-human-only.json`: authority, gate, host, approval, autonomy, standing approval, delegation, release evidence, verification and phase lock policies), when those edits cannot be listed, or when it changes the autonomy mode; the user runs the same command in their own terminal. Plugin migrations and other edits still apply from the agent. Change Observatory: no change. Compatibility: older plugins on other computers are unaffected.

## 0.159.14

- Documentation: the how-it-works guide names the current version in its examples. Change Observatory: no change. Compatibility: nothing changes for older plugins.

## 0.159.13

- Process reaper: the shared `.sdlc/config.json` can no longer turn on reaping at Stop or widen what the Stop hook selects (`reap_on_stop`, `include_patterns`, `use_default_patterns`, `scope_paths`, a shorter limit are ignored there; `exclude_patterns` and a longer limit still apply), so a committed config cannot stop other users' processes on every computer that pulls it. Turn it on per machine with `AGENTIC_SDLC_REAP_ON_STOP=1` or `reap_on_stop: true` in `.git/agentic-sdlc/process-reaper.json`, which accepts every key. `mpsf processes reap` run by hand is unchanged. Change Observatory: no change. Compatibility: projects that relied on `reap_on_stop: true` in the shared config now get the warning instead.

## 0.159.12

- Documentation and skill fixes: the skill now points to `story cancel` for an approved story that will not be delivered, and pushes a rewritten story branch only under an approved `git.push` action (the hook denies it otherwise); an abandoned claim is described as freed by the coordinator; a newer plugin announced by another computer no longer reads as "update first". Install docs: `cd mpsf` after cloning, `/path/to/mpsf` placeholders, update with `claude plugin update` (not `/plugin install`). The `git` messaging provider is in the providers table, the coordinator duties match the code, and Change Observatory is described as never editing records rather than read-only (with `sdlc-state` it brings in records published by other computers). Change Observatory: wording of one CLI line only. Compatibility: nothing changes for older plugins.

## 0.159.11

- Security: `known-error apply` no longer follows symlinks (a `remove_path` through a link is refused, so nothing outside the project is removed) and treats a path Git cannot classify as tracked. An `accepted` event now counts only when a person or CI wrote it, it names exactly the record's fix actions (and its record hash, stored by new acceptances), and the record's own hash holds; `known-error accept` refuses inside an agent session. Change Observatory: the known-error view shows "accepted safe fix" only for acceptances that hold. Compatibility: acceptances written by older plugins with `known-error accept` still count; hand-written or agent ones no longer do.

## 0.159.10

- Guard: delivery action receipts (`.sdlc/autonomy/actions/`) and story claims (`.sdlc/stories/<id>/claim.json`), which authorize `gh pr merge` and `git push`, can no longer be written by the agent with file tools or the shell; deleting `.sdlc`, `.sdlc/autonomy`, the stories folder or one story is refused under any path prefix and through a glob. Change Observatory: no change. Compatibility: nothing changes for older plugins; these files are written only by the CLI.

## 0.159.9

- Security: a message signed by an unregistered key can no longer read as `trusted` by being re-sent with a registered key fingerprint (the signature cache now checks the claimed key on every read), and a forged copy read first can no longer make the genuine message `untrusted`. Change Observatory: no change. Compatibility: signatures are unchanged; older plugins read new messages as before.

## 0.159.8

- Documentation and CLI help reviewed against the code: README, `docs/`, skills, slash commands and templates corrected where they had drifted (guard scope, messaging providers and strings, keep-going order, watch events, observatory sources, record store guarantees, JSON agent profile, publication retries, delegations, test triage). CLI help: corrected option values and defaults, missing options added, and accurate impact text for actions that publish to the git remote or the channel. Change Observatory: no change. Compatibility: nothing changes for older plugins.

## 0.159.7

- Test-only change: the end-to-end tests for historical, stale, invalid and unborn-history certifications now ask for the full re-verification (`AGENTIC_SDLC_STATUS_CHECKS=full`), because the default fast status trusts a sealed final receipt whose hash holds; and the final-gate race test waits for the single-flight guard. Change Observatory: no change. Compatibility: the plugin behaves as before.

## 0.159.6

- Version bumps (`npm run release`, or `npm run sync-version` after `npm version`) set the version in every plugin manifest, the `agentic-sdlc` bridge included, so it can no longer fall behind. Change Observatory: no change. Compatibility: nothing changes for older plugins.

## 0.159.5

- `npm run test:fast` runs a quick local subset of the tests: the cheap unit files whole, plus a few selected end-to-end tests per feature area, listed in `test/test-tiers.json`. It is a partial run for routine checks and is refused under CI; releases and CI keep running the full suite (`npm test`). A selected end-to-end test that is renamed, skipped, or no longer runs fails the tier and is named, and a unit test checks the list against the test files.
- The test runner removes `NODE_USE_SYSTEM_CA` from the environment its test files inherit, so every CLI process the suite spawns no longer loads the system certificate store first. `AGENTIC_SDLC_TEST_STRIP_ENV` replaces the list of removed variables (empty keeps them all).
- Test discovery ignores `test/helpers` and `test/fixtures`, and a full-suite test fails when another test file under `test/` would be skipped by discovery.
- No change needed for plugin users.

## 0.159.4

- Two clones of the same project on one computer no longer overwrite each other's presence: the computer's presence ref keeps one entry per clone (`clones`), and its stories and activity cover them all, so the claims of both stay renewed.
- The roles stay with the clone that wrote their lease; the other clone neither renews them nor runs their duties. When a session ends in one clone while another clone of the computer is working, nothing is handed back and the computer stays alive.
- Change Observatory: no change needed. Compatibility: older plugins read the top-level stories and activity as before.

## 0.159.3

- When the computer holding a role runs a plugin too old for one of its automatic duties (`since` in `config/role-duties.json`), one live computer with a recent plugin, chosen by rendezvous hashing, runs that duty in its place. The holder keeps the role and everything it already does; a pinned role never gets a stand-in.
- Channel messages waiting for their push window start the detached tick within seconds again, not at the next 5-minute tick.
- Change Observatory: no change needed. Compatibility: older holders are covered by the stand-in; nothing new is written.

## 0.159.2

- `coordinator main-green` judges the base branch by the newest commit that ran CI: record commits marked `[skip ci]` (or `skip-checks: true`) no longer hide a red main. A fresh commit whose CI has not started yet is still judged by itself.
- The host hook no longer waits for the network: the presence and roles tick runs in a detached process, at most every 5 minutes, so the messages a hook shows are never held up or lost.
- Duties that publish records keep their last outcome (`<git common dir>/agentic-sdlc/duties/<duty>.result.json`), and `roles status` shows it, including why a push was refused (a protected branch, for example). A base worktree left dirty by a dead run is cleaned before the next duty instead of stopping them for good.
- A pinned coordinator host with `fallback: hold` or `next_host` takes the free lease when it needs a reserved action, instead of being refused until its next tick.
- Default reserved actions are now only `autonomy.delivery.action:pull_request.merge` and `baseline.refresh`: reserving `story.publish-records` made `story close` fail on every other computer, `wait.resolve` must stay with each computer, and `story.assign` and `plugin.release` were not commands. `reserved_actions` replaces the list when set.
- Change Observatory: no change needed. Compatibility: nothing changes for older plugins.

## 0.159.1

- With `--json`, a failing command no longer appends the known-error hint to stderr, so the JSON error payload stays parseable; the failure is still remembered for `mpsf known-error add --from-last-failure`.
- The `agentic-sdlc` bridge entry is version-locked to `mpsf` again.
- Change Observatory: the story priority badge uses the 12px minimum font size. Compatibility: nothing changes for older plugins.

## 0.159.0

- **Traces, workflow instances and final gate receipts on `sdlc-state` (level 2).** `state migrate` now also moves `traces/` (with checkpoints), `workflows/instances/` and `gates/<story>-final.json`; a project migrated with 0.154 runs it again. Run it on a checkout up to date with the base branch.
- Hash-chained histories are never overwritten: when this computer and the branch both added events, `state push` and `state pull` re-seal this computer's events after the branch's (keeping their original seals, like `trace rebase`) and push fast-forward.
- Dependency checks on the base branch, the closing-records warning, the trace fork warning (`state sync` instead of `trace rebase`) and story sync read these records from the state branch; story sync and publish-records no longer rebuild the project history onto the base branch for such projects.
- The Change Observatory shows them from the state branch.
- Needs 0.159.0 on every computer once a project moves them; older plugins are told to update.

## 0.158.3

- CLI messages, help usage and printed examples say `mpsf <command>`; `agentic-sdlc` keeps working as an alias and help, completion and dispatch accept either name. Prefixes other computers read (`[auto]` channel messages, `agentic-sdlc:` known-error hints, schema ids) are unchanged.
- Change Observatory: the empty-project hint shows `mpsf init`.

## 0.158.2

- Push budget also covers the `sdlc-state` branch and claims: state pushes wait for the backoff after failed pushes, and both count as this computer's pushes, so channel messages and presence renewals space around them. Claims are never delayed. Change Observatory: no change. Compatibility: nothing changes for older plugins.

## 0.158.1

- Test fix only: the outbox note test expects the English keep-going text. Change Observatory: no change. Compatibility: nothing changes.

## 0.158.0

- `coordinator merge` and `coordinator main-green` work on GitLab and Gitea/Forgejo too, not only GitHub. The forge comes from the remote URL (gitlab.com, codeberg.org, hosts named gitlab, gitea or forgejo) or from `AGENTIC_SDLC_FORGE=github|gitlab|gitea|forgejo`; `AGENTIC_SDLC_FORGE_URL` sets the web address for another port or a path prefix.
- GitLab: merge requests through API v4, head pipeline as the check, merge pinned to the checked commit, `--method merge|squash` (rebase or fast-forward is the project's setting), a branch behind is rebased. Gitea/Forgejo: pull requests through API v1, commit statuses as checks, latest review per reviewer, merge pinned with `head_commit_id`.
- Token: `GITLAB_TOKEN`, `GITEA_TOKEN`/`FORGEJO_TOKEN` or `AGENTIC_SDLC_FORGE_TOKEN`, else the system keychain through `git credential fill` (never prompting). Without one the command stops and prints how to store it. Nothing is written to `.sdlc`.
- Change Observatory: no change needed; it does not read forges.
- Compatibility: nothing changes for older plugins; GitHub projects behave as before.

## 0.157.7

- Faster checks of baseline files that came with the base branch and of secret scans that start after the delivery base: a fixed number of Git processes instead of up to four per file. Nothing changes in the results.
- Change Observatory: no change needed.
- Compatibility: nothing changes for older plugins.

## 0.157.6

- **Push budget per computer.** Channel messages (git provider), presence and role leases are pushed at most once every 2 minutes per computer (`AGENTIC_SDLC_PUSH_INTERVAL_SECONDS`, 0 = no spacing), with backoff after a failed push (30 s up to 8 min). A message written in between is shown at once here and leaves with the next push, in the same `git push` as presence; `message send` says so. Role lease changes are not delayed; presence renewals get a fixed jitter per computer (10 to 15 minutes).
- Change Observatory: no change needed (it reads the local message cache, where waiting messages already are). Compatibility: refs and records unchanged, older plugins read everything as before.

## 0.157.5

- Faster story commit checks: working out a story's own commits (base commits, records-only commits, a commit and its revert) and the paths they touch now costs a fixed handful of Git processes per story instead of about five per commit. Nothing changes in the results.
- Change Observatory: no change needed.
- Compatibility: nothing changes for older plugins.

## 0.157.4

- A claim is renewed by the agent's work in the worktree that has its branch: the host hook notes each tool call there (at most once a minute, `<git common dir>/agentic-sdlc/worktree-activity.json`), so editing code before any commit keeps the claim alive. The story folder's own file times no longer count: a checkout or pull rewrote them and brought old claims back to life.
- Status and claim decisions read the other computers' presence as the remote has it (one bounded fetch, at most once a minute) before judging a claim abandoned.
- Projects without `claim_policy.default_ttl_seconds` use the template's two hours in the presence too.
- Change Observatory: no change needed. Compatibility: nothing changes for older plugins.

## 0.157.3

- The repository is now `aantenore/mpsf`: links in the manifests, the marketplace, the README and the docs point to it (`/plugin marketplace add aantenore/mpsf`). The old `aantenore/agentic-sdlc` URL keeps working through GitHub's redirect; the marketplace name `aantenore` is unchanged, so installed plugins update as before.

## 0.157.2

- Skills updated for today's features: the main skill has a "Several Computers" section (roles and presence, operational records on the `sdlc-state` branch, a local warning only for an old plugin, `newer_record_format`, the capability catalog) and two new guardrails; the command reference documents `state status|pull|sync` and the catalog; the assessment and Change Observatory skills mention the catalog, state-branch records and newer record formats. Skill ids are unchanged.

## 0.157.1

- Role duties that publish records use the base worktree one at a time: when main-green and knowledge distill start together, the second waits for the first instead of committing its files.
- A project in a subfolder of its repository runs those duties in the same subfolder of the base worktree, so its records are published.
- Presence, roles and duties no longer stop ticking for a while when the computer's clock goes back.
- Change Observatory: no change needed. Compatibility: nothing changes for older plugins.

## 0.157.0

- **Capability catalog.** An optional `.sdlc/capability-discovery/catalog.json` (`{"schema_version": "capability-catalog:v1", "allow": [...]}`) is an allowlist for installed tools: with it, `capability inventory`, `capability recommend --from-inventory` and the suggestion in `task start` and `status` only consider declared entries. Items are a bare name or `skill:`, `command:`, `plugin:`, `mcp:` plus a name; an allowed plugin brings its own skills and commands. Without the file nothing changes. An unreadable catalog stops the command rather than allowing everything. Older plugins ignore the file. See [Self-service CLI](docs/self-service-cli.md#see-what-tools-are-already-installed).
- The default inventory exclusion now also names `mpsf`, so the plugin does not suggest itself after the rename (existing projects can add it to `capability_discovery_policy.inventory.matching.exclude_names`).

## 0.156.1

- Coordinator duties for claims and waits, as standalone idempotent commands with `--dry-run` and `--json`, that do nothing on a computer not holding the coordinator role: `coordinator free-claims` frees a claim only when its lease ended with no push, no declared wait and no live presence of its holder, and saves the freed story's handoff pack (otherwise a person decides, with the commands shown); `coordinator settle-waits` closes expired waits and stale questions; `coordinator handoff --story <id>` builds a handoff pack on demand. Both automatic duties start by themselves on the coordinator (`config/role-duties.json`). Records are the existing release and wait-resolve records: older plugins read them as before.

## 0.156.0

- Every record has a format version: `schema_version` (`<kind>:v<N>`). Records without it, and the story/contract records stamped with the project config version, read as format 1. Claims now carry `claim:v1`.
- The highest format the plugin knows comes from its bundled schemas. `coordinator check-records` warns (`newer_record_format`) when a story or claim was written by a newer plugin.
- Change Observatory: a record written by a newer plugin shows a `schema_version_newer` warning and is still read.
- Compatibility: older plugins accept the new field (the claim schema allows extra keys); no config key added.

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
- Needs 0.147.0 on every computer once a project sets `host_policy.adapters` or `host_policy.roles`; older plugins are told to update.

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

- The merge and push guard on the base branch applies to every repository that has `.sdlc/project.json` in the working tree, the index or the committed base branch; deleting the file locally does not lift it. `host_policy.guard.protect_base_branch` (default `true`) turns the rule off only when set to `false` in the committed base branch, never from the working tree or the index. Agent edits to `host_policy.guard` are denied.
- Here-document bodies are treated as data, not as commands, by the guard.
- Records publication makes up to 4 attempts, so up to 3 retries after waits of 1s, 2s and 4s, each on a fresh base tip; the failure reason is the remote's own line. `AGENTIC_SDLC_PUBLISH_BACKOFF_MS` sets the first delay in milliseconds (default 1000, doubled each time).
- Three more actions can be delegated by a person with `autonomy delegation grant --actions`: `delivery.approve`, `baseline.approve`, `story.supersede`.
