<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
    <img src="assets/brand/logo.svg" alt="MPSF" width="320">
  </picture>
</p>

<h3 align="center">Your coding agent wrote the code. Can you show what it was asked, what it was allowed to touch, and what it actually tested?</h3>

<p align="center">
  MPSF (<b>My Personal Software Factory</b>) is a free plugin for <b>Claude Code</b> and <b>OpenAI Codex</b> that turns agent work into a reviewable, verifiable record kept in your own git repository.<br>
  No server, no account, no telemetry: records stay in your repository.
</p>

<p align="center">
  <a href="https://github.com/aantenore/mpsf/actions/workflows/ci.yml"><img src="https://github.com/aantenore/mpsf/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/aantenore/mpsf/releases/latest"><img src="https://img.shields.io/github/v/release/aantenore/mpsf" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/hosts-Claude%20Code%20%7C%20Codex-555" alt="Claude Code and Codex">
  <img src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-555" alt="macOS, Linux, Windows">
</p>

<p align="center">
  <a href="#try-it-in-two-minutes">Try it</a> ·
  <a href="#why-it-is-different">Why it is different</a> ·
  <a href="#several-computers-no-server">Several computers</a> ·
  <a href="#how-it-compares">How it compares</a> ·
  <a href="docs/README.md">Docs</a>
</p>

---

Agents are fast. The problem is everything around the diff: a chat that scrolls away, an assumption nobody confirmed, a file outside the agreed scope, a "tests pass" that was never run. Code review sees the result, not the reasoning or the boundary.

MPSF puts a contract around each piece of agent work:

1. **Agree first.** The agent states what it understood about the project and proposes a plain-language work brief: goal, files, tools, limits, exclusions. You approve it once.
2. **Work inside the boundary.** A deterministic CLI, not the model, checks the work against what you approved. Changed files outside the agreed paths, actions outside the approved set and exhausted budgets stop the delivery.
3. **Prove it.** Tests are recorded with the exact command, exit status and output. "Done" means the gate passed on recorded evidence, not that the agent said so.
4. **Keep it.** Requests, decisions, changes and checks live under `.sdlc/` in your repository, travel with the code, and open in a local visual app.

<p align="center">
  <img src="docs/images/observatory-overview.png" alt="Change Observatory overview: stories delivered, in progress and blocked, check results and activity over time" width="900">
  <br><sub>Change Observatory, the bundled local app (sample data). It runs on 127.0.0.1 and never edits your code or your records.</sub>
</p>

## Try it in two minutes

Requires **Node.js 18.20.3–18.x, 20.12.0–20.x, or 21.6.0+** and Git.

### Claude Code

Type these in the Claude Code prompt, not in a shell:

```text
/plugin marketplace add aantenore/mpsf
/plugin install mpsf@aantenore
/mpsf:doctor
```

Full guide: [Claude Code Installation](docs/hosts/claude-code.md).

### Codex

Codex installs from a checkout through a transactional installer (check, plan, apply, validate, with a byte-exact restore if anything fails):

```bash
git clone https://github.com/aantenore/mpsf.git
cd mpsf
python3 scripts/install-personal-marketplace-v2.py check
cd ..
```

