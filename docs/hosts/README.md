# Hosts: Claude Code and Codex

MPSF runs inside two agent hosts from one source tree. Pick your host page for installation and host-only details; everything else in [the docs](../README.md) applies to both.

- [Claude Code](claude-code.md) — marketplace install, slash commands, hooks, autonomous update, troubleshooting.
- [Codex](codex.md) — transactional installer, build verification, update, uninstall, doctor.
- [Native Codex session meter](codex-session-metering.md) — the token meter that exists only on Codex.

| Host | Manifest | Command surface | Installer |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | skills + slash commands (`commands/*.md`) | `/plugin marketplace add` |
| Codex | `.codex-plugin/plugin.json` | skills + agent cards (`skills/*/agents/openai.yaml`) | `scripts/install-personal-marketplace-v2.py` |

Both read the same `skills/`, the same JSON schemas, the same templates, and the same Node.js CLI under `bin/`. There is no host-specific fork of the lifecycle logic: the CLI owns every gate, receipt, and record, and the host only supplies the conversation. When a command names no `--actor` or `--agent`, the CLI attributes the record to the host it detects from the environment (`claude-code` when `CLAUDECODE` is set, `codex` otherwise); set `AGENTIC_SDLC_AGENT_HOST` to `codex` or `claude-code` to choose explicitly. Inside an agent session (`CLAUDECODE` or `CODEX_THREAD_ID` set) a record written without `--actor-type` is attributed to the agent even when `--actor` names a person; an explicit `--actor-type` is kept as given.

## Same on both hosts

Requirements, stories, contracts, gates, autonomy and approvals, delivery (pull request or local release), claims and roles across computers, messaging, knowledge, the Change Observatory, the `optimization` gateway with RTK and the Caveman skill, and every `.sdlc/` record. The project state lives in the target repository, so two people on different hosts work on the same project without any conversion.

## What differs

| Topic | Claude Code | Codex |
|---|---|---|
| Install | `/plugin marketplace add aantenore/mpsf`, `/plugin install mpsf@aantenore` | `install-personal-marketplace-v2.py` check, plan, apply, validate, confirm ([codex.md](codex.md#install)) |
| Update | `claude plugin marketplace update aantenore && claude plugin update mpsf@aantenore`, then `/reload-plugins`; optional autonomous update with `AGENTIC_SDLC_AUTO_UPDATE=1` | rerun the installer and `codex plugin add` ([codex.md](codex.md#update)); no autonomous update |
| Uninstall | `/plugin uninstall mpsf@aantenore` | `codex plugin remove agentic-sdlc-codex-plugin@personal` (identifier kept for in-place updates, see [codex.md](codex.md)) |
| Doctor | `/mpsf:doctor` | `node <plugin-root>/bin/mpsf.mjs doctor` (`npm run doctor` from a checkout) |
| Starting a journey | `/mpsf:assess`, `/mpsf:deliver`, `/mpsf:continue-pr`, `/mpsf:local`, `/mpsf:observe`, `/mpsf:status`, or plain language | the starter prompts of the agent cards, or plain language |
| CLI path | `~/.claude/plugins/cache/aantenore/mpsf/<version>/bin/mpsf.mjs` (slash commands and hooks use `${CLAUDE_PLUGIN_ROOT}`) | `~/.codex/plugins/cache/personal/agentic-sdlc-codex-plugin/<version>/bin/mpsf.mjs` (see [codex.md](codex.md#verify-the-exact-build-not-only-the-version)) |
| Hooks (`hooks/hooks.json`, shared) | enabled with the plugin | run only after you trust them in "Review hooks"; `SessionEnd` capped at 3 seconds |
| Session markers | `CLAUDECODE` | `CODEX_THREAD_ID`, `CODEX_AGENT_NAME` |
| Host settings the guard protects | `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json` | `.codex/config.toml` |
| Token metering | no native meter: `codeburn` adapter with the Claude Code log provider, or `budget usage record` | native [Codex session meter](codex-session-metering.md) (default) |
| Token-efficiency setup | nothing to configure | optional `scripts/autoconfigure-token-efficiency.py` writes RTK guidance into the global Codex instructions |

Skills locate the plugin root the same way on both hosts: two directories above their own `SKILL.md`.

## Smoke check after installing

Open a new Claude Code session or Codex task in a disposable repository and ask:

```text
Contextualize this project and prepare an initial technical assessment.
```

The journey must ask at most two decisions (the inferred project context, then one combined assessment proposal) and end with the real requested file, a short summary and a stored verification receipt. Then ask `Open the Change Observatory for this project.`: it must return a token-bearing loopback URL and leave the project tree unchanged.