Then follow [Codex install](docs/hosts/codex.md#install) for the remaining steps.

### First run, in a throwaway folder

```bash
mkdir mpsf-trial && cd mpsf-trial && git init
```

This local-only trial runs a sandboxed smoke test: built in on macOS and Windows 10 1809+, while Linux needs bubblewrap at `/usr/bin/bwrap` (`sudo apt install bubblewrap` or your distribution's package).

Open the folder in a new agent session and ask:

```text
Initialize MPSF in this project with the default workflow.
```

Then:

```text
Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.
Implement a configurable trip-policy module that rejects trips above a cost limit, with tests.
```

The agent proposes a requirement and a work brief and waits for your approval before writing code. When it finishes, run `/mpsf:observe` (or ask it to open the Change Observatory) to see the request, the decisions, the changed files and the recorded tests. Delete the folder to remove everything.

On a real project, start with the request that matches the outcome and add your requirement, PR link or limits after it:

| Goal | Ask the agent | Claude Code shortcut |
| --- | --- | --- |
| Understand an existing codebase | `Contextualize this project and prepare an initial technical assessment.` | `/mpsf:assess` |
| Requirement to a new pull request | `Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.` | `/mpsf:deliver` |
| Finish a pull request that already exists | `Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.` | `/mpsf:continue-pr` |
| Build and verify only on this machine | `Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.` | `/mpsf:local` |

Full walk-through: [Getting started](docs/getting-started.md). To run the `mpsf …` commands shown in the docs from your own terminal, see [Run the CLI from your terminal](docs/hosts/claude-code.md#run-the-cli-from-your-terminal).

## Why it is different

| | What MPSF does | Where to check |
| --- | --- | --- |
| **The model is not the referee** | Requirements, work briefs, permissions, budgets and evidence are validated by a deterministic Node.js CLI against JSON schemas. The conversation proposes; the CLI decides what is allowed. | [Architecture](docs/architecture.md) |
| **Autonomy is chosen per delivery** | For each pull request or local release you pick how independent the agent is: ask at every step, continue between checkpoints, or finish inside the shown limits. Merge, production, deploy and force-push are never implied. | [How it works](docs/how-it-works.md) |
| **Evidence, not claims** | `test record` binds a story to the exact command and exit status. The lifecycle gate passes only when requirement, contract, outputs, latest tests and release evidence agree. Changed files are scanned for committed credentials. | [Commands](skills/agentic-sdlc/references/commands.md) |
| **History you can check** | The local trace is hash-linked to a checkpoint, so edits, reordering and truncation are detected by `mpsf trace verify`. That is tamper-evident, and the docs say plainly it is not tamper-proof. | [Self-service CLI](docs/self-service-cli.md#verify-the-project-history) |
| **Records live in your repo** | Everything is plain files under `.sdlc/` (or an `sdlc-state` branch). Another person or agent can pick up the work months later without the original chat. | [Knowledge-base structure](docs/kb-structure.md) |
| **Readable by non-engineers** | The Change Observatory answers "what was asked, what changed, why was it decided" for each story, down to the raw record. English and Italian UI. | [Change Observatory](docs/change-observatory.md) |
| **Two hosts, one tree** | Claude Code and Codex load the same skills, schemas, templates and CLI. | [Hosts](docs/hosts/README.md) |
| **Windows included** | The local-release smoke test runs in a sandbox on all three systems: built in on macOS, bubblewrap on Linux, a per-run AppContainer on Windows 10 1809+ with no admin rights. | [Windows](docs/windows.md) |

Change one word in the recorded history and the next check says so, with exit status 1 (output shortened):

```text
$ mpsf trace verify
The project history changed unexpectedly.
- .sdlc/traces/project.jsonl: CHANGED (checkpoint_drift, last_event_hash_mismatch, rolling_hash_mismatch)
```

Commit a fake cloud key and the delivery cannot be certified:

```text
$ mpsf secret scan --story ST-001 --base HEAD~1
- Found 2 credential match(es) in 1 scanned file(s) of story ST-001
- src/config.mjs:1 aws_access_key_id AKIA…
```

Both run in a throwaway folder in one minute: [See it catch problems](docs/see-it-work.md).

<p align="center">
  <img src="docs/images/observatory-timeline.png" alt="Change Observatory timeline: requests, agreements, changes, decisions and checks over time" width="900">
  <br><sub>Every recorded request, agreement, change, decision and check, filterable by story (sample data).</sub>
</p>

## Several computers, no server

Run agents on several machines against the same project and coordinate them through the git remote you already have.

```mermaid
flowchart LR
  A[Computer A<br/>agent] -- claim ST-002 --> R[(Project git remote<br/>refs only)]
  B[Computer B<br/>agent] -- claim ST-002 --> R
  R -- accepted --> A
  R -- refused: held by A --> B
```

- **Atomic story claims.** `story claim` records the claim on the remote with a push that only the first claimer wins. The other computer is told who holds the story, on which branch and since when.
- **Signed messages between computers.** The default channel is one git ref per computer; each message is a small commit signed with that computer's Ed25519 key. Unregistered or wrong signatures are shown as untrusted. Messages only inform; they never approve or claim anything.
- **Agent discussions with a binding outcome.** When two agents disagree (who takes a half-finished story, for example) they can open a short, time-boxed discussion. Only a signed, schema-valid decision binds, and it maps to an existing command that still runs all its checks. An unresolved objection goes to a person.
- **Optional coordinator role.** One computer can hold a lease to merge pull requests one at a time, publish records, free abandoned claims and keep the base branch green.
- **Any git server.** Claims, the channel, signatures and discussions work on GitHub, GitLab, Gitea/Forgejo, Bitbucket or a bare git remote. Coordinator merges use the GitHub, GitLab and Gitea/Forgejo APIs.
- **Mixed plugin versions.** A record that needs a newer plugin declares it; an older install keeps read-only commands working and refuses changes until it is updated.

<p align="center">
  <img src="docs/images/observatory-now-chat.png" alt="Change Observatory Now panel and chat: who works on which story from which computer, an open question, and a discussion where one agent proposes to take a story and another agrees" width="900">
  <br><sub>Three computers on one project: who holds which story, an open question, and a discussion that ends in a proposed claim (sample data).</sub>
</p>

Details: [Messages between computers](docs/messaging.md), [Adapters and roles](docs/adapters-and-roles.md), [Parallel work](docs/architecture.md#several-computers).

## How it compares

MPSF does not replace your agent, your tests or your CI. It adds the agreement and the record around them.

| | Plain agent session | Rules file (`CLAUDE.md`, `AGENTS.md`) | Spec-driven kit (e.g. [Spec Kit](https://github.com/github/spec-kit)) | CI checks | **MPSF** |
| --- | :---: | :---: | :---: | :---: | :---: |
| Scope agreed before the agent writes code | | partly | ✔ | | ✔ |
| Scope enforced outside the model | | | | | ✔ |
| Agent autonomy chosen per delivery | | | | | ✔ |
| Tests tied to the exact command and exit status that ran | | | | ✔ | ✔ |
| Why a decision was taken, kept with the code | | | partly | | ✔ |
| Visual history a product owner can read | | | | | ✔ |
| Several computers coordinated without a server | | | | | ✔ |

A spec-driven kit gives the agent better instructions: spec, plan and task files it reads before coding. MPSF checks the result against what you approved, with a deterministic CLI instead of the model's word. The two fit together: the agent can turn a spec into the requirement you approve.

## Who it is for

- **Developers using Claude Code or Codex** on real repositories, who want to hand over bigger tasks without losing control of scope.
- **Software houses** that have to show a client what was asked, decided, changed and verified for each delivery.
- **Teams in regulated environments** that need a change trail they can audit. MPSF keeps evidence; it does not certify compliance on its own.

## Questions people ask first

**Do I have to learn the CLI?** No. You talk to the agent as usual; the skills load when the conversation matches, and the slash commands are only shortcuts. A few steps are reserved for you in your own terminal, such as approving a standing approval; the agent hands you the exact command.

**Can the agent get around it?** Partly, and the docs say where. The hooks and the CLI refuse the obvious paths, but in the default mode an agent that writes and runs its own script could still approve a standing approval. Projects that need more turn on [signed approvals](docs/how-it-works.md#signed-standing-approvals), where only the host's Ed25519 receipt counts.

**What does it cost my session?** Each hook check adds a short Node start-up to shell and edit calls, and hook output is capped per event (700 tokens at session start, a few hundred elsewhere). Agents read small per-story [context packs](docs/token-efficiency.md#context-packs-and-compact-output) instead of whole records.

**What if I stop using it?** `/plugin uninstall mpsf@aantenore`. The records stay in `.sdlc/` as plain files (JSON, JSONL, Markdown) in your repository, readable without the plugin.

## Documentation

| Start | Go deeper | Reference |
| --- | --- | --- |
| [Getting started](docs/getting-started.md) | [How it works](docs/how-it-works.md) | [Command reference](skills/agentic-sdlc/references/commands.md) |
| [Claude Code](docs/hosts/claude-code.md) · [Codex](docs/hosts/codex.md) | [Limits and metering](docs/limits-and-metering.md) | [Architecture](docs/architecture.md) |
| [Change Observatory](docs/change-observatory.md) | [Configurable workflows](docs/configurable-workflows.md) | [Reference overview](docs/reference.md) |
| [Windows](docs/windows.md) | [Messages between computers](docs/messaging.md) | [All guides](docs/README.md) |

## What's new

- **1.0.33** — Governance matrix test no longer fails on hosts without a smoke sandbox.
- **1.0.32** — README shows the two checks failing on purpose.
- **1.0.31** — CLI suggests the command or option you meant.
- **1.0.30** — SECURITY.md and CONTRIBUTING.md; docs and skills match the CLI.
- **1.0.29** — Neutral sample names in docs, CLI examples and tests.

Every release is in the [changelog](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Antonio Antenore
