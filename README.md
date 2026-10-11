<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" alt="MPSF" width="480">
  </picture>
</p>

# MPSF

One source tree, two host packagings: **OpenAI Codex** (`.codex-plugin/`) and **Claude Code** (`.claude-plugin/`). Both load the same skills, schemas, templates, and Node.js CLI.

## In plain English

**The problem:** when a coding agent works on a software project, it can be hard to tell what it understood, what it was allowed to change, why it made each decision, or whether the result really works.

**What MPSF changes:** it turns that work into a reviewable journey. The goal and boundaries are agreed before execution, important decisions and evidence stay with the project, delivered files are checked, and a local visual app explains the history. A product owner can understand the outcome without reading code, while an engineer can still inspect the underlying evidence.

**Example:** a product owner asks Codex to assess an existing service and produce an architecture report. The plugin records the request, Codex's understanding, the approved boundaries, the report, and the checks that were actually run. Change Observatory then presents that history as a readable local timeline.

| Feature | Practical benefit |
| --- | --- |
| Project understanding before work | People can correct facts and assumptions before they influence the result. |
| Visible work boundary | The goal, files, tools, limits, and exclusions are clear before execution. |
| Evidence-backed completion | The delivered file is linked to the checks actually run, not just an agent's claim that it is done. |
| Change Observatory | A local visual timeline shows what was asked, decided, changed, and verified. |
| Project memory that travels with the code | Another person or agent can resume later without relying on a disappearing chat. |

## Technical summary

MPSF gives a coding agent a guided way to understand an existing software project, deliver verified work, and explain its recorded lineage visually. The normal experience is intentionally simple: Codex explains what it inferred, proposes the work in plain language, creates the requested real file, verifies it, and returns an auditable result.

Project state stays in the target repository under `.sdlc/`. The plugin installation contains reusable skills, templates, schemas, the cross-platform Node.js CLI, and the build-free Change Observatory UI.

You talk to Codex in normal language. Codex turns that request into structured input; the deterministic CLI checks the agreed requirement, work brief, permissions, and evidence. A new user does not need to run the low-level lifecycle commands manually.

## What's new

Latest first; the full list is in the [changelog](CHANGELOG.md).

- **0.159.18** — the test suite is slimmer: redundant scenarios are merged, with the same behaviors still asserted.
- **0.159.17** — the guard closes session-marker, alias, variable and API bypasses of the merge and push rules.
- **0.159.16** — messages injected into the agent show their trust; untrusted requests and version announcements are ignored.
- **0.159.15** — an agent can no longer confirm edits to gates, trusted keys or host policy with `config migrate --apply`.
- **0.159.14** — how-it-works examples name the current version.
- **0.159.13** — the Stop hook reaps only with a machine-local opt-in; the shared config can only narrow it.
- **0.159.12** — skill and install docs aligned with the code: `story cancel`, governed story-branch push, `git` messaging provider, coordinator duties.
- **0.159.11** — known-error apply stays inside the project and needs a real person's acceptance.
- **0.159.10** — the guard protects delivery action receipts, story claims and the whole record tree.
- **0.159.9** — messages signed by another key can no longer read as trusted through the signature cache.
- **0.159.8** — documentation and CLI help aligned with the code.
- **0.159.7** — tests only: sealed-receipt checks ask for the full re-verification.
- **0.159.6** — version bumps update every plugin manifest, the `agentic-sdlc` bridge included.
- **0.159.5** — `npm run test:fast` runs a quick local subset of the tests; the suite no longer inherits `NODE_USE_SYSTEM_CA`.
- **0.159.4** — clones of one project on one computer share its presence; roles stay with the clone that holds them.
- **0.159.3** — stand-in for role holders on old plugins; waiting channel messages tick sooner.
- **0.159.2** — main-green reads the newest commit that ran CI; roles tick detached from the hook; duty outcomes in roles status; fewer default reserved actions.
- **0.159.1** — `--json` error output stays parseable (no known-error hint appended); bridge entry version-locked again.
- **0.159.0** — traces, workflow instances and final gate receipts on the `sdlc-state` branch too (re-run `state migrate`): histories both computers extended are rebased, never overwritten; dependency checks, closing records, the fork warning and story sync read them from there.
- **0.158.3** — CLI messages and examples say `mpsf <command>`; `agentic-sdlc` stays an alias.
- **0.158.0** — `coordinator merge` also on GitLab (merge requests) and Gitea/Forgejo: forge picked from the remote, token from the environment or the system keychain.
- **0.157.7** — base-drift and secret-scan coverage checks read Git a fixed number of times instead of several times per file.
- **0.157.6** — push budget per computer: channel messages, presence and role leases leave in one push at most every 2 minutes, with backoff after failures.
- **0.157.5** — story commit checks read Git once per range instead of several times per commit, so gates and status are faster on long story branches.
- **0.157.4** — claims renewed by the agent's work in their worktree; presence fetched before judging a claim abandoned.
- **0.157.3** — repository renamed to `aantenore/mpsf`; old URLs redirect, marketplace `aantenore` unchanged.
- **0.157.2** — skills brought up to date: several computers (roles, presence, the `sdlc-state` branch, plugin versions without update requests, newer record formats) and the capability catalog.
- **0.157.1** — role duties one at a time on the base worktree; subfolder projects; ticks robust to clock changes.
- **0.157.0** — capability catalog: an optional `.sdlc/capability-discovery/catalog.json` allowlist limits the installed-tool inventory, recommendations and suggestions to the skills, commands, plugins and MCP servers the project declares.
- **0.156.1** — coordinator duties for claims and waits: `coordinator free-claims` (with the handoff pack of each freed story), `settle-waits` and `handoff`, each idempotent with `--dry-run`, run only where the coordinator role is held.
- **0.156.0** — records name their format in `schema_version`; records without it read as format 1, and records from a newer plugin raise a warning instead of an error.
- **0.155.0** — renamed to **mpsf** (My Personal Software Factory): plugin `mpsf@aantenore`, `/mpsf:...` commands; the old `agentic-sdlc` entry is a bridge that installs mpsf on the next session. Records, refs and config unchanged.
- **0.154.0** — operational records off the base branch: `state migrate` moves action receipts, executions and gate reports (not the final receipts) to an orphan `sdlc-state` branch of the same remote; the hooks sync them in the background (throttled, fast-forward only, `[skip ci]`); the Change Observatory shows them; older plugins are asked to update.
- **0.153.7** — the repository no longer carries its own `.sdlc` folder; nothing changes for projects using the plugin.
- **0.153.6** — computers no longer ask each other to update the plugin: each one warns only its own person, with the update command; requests from older plugins are shown as information and nothing reacts to them.
- **0.153.5** — main-green and knowledge distill run by themselves on the role holder, publishing only records to the base branch.
- **0.153.3** — record duties (main-green, knowledge distill) run on the base worktree and publish to the base branch, not in the checkout.
- **0.153.2** — `knowledge distill` reads the records of the freshly fetched base branch, not the working tree.
- **0.153.1** — role duties start by themselves on the role holder (detached; messaging, merge and main-green duties stay manual); a pinned coordinator's reserved actions are refused on the other computers.
- **0.153.0** — knowledge role: traps, fixes and channel answers distilled into `.sdlc/knowledge` and shown in the context pack of the stories they touch; the pack is printed at story claim and task start; per-worker context budget (`context budget`), usage in the Change Observatory.
- **0.152.1** — coordinator tasks read the stories from the remote base branch (fresh state reader), not the working tree.
- **0.152.0** — coordinator tasks as commands that run only on the coordinator: `coordinator digest` (replaces the heartbeat), `coordinator check-records`, `coordinator main-green` (P1 fix story, never a revert), `coordinator merge` (serial merges through a forge adapter, GitHub first); welcomes only from the coordinator.
- **0.151.3** — claims renewed by work (two-hour time to live for new projects); presence and roles handed back when a session ends; computers and roles in the Change Observatory.
- **0.151.2** — English output: hook texts, channel `[auto]` messages, waits and `roles status` in English (`--locale it` keeps Italian for `wait` and `roles status`); the update request keeps its `[auto] aggiorna il plugin` prefix so older plugins still recognize it. Logo in the README; repository links in `package.json`.
- **0.151.1** — fresh state reader: the base branch is read as the remote has it (bounded fetch, `git show`/`ls-tree`, never the working tree); the context pack says how many commits the checkout is behind it.
- **0.150.0** — messages between computers on git: one signed ref per computer in the project's remote, any git host, default for new channels (projects with a GitHub channel issue keep it); signed messages and computer keys registered in `.sdlc/machines`, untrusted ones marked in `message read` and the Change Observatory.
- **0.149.3** — first step of the rename to **mpsf** (My Personal Software Factory): `mpsf` command next to `agentic-sdlc`, `MPSF_*` variables as aliases of `AGENTIC_SDLC_*`.
- **0.149.2** — Codex `SessionEnd` hook within its 3-second limit: no more timeout notice on every run.
- **0.149.1** — computers and roles without messages: presence refs on the remote, coordinator and knowledge roles held by one alive computer each through create-only leases, handed over at renewal; `roles status`.
- **0.149.0** — known error database: when a gate, a test record or a command fails, the CLI shows the recorded fix of the same failure (deterministic signature, same on every computer); `known-error add --from-last-failure` records a new fix, `known-error outcome` reports whether it worked, a safe fix accepted by a person runs with `known-error apply`; Change Observatory panel "Known errors".
- **0.148.5** — stable computer id: kept in `~/.config/agentic-sdlc/machine.json`, same value as before, unchanged when the host name changes; an Ed25519 key per computer for signed coordination.
- **0.148.4** — quieter channel: a step only a person takes goes to the person of the session that waits, never to the channel; update requests only to computers seen in the last 2 hours; phase changes, commits, pushes, pull requests and test results stay in the records and the Change Observatory; alerts are deduplicated by state, not by wording.
- **0.148.3** — story priorities: one order P1 > P2 > P3 > none, then the oldest, in `next`, keep-going, offers, `status` and the Observatory; a fix from an incident inherits the priority from its severity; a broken main becomes a P1 fix story.
- **0.148.2** — the channel stops repeating `[auto] stato`: status goes out only when the set of stories or their phase changes, plus one notice per story and phase stalled for 4 h (`AGENTIC_SDLC_MESSAGING_STALL_HOURS`); a claim released on another computer is no longer reported as active from an outdated checkout or worktree.
- **0.148.1** — fixes: `task start` with an invalid delivery profile returns a blocked decision instead of aborting; an invalid `--autonomy-ceiling` is a user error listing the allowed values; the Codex installer updates a plugin installed under the old package name; docs: hooks work in Codex through `CLAUDE_PLUGIN_ROOT`.
- **0.148.0** — `context pack` and `context get` give an agent the small slice of a story it needs; commands print a short form inside agent sessions (`--verbose` for the full text); `--json-profile agent|full`; hook output is deduplicated and budgeted.
- **0.147.0** — messaging is optional (`github`, `local` or `none`); records go through a store (`git-sdlc` or `local-fs`); `host_policy.adapters` and a `coordinator` role in `host_policy.roles`.
- **0.146.13 to 0.146.17** — more delegable approvals (`delivery.approve`, `baseline.approve`, `story.supersede`), a stricter base-branch guard with a person-only `guard trust-remote`, retries when publishing records, no automatic "need help" for finished stories, a much shorter skill front door, and an early, clear stop for local releases on hosts without a sandbox (Windows).

## Documentation Map

- [Getting Started](docs/getting-started.md) — choose an assessment, a new pull request, an existing pull request, or a local-only result and see exactly what you will approve.
- [Documentation home](docs/README.md) — choose the right guide without knowing the internal record names.
- [How It Works](docs/how-it-works.md) — advanced detail about checkpoints, state transitions, authorization, verification, and recovery.
- [Autonomy, Limits, and Metering](docs/limits-and-metering.md) — concrete time, step, token, cost, reserve, warning, and stop-policy examples.
- [Configuration Safety](docs/configuration-safety.md) — why project behavior is pinned, how to preview an upgrade, and how to recover from drift without hidden policy changes.
- [Token Efficiency](docs/token-efficiency.md) — context packs, short command output, compact derived JSON, the RTK command gateway, lifecycle observations, and budget-safe savings telemetry.
- [Native Codex Session Metering](docs/codex-session-metering.md) — authentication-free local token/call observations, exact task binding, and limit semantics.
- [Assessment Interactions](docs/agent-interactions.md) — the precise contract used for every user question.
- [Claude Code Installation](docs/claude-code-install.md) — install from the bundled marketplace, use the slash commands, and see which Codex-only steps do not apply.
- [Portable Installation](docs/portable-install.md) — installation, update, diagnosis, and recovery on supported platforms.
- [Self-service CLI](docs/self-service-cli.md) — focused help, one-step status, safe presentation presets, shell completion, and machine output.
- [Change Observatory](docs/change-observatory.md) — launch the local visual lineage app and understand its evidence and security model.
- [Configurable Workflows](docs/configurable-workflows.md) — select a governed process, customize labels safely, and keep running history pinned and append-only.
- [Changelog](CHANGELOG.md) — what changed in each release, in plain language.
- [Messages between computers](docs/messaging.md) — optional notes between computers, and how to work without them.
- [Adapters and Roles](docs/adapters-and-roles.md) — messaging providers, record stores, assurance levels and the coordinator role.
- [Examples](docs/examples/README.md) — a copy-paste GitHub Action that turns a labelled issue into a proposed work brief and posts it as a comment, without approving, pushing, or merging anything.

## Quick Start

Runtime prerequisite: **Node.js 18.20.3–18.x, 20.12.0–20.x, or 21.6.0+**.
Earlier releases in those lines contain an upstream native shutdown livelock.

### Claude Code

```bash
/plugin marketplace add aantenore/mpsf
/plugin install mpsf@aantenore
/mpsf:doctor
```

Then use a starter command — `/mpsf:assess`, `/mpsf:deliver`, `/mpsf:continue-pr`, `/mpsf:local`, `/mpsf:observe` — or just describe the outcome in plain language. Full guide: [Claude Code Installation](docs/claude-code-install.md).

### Codex

Install from the `aantenore` source repository. Keep this checkout separate from the generated personal-plugin directory:

```bash
git clone https://github.com/aantenore/mpsf.git
cd mpsf
python3 scripts/install-personal-marketplace-v2.py check
python3 scripts/install-personal-marketplace-v2.py plan --json
python3 scripts/install-personal-marketplace-v2.py apply --plan-hash <plan_hash-from-plan> --json
# Required: run candidate_registration.command.argv with its exact environment,
# then candidate_registration.verification.argv with its exact environment.
# Default target example only; do not use it for a custom returned target:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

Installer V2 is the canonical local installation path. `apply` retains the
byte-exact previous plugin and marketplace state and binds the exact Codex
executable, state directory, installed entry, and cache identity seen before
the update. If Codex uses non-default locations, pass `--codex-executable`
and/or `--codex-home` to `apply`. Before validation, execute
`technical_details.candidate_registration.command.argv` with exactly its
`environment`, then execute `verification.argv` with exactly its
`environment`. The two `env ... codex` lines above illustrate only the default
target; never substitute them when the returned executable, `HOME`, or
`CODEX_HOME` differs. The returned `confirm` and `restore` commands reuse that
target and reject a different one. After registration and validation, use
`confirm` to keep the update or the returned `restore` command to roll it back.
Confirmation verifies the candidate Codex list and cache before deleting
recovery data.
Restore is not reported as complete until the prior staging copy has also been
returned to the exact installed-or-absent Codex state captured by `apply`
through the official Codex command, and its list, cache fingerprint, and
provenance match. If that Codex step fails, the receipt remains open and
the JSON result returns `staging_restored`, `codex_reconciled`,
`partial_failure`, and an exact retry command. Codex is resolved from `PATH`
during `apply`, and retries reuse that receipt-bound executable and state
directory. Use `--codex-executable` or `--codex-home` on `apply` when those
locations are intentionally non-default.

After confirmation, run the returned
`post_confirm_autoconfigure_command`. The same command is shown above for a
source checkout. It verifies the bundled Caveman skill and native Codex-session
meter, then byte-verifies and configures RTK when RTK 0.43+ is already
available. It never installs or configures CodeBurn, never authenticates, and
never accesses the network. If RTK is absent, the plugin remains operational
through its native command fallback.

Autoconfiguration is intentionally post-confirm because RTK's Codex guidance is
user-global and therefore outside the reversible plugin-copy transaction. See
[Portable Installation](docs/portable-install.md) for the user-global scope,
runtime trust boundary, and update behavior.

### Start a new Codex task

Open the target project in a **new Codex task** and choose the request that matches the outcome you want:

| Goal | Starter request |
| --- | --- |
| Understand the project and receive an assessment | `Contextualize this project and prepare an initial technical assessment.` |
| Agree a new requirement and deliver it as a new PR | `Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.` |
| Continue one PR that already exists | `Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.` |
| Build and verify only on this machine | `Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.` |
| Read the recorded project history visually | `Open the Change Observatory and explain this project's recorded delivery lineage.` |

Add the actual requirement, PR URL, desired local destination, exclusions, or acceptance criteria after the starter. Codex preserves information you already supplied and asks only for material gaps.

For work that changes a product or named output, Codex also agrees the
requirement's material paths before task start. These are stored as
Git-relative project paths such as `src`, `test`, `docs`, and `evidence`; the
project root and outside paths are rejected. A local release uses a separate
boundary: its target and writable paths are explicit absolute filesystem paths
inside that target. A revision inherits the requirement paths when none are
supplied and replaces the complete list when any are supplied.

For implementation work, the order is deliberately linear:

1. preview and normalize the request without starting work;
2. agree the requirement and success criteria;
3. decompose it only when needed;
4. agree the output and plain-language work brief;
5. make a fresh autonomy choice for this one PR or local release and, for a pull request, say whether it needs a code review before the merge;
6. start the exact story-bound workflow before the task, then start the task once;
7. claim the now-started story, then implement and test, completing each phase before entering the next;
8. after validation, seal the intermediate strict gate and enter `release`;
9. complete the named PR or local release, record release evidence, release the completed story claim, then seal the final lifecycle gate.

Before showing the autonomy choices, Codex explains whether the most independent option can really be used. If this installation cannot digitally verify who approved the delivery, option 3 is reduced to **autonomy with checkpoints**; this is disclosed before you choose.

For a pull request, Codex asks one more question at the same step: do you want a code review before this PR is merged? The default suggestion is no, and the plugin then completes the PR in full automation. If you say yes, a person who did not author the commits must approve the code before the merge, and everything before the merge still proceeds automatically. The answer applies to that story only and is never reused. See [How It Works](docs/how-it-works.md#code-review-before-merge-is-chosen-for-each-story).

### One complete first project

Use one journey from start to finish instead of treating the lifecycle commands
as unrelated features. For example, ask Codex:

```text
Inspect this repository, then implement a configurable trip-policy module as a
local-only release. It must reject trips above a configurable cost limit, include
tests, and avoid network, production, and machine-global changes.
```

Codex should lead the same `ST-TRIP-POLICY-001` story through these visible
stages:

1. **Discovery** — inspect the repository read-only and explain facts,
   inferences, constraints, and missing information.
2. **Requirement** — agree the observable policy behavior, tests, exclusions,
   and maximum delivery independence.
3. **Contract** — agree the configurable source and test paths, local
   destination, smoke test, rollback, tools, and write boundary.
4. **Story and workflow** — create the story and bind a
   `software-project` v3 workflow to it, preserving the ordered
   discovery-to-release journey. Start that workflow before `task start` and
   before the first completed story step. A custom `phase_order` requires an
   approved story-bound definition with the exact same order.
5. **Implementation and test** — change only approved paths, run the agreed
   tests, record the latest successful evidence, complete each phase step, and
   only then enter the next workflow phase.
6. **Validation gate** — after completing validation, run the ordinary strict
   story gate to seal its intermediate receipt.
7. **Enter release** — use that receipt to move the current story-bound
   workflow to `release`.
8. **Release** — only after entering `release`, complete the named local release,
   append passing release evidence, complete the release step, smoke-test that exact result,
   and retain the declared rollback procedure. Push, PR creation, deployment,
   and production remain excluded.
9. **Final lifecycle certification** — only after the release evidence,
   terminal delivery close, the transition to `operations` with its completed
   `operations` step, and release of the completed story claim, run:

   ```bash
   mpsf gate check --strict --story ST-TRIP-POLICY-001 --lifecycle-complete
   ```

The final command is intentionally stronger than the distinct intermediate strict check.
It passes only when every configured story phase, current requirement and
contract, required output, latest test evidence, exact terminal delivery, and
release evidence agree with the current workflow's verified terminal event and
checkpoint. Codex then reports the delivered location, checks, exclusions,
residual risks, and final receipt. The reader does not need to run the preceding
low-level commands manually; [Getting Started](docs/getting-started.md#walk-through-one-complete-first-project)
shows what to expect at each decision.

A final receipt containing `workflow-final-freshness-proof:v1` remains useful
as history but does not certify the current project. Rerun the same
`--lifecycle-complete` command on the reviewed terminal state to reseal v2.
V2 allows the exact certified content to be staged and committed on descendant
history; it rejects transient divergent commits, replacement/graft history,
alternate Git index environments, shallow history, hidden index flags, and
later in-scope drift. In-scope untracked paths are inventoried even when
project, repository, or global Git ignore rules match them.

### Know where work happens

| Boundary | What it means |
| --- | --- |
| Codex conversation | Codex understands the request, explains the plan, and asks for decisions. |
| Deterministic CLI | The CLI validates structured state, permissions, limits, and evidence; it does not interpret the conversation. |
| Local execution and data | Project reads, approved local writes, tests, `.sdlc/` records, and a local release stay on the named machine and paths. |
| Repository publication | Push and PR create/update use the network and only the displayed repository and branches. |
| Shared work claims | `story claim` and its releases publish only small claim records under `refs/agentic-sdlc/claims/` on the project's git remote, so every computer sees who works on which story; no branch is pushed by them. |
| Deployment and production | A PR or local release never implies a remote deployment, production access, or secret use. Those need a separate exact decision. |

A **new PR** must show the repository, base branch, new head branch, allowed files, tests, push, and PR creation. An **existing PR** must show the exact PR and its current repository, base, head, and SHA; the workflow updates that PR and does not create another one. A **local-only result** excludes push, PR actions, remote deployment, and production and includes a smoke test plus rollback.

If the workflow pauses, ask Codex: `Why is MPSF blocked? Explain the next safe action without changing anything.` The read-only `mpsf status` command gives the same one-next-step orientation for operators. See [Getting Started](docs/getting-started.md#when-the-workflow-pauses) for recovery.

The dedicated `Project Assessment` and `Change Observatory` skills are visible in Codex and can also be selected implicitly from equivalent requests. The Observatory skill resolves the plugin-local launcher directly, so a Codex plugin installation does not depend on a global shell command.

If you are new to the plugin, continue with [Getting Started](docs/getting-started.md). The sections below are reference material for operators and maintainers.

## Self-service CLI

The CLI explains the outcome, practical impact, any decision needed, what remains protected, and one next step before showing optional technical details. Focused help and completion work even outside an initialized project:

```bash
PLUGIN_CLI="$HOME/plugins/agentic-sdlc-codex-plugin/bin/mpsf.mjs"
node "$PLUGIN_CLI" help
node "$PLUGIN_CLI" help autonomy delivery approve --locale it
node "$PLUGIN_CLI" completion zsh
node "$PLUGIN_CLI" preset list
node "$PLUGIN_CLI" status --cli-preset human-it
node "$PLUGIN_CLI" status --cli-preset machine
```

The plugin installation does not create a global `agentic-sdlc` executable.
An npm package installation may expose that bin through its package-manager
shim; the plugin-local form above is always explicit.

`--cli-preset` changes presentation only. It cannot authorize an action, change a command or destination, widen writable paths, or supply approval flags. Explicit CLI options take precedence. The existing assessment/output `--preset` option is unchanged. See [Self-service CLI](docs/self-service-cli.md) for deterministic export and shell setup examples.

## Change Observatory

Change Observatory is a local application bundled in the plugin that never edits your records. It answers “What was asked?”, “What changed?”, and “Why was it decided?”, then gives every recorded story a proof-bound Asked / Decided / Contract / Done / Verified dossier. Technical and non-technical readers can inspect the causal iteration, global contracts, decisions, changes, tests, gates, and raw canonical evidence without the app inventing missing history.

From an npm/git/tarball package installation that exposes the bin entry:

```bash
mpsf observe --root /path/to/project
```

For automation or a machine without a browser opener:

```bash
mpsf observe --root /path/to/project --port 0 --no-open --json
```

To compare an explicit set of local projects, pass a relative portfolio file;
no sibling-directory discovery or fallback is performed:

```bash
mpsf observe --root /path/to/workspace --portfolio-manifest portfolio.json
```

For a compact read-only status that exits without opening a server or creating
an access token:

```bash
mpsf portfolio status --root /path/to/workspace --manifest portfolio.json --json
```

Add `--fail-on-attention` to make the command exit non-zero when any project is
unavailable or needs attention (for example in a CI step); each such project
is listed with a short plain reason.

The portfolio starts with bounded summary cards and loads a project's detailed
lineage only after it is selected. Its versioned summary reports bounded active
workflows, blockers, risks, budgets, dependencies, and releases; an eight-entry
LRU disposes full project caches as the reader moves across larger manifests.
See [Change Observatory](docs/change-observatory.md#open-an-explicit-project-portfolio)
for the manifest format and path protections.

The server binds only to `127.0.0.1`, selects an ephemeral port by default, protects evidence APIs with a per-run token carried in the URL fragment, and makes no project writes. Plain-language explanations retain their `codex-generated`, `deterministic`, or `human-authored` label and contain only stored summaries, rationale, alternatives, inputs, outputs, and evidence—never private chain-of-thought. See [Change Observatory](docs/change-observatory.md) for the full model.

Operationally, the plugin now makes failures easier to investigate without
sending project data anywhere. Every governed CLI operation and Observatory
request has a `corr-<uuid>` correlation ID, and errors return a stable code plus that ID
without returning a stack trace, raw internal detail, token, or secret-bearing
path. A safe project-relative path may still be shown when it tells the operator
what to correct. The Observatory exposes
separate “the process is answering” and “the project can be read” checks,
in-memory metrics with a fixed set of labels, advisory SLOs, and a redacted
support bundle. External metric and log sinks are disabled.

New trace events are redacted before they are saved and are linked by hashes to
a local checkpoint. This detects edits, reordering, truncation, and checkpoint
drift during later validation. It is deliberately **tamper-evident local
integrity**, not a signature, proof of origin, or “tamper-proof” storage: someone
who can replace both the trace and its checkpoint can create a different
internally consistent history. Evidence fingerprints are calculated from the
redacted representation, so a digest does not preserve a hidden fingerprint of
the original secret.

Check the history at any time with the read-only `mpsf trace verify`.
It tells an unexpected change (exit code 1, with how to back up and restore
`.sdlc/traces` from version control) apart from an interrupted recording that
the next recorded event repairs automatically. `doctor` and the activity and
query reports run the same check, `status` runs a cheap consistency check, and
each leads with a warning when the history changed. Reports and status apply
the project's privacy rules again when they are presented or saved with
`--out`. If `.sdlc/config.json` goes missing in an initialized project, every
project command except `trace verify` stops (`CONFIG_MISSING`) instead of
silently falling back to the default privacy rules. See [Self-service CLI](docs/self-service-cli.md#verify-the-project-history).

Random-looking text is not treated as a secret by itself. Redaction happens
when a value has a known credential format, appears in credential context, is
explicitly configured as sensitive, or matches a configured secret/PII rule.
That keeps authorization action IDs such as `AUT-ACT-...`, SHA digests, UUIDs,
correlation IDs, source paths, and other legitimate audit references readable.
Identifier allow rules describe legitimate IDs; they never override a known
credential detector or an explicit project privacy rule.

## How It Works

A normal local assessment has **two user checkpoints**, not one approval for every internal record. The first confirms facts about the project; the second approves one immutable, complete execution tranche.

```mermaid
flowchart TD
  A["Inspect repository and local evidence<br/>read-only"] --> B["Explain facts, inferences,<br/>assumptions, and missing information"]
  B --> C{"Checkpoint 1<br/>Is the project context correct?"}
  C -- "Correct it" --> B
  C -- "Approve context only" --> D["Prepare complete proposal<br/>scope + output + tools + writes + budget"]
  D --> E{"Checkpoint 2<br/>Approve this exact proposal hash?"}
  E -- "Change it" --> D
  E -- "Approve complete tranche" --> F["Create proposal-bound authorization<br/>for exact action × subject pairs"]
  F --> G["Apply the displayed write-set<br/>idempotently"]
  G --> H["Execute, meter, generate,<br/>and verify the real artifact"]
  H --> I["Release gate and final result<br/>no routine third checkpoint"]
  G -.->|"New boundary or budget exception"| X{"Exceptional decision"}
  H -.->|"New boundary or budget exception"| X
  X -- "Approve versioned change" --> H
  X -- "Reject or stop" --> Y["Partial delivery or safe stop"]
```

### What The Two Checkpoints Mean

| Checkpoint | What Codex asks | What your answer authorizes | What it does **not** authorize | Example answer |
| --- | --- | --- | --- | --- |
| **1 — Project context** | Is the displayed understanding factually correct? | The exact baseline content hash | Starting work, creating the deliverable, tools, writes, budget, production, or external access | `I approve this project context.` or `Correction: we use Kubernetes, not ECS.` |
| **2 — Complete proposal** | May Codex execute the displayed scope, requirement ceiling, output, tools, write-set, limits, stop policy, and—when present—this one delivery profile? | Only the exact proposal hash, exact action × subject pairs, and selected level for the named delivery | Another PR/local release, protected merge, deploy, undisplayed actions, broader paths, secrets, production, destructive work, or silent budget extensions | `I approve this complete proposal and checkpointed level for PR-184.` or `Change the hard limit to 45 minutes and show the proposal again.` |

Every question must say **what is being asked, why it is needed now, what the answer authorizes, what it excludes, and valid answer examples**. A bare “Proceed?” is not sufficient.

Checkpoint 2 displays, in plain language:

- outcome, audience, scope, exclusions, depth, evidence sources, and checks;
- stable `requirement:v2` revision/profile and story IDs, including the autonomy ceiling and whether each record will be created or reused;
- report sections, real output format, destination, delivery mode, generator, and verifier;
- installed tools plus exact read, write, external-access, and production boundaries;
- contract draft, route intent, subject hashes, exact write-set, and idempotent recovery plan;
- aggregate limits for the main agent and subagents, warning thresholds, completion reserve, stop policy, and extension boundary;
- assumptions, limitations, and every action that would require a new decision.

When the tranche will produce a pull request or a local release, checkpoint 2 also names that exact delivery unit and asks for its autonomy level. The requirement carries only the maximum permitted level; it never silently authorizes a later pull request. A second pull request, even for the same requirement, receives a new delivery profile and a new explicit choice. Each profile is one delivery lane with exactly one story and its one approved contract; aggregate several changes through an agreed aggregation story/contract instead of hiding unrelated work in one profile.

The default budget uses soft limits only: an estimated 2,700 seconds of active time, 40 steps, and 200,000 tokens. Reaching one pauses the work for your decision; hard limits are opt-in and need a trusted signed exact meter. Cost remains unavailable and non-binding until a trustworthy metering adapter, immutable pricing reference, and currency are configured. See [Autonomy, Limits, and Metering](docs/limits-and-metering.md) before changing these defaults.

Internally, `assessment proposal approve` records host/CI authority and creates proposal-bound authorization. `assessment proposal apply` materializes only the approved write-set and safely resumes partial attempts. Every automated use gets a validity-at-use receipt. Completion requires aggregate budget accounting, layered artifact verification, and a release gate.

Normalized actions are configured in `assessment_workflow.requested_actions`. Question explanations live in `open_question_guidance`, including category keywords, rationale, bilingual examples, proposal effects, and safe fallbacks. New aliases or guidance therefore do not require hardcoded CLI branches.

An additional decision is exceptional: it is required for a new installation, external or production access, secrets, destructive work, an out-of-scope write, a material proposal change, or an unapproved budget extension.

## Autonomy Is Negotiated Per Requirement And Selected Per Delivery

**Autonomy** answers “what may the agent do without asking again?” **Limits** answer “how much may it consume while doing it?” A `requirement:v2` links an approved requirement execution profile that sets an autonomy ceiling. Every delivery unit then makes a separate, explicit selection for exactly one `pull_request` or `local_release`.

In plain terms:

1. While agreeing a requirement, you decide only the maximum freedom that future work may request. This does not authorize a pull request.
2. For every pull request or local release, the plugin asks for a separate autonomy choice. That choice applies only to that delivery and is never reused. For a pull request it also asks, separately, whether a code review is needed before the merge.
3. The CLI then tells you what is actually possible now. If it says **autonomy with checkpoints**, the agent may work between the named checkpoints but must stop before actions such as push, merge, or release when those actions require approval.
4. The default installation records who approved the work, but that record has no independently verifiable digital signature. For that reason, a request for full autonomy becomes autonomy with checkpoints. Full autonomy inside the agreed limits is available only when the system running the plugin verifies a signed approval for that exact delivery.

The names below are the technical labels stored in JSON and used by automation:

| What a person sees | Stored technical label | Meaning |
| --- | --- | --- |
| Supervised work | `supervised` | Ask before the governed phases and actions |
| Autonomy with checkpoints | `checkpointed` | Work independently inside the agreed boundary, stopping at the listed checkpoints |
| Full autonomy inside the agreed limits | `bounded-autonomous` | Continue inside one exact delivery boundary without routine prompts; never applies to another PR |
| Approval recorded for audit | `audit_only` | Attribution is stored, but identity was not independently verified |
| Signed approval verified | `host_verified` | A trusted host or CI signature matches this exact approval subject |

The available levels are `supervised`, `checkpointed`, and `bounded-autonomous`. A downstream record may narrow the selected level but can never widen it:

> effective autonomy = minimum of host, project, requirement, delivery, contract, capability, environment, and budget boundaries

```mermaid
flowchart LR
  H["Host and project cap"] --> E["Most restrictive effective level"]
  R["Requirement execution profile<br/>maximum autonomy"] --> E
  D["One explicit delivery profile<br/>PR or local release"] --> E
  C["Contract, capability,<br/>environment, and budget"] --> E
  E --> X["Exact per-delivery authorization"]
  X --> W["Agent works only inside<br/>this delivery unit"]
```

`bounded-autonomous` therefore means broad freedom only inside the displayed, hash-bound delivery unit. It is not permanent authority and it is never learned from the number of successful prior runs. For example:

```text
For PR-184 choose bounded-autonomous. You may implement, test, commit, push, and update
that PR on the displayed repository and branches. Do not merge the protected branch,
deploy remotely, use secrets, or write outside the approved paths. This choice expires
when PR-184 is merged, left ready for review, closed, or cancelled and does not apply to another PR.
```

A local release is a first-class delivery unit. Its profile must name the local root, allowed actions and write paths, smoke tests, their governed working directory, and a required rollback procedure. The smoke directory must be inside an allowed write path; it defaults to the only allowed write path and must be explicit when several are present. Local does not mean unrestricted: machine-global changes, writes outside the workspace, destructive actions, external access, remote deployment, and production access remain explicit exception boundaries.

The exact local root may be absent while a new delivery is only planned, proposed, approved, or started. Before `rollback.verify`, `data.migrate`, `data.rollback`, or `release.local` it must exist as a real, non-symlinked directory. Its creation is itself governed: request `build.local` first without confirmation; only if it reports `checkpoint_required`, show the exact decision and repeat with direct approval. The external builder may then create only that exact root, its approved children, and the artifact, after which `build.local` is completed with immutable evidence. The CLI never creates the directory, and an untracked `mkdir` is not a valid repair for a blocked release action. Passing `build.local` completion records a content manifest (paths, modes, sizes, SHA-256) of the approved write paths; `rollback.verify` and `release.local` then require the destination to match it, so a write path recreated with identical content is accepted while different content, a replaced root, or a symlink is refused. To update an existing release, copy it into an approved backup write path and install the new build while one `build.local` authorization is open, complete it, rehearse the rollback, and release; restore the backup and close as `rolled_back` if the smoke test fails.

Every new local release automatically includes the checkpointed `rollback.verify` action. It binds the exact local root, write paths, rollback procedure, and immutable rehearsal evidence. The CLI only observes and hashes that subject; it accepts no rollback command and executes no restore operation. Authorize `rollback.verify` with `--evidence`, then complete it with the same unchanged evidence. A passing receipt must predate `release.local` authorization, is referenced by the final release receipt, and is revalidated by the lifecycle gate. For a declared data migration it also binds the exact passing `data.rollback` receipt. Missing, tampered, or out-of-order evidence fails closed.

Reversible local data changes use the typed actions `data.migrate` and `data.rollback`; the pair is mandatory. The profile binds one existing regular data file, one or more exact logical scopes, immutable dry-run/preview evidence outside the mutable write paths, an exact backup file, and the rollback procedure. Both actions are always checkpoints. The CLI never accepts or runs a migration shell command: it authorizes the immutable subject, an external tool performs the exact operation, and the local-filesystem observer hashes the target and backup before and after completion. A rollback must prove a real target change back to the backup; a no-op cannot become verified evidence. Both `release.local` authorization and completion require the exact rollback receipt, its bound `rollback.verify`, and a later passing migration, so an incomplete sequence cannot close the delivery terminally. The lifecycle gate revalidates the same chain.

Delivery binding is one-way and hash-safe: reserve the planned profile ID in the requirement-bound story contract, approve that contract, then create the matching delivery profile against the immutable requirement, story, and contract hashes. The ID is not a profile hash or approval. Task start receives the profile and rejects drift; the approved contract is not rewritten to point back to it.

Each requested control has a concrete effect:

| Control | Simple example | Effect |
| --- | --- | --- |
| Action and subject | `output.link = docs/assessment.pdf` | Authorizes that action on that exact artifact, not every output |
| Paths | `write: docs/ and .sdlc/` | Writes elsewhere remain outside the tranche |
| External boundary | `no production, secrets, or external APIs` | Crossing one of those boundaries requires a new decision |
| Active time | `soft 45 min, hard 60 min` | Warn or stop based on measured active work, excluding user wait time |
| Steps | `soft 40, hard 60` | Aggregates main-agent and subagent execution steps |
| Tokens or cost | `200k tokens soft` or `EUR 5 hard` | Enforceability depends on the assurance of the measurement source |
| Completion reserve | `15%` | Protects capacity for verification and final delivery |
| Stop policy | `request extension, otherwise partial delivery` | Defines behavior instead of silently exceeding the approved budget |

In `audit_only` authority mode the CLI cannot independently prove the human actor, so effective autonomy is capped at `checkpointed`, including for a local-only release. `bounded-autonomous` requires an external host/CI to sign the exact delivery-profile approval subject with Ed25519, `authority_policy.mode: host_verified`, the matching public key in `authority_policy.trusted_host_keys`, and `--host-receipt-file` on approval. The CLI verifies that authority; it does not mint it itself. Merge to `main` or another protected branch and every production or remote deployment remain separate explicit decisions unless the exact action and target were displayed and authoritatively approved.

After task start, every state-changing delivery operation follows **authorize → execute exact operation → complete with immutable evidence**. Canonical PR actions include `repository.write`, `test.run`, `git.commit`, `git.push`, `pull_request.update`, and `pull_request.merge`; local actions are `build.local`, `test.run`, the mandatory non-executing `rollback.verify`, optional paired `data.migrate`/`data.rollback`, and `release.local`. At a checkpoint under `host_verified`, the external receipt must sign `autonomy.delivery.action.<canonical-action>` and the exact runtime/action-details subject; `audit_only` records explicit approval without claiming verified authority. The action receipt does not execute a Git/provider operation. The host or tool performs the exact recorded action, then completion binds its evidence and the locally observable boundary. Passing `pull_request.merge` or `release.local` completion creates the terminal close receipt automatically; other terminal outcomes use an explicitly approved manual close.

New delivery choices use `delivery-execution-profile:v2`. The profile records which registered observer verifies Git pushes, pull-request state, or the local filesystem boundary. That choice is part of the profile hash and cannot silently change between authorization and completion. The observer only checks the before/after state; it never pushes, merges, or releases. Historical v1 profiles keep their original bytes and hashes and use only the documented in-memory compatibility mapping.

Local smoke tests are stored as shell-free JSON argv arrays, for example `--smoke-test '["npm","run","smoke:local"]'`, and are executed from the exact governed `--smoke-cwd` at release completion in a supported read-only sandbox that denies external network access. macOS and Windows also deny loopback; Linux `bwrap` exposes only namespace-local loopback. A portable smoke command must therefore not bind a listener or connect to a service: API releases should exercise an exported handler in-process, while other releases can validate manifests, built files, or CLI output. Direct shells, indirect dispatchers, inline interpreter code, and ambiguous loader options are rejected. An explicit interpreted entrypoint must resolve inside an allowed artifact path; package managers may run only `test` or one reviewed `run <script>` from a real `package.json` in that exact directory, preventing fallback to the source project. Before any smoke command starts, a durable write-ahead attempt consumes the exact authorization; the v3 receipt binds the plugin build, sandbox, resolved launcher/runtime, explicit payload paths, environment, and pre-smoke artifact manifest. Completion records the unchanged post-smoke manifest, and later strict gates reject artifact drift or a missing attempt/integrity chain. The sandbox can read files available to the host account and is not a confidentiality or transitive-code-attestation boundary: the binding covers the explicit launcher, entrypoint, and artifact bytes, so reviewed project code must not import or execute ungoverned host paths. A failed or interrupted attempt cannot silently reuse the authorization. Successful local completion currently requires `/usr/bin/sandbox-exec` on macOS, `/usr/bin/bwrap` on Linux, or the AppContainer launcher on Windows 10 1809+ (Windows PowerShell in FullLanguage mode); other hosts, Linux without `bwrap` and Windows with PowerShell locked down fail closed before a `released` receipt is written, and `autonomy delivery propose --kind local_release` already stops on such a host with the available options (macOS, Linux with `bwrap`, the whole CLI inside WSL2, or a pull request). A push can be authorized only when every commit from the live remote base SHA to the exact head has one passing `git.commit` completion receipt, and every configured fetch/push URL of the selected remote resolves to the approved repository. For remote push and merge, authorization records a live pre-state and completion queries the exact Git remote or GitHub PR for the post-state. Those authenticated live observations are hash-bound, but they are not provider-signed offline attestations; preserve durable host/CI/provider evidence and do not overstate that boundary.

A custom limit is meaningful only if a configured source can measure it. A hard limit fails closed when its required exact, trusted coverage is unavailable.

### Standing approvals for repeated low-risk work

The default stays the same: every delivery asks for its own work brief approval, working-mode choice, and confirmations. For repetitive toil such as dependency bumps, retired-flag cleanup, or a mechanical migration, the user may instead approve a **standing approval** once: "from now on, approve this kind of delivery within these limits". It is bounded, revocable, and never created or widened without the user's explicit approval.

| Bound | Example |
| --- | --- |
| Kind of work | recipe `flag-cleanup` with a plain-language description, tied to approved requirements |
| Paths | project-relative prefixes or globs, such as `src/flags` and `docs` |
| Size per delivery | at most 10 changed files and 200 added plus removed lines |
| Destination | local release only, or a pull request created or updated but never merged, on one repository and only from branches under the standing approval's own prefix (never the base, shared, release, or production branches) |
| Code review | for a pull-request destination, `required` or `not-required` for every pull request it covers; a covered delivery does not ask the code review question again |
| Count and expiry | 5 deliveries until 1 November (capped by `standing_approval_policy.max_validity_days`) |
| Budget | optional USD 1.50 per delivery and USD 10.00 in total, measured from each delivery's metered cost; accepted only when a meter that reports delivery cost (CodeBurn or a trusted signed source) is configured, and a step whose cost is not freshly measured falls back to a normal confirmation |

Merge, production, deploy, data migrations, force-push, and deletions of tracked files outside the paths are never covered. A matching delivery passes `--standing-approval <id>` on `contract approve`, `autonomy delivery propose`, and `autonomy delivery approve`; approving it consumes one delivery slot atomically. Each delivery action is then confirmed by a derived approval that names the standing approval and its slot, but only after the CLI re-checks the expiry, revocation, delivery count, the bound project, configuration, policy, and requirement hashes, and the files changed since task start. Anything outside the bounds answers `checkpoint_required` with the reason, so the normal confirmation applies. Tests, secret scanning, review, smoke tests, gates, and the lifecycle-complete certificate all still run. `autonomy standing revoke` takes effect at once, including for deliveries in progress at their next step. `status`, `autonomy standing status`, and the Change Observatory list standing approvals, the deliveries that used them, the deliveries left, the expiry, and the cost spent against a budget, and `status` warns before expiry.

Only the user approves a standing approval, in their own terminal: the CLI refuses `autonomy standing approve` inside an agent's session, and the plugin's hooks (`hooks/hooks.json`, read by both Claude Code and Codex) stop the agent from running it or from changing the records directly. In a project that requires signed approvals (`host_verified`), the approval also needs the trusted host's Ed25519 receipt for that exact standing approval (`--host-receipt-file`): it binds the record hash, the decision, and the expiry, is kept inside the approval record, and is verified again at every covered step and by the strict gate, so a script that writes the records itself cannot approve one. Revoking accepts a receipt but never requires one, because it only removes authority. An `audit_only` project may add a receipt too, and the approval is then shown as signed by the trusted host. Used deliveries and revocations are also shared through the project's git remote, so every copy of the project, such as CI runners or containers, counts the same deliveries and sees a revocation at its next step; if the remote cannot be reached, nothing is covered and the normal confirmation applies (`standing_approval_policy.coordination`).

### Delegate approvals to the agent

Some commands accept only a person: `requirement approve` and `requirement supersede`, `breakdown approve`, `dependency approve`, `contract approve`, `autonomy delivery evidence supersede`, `story base acknowledge`, `story overlap confirm`, `output link` with a human decision, `story abandon`, `story supersede`, `autonomy delivery approve` and `baseline approve`. An agent that passes `--actor-type human` is still not a person, and that stays true. To let the agent run them, the person signs once an explicit, limited and revocable delegation from their own terminal:

```bash
mpsf autonomy delegation grant --id DLG-TRAVELOPS-001 --scope project --actions breakdown.approve,dependency.approve,evidence.supersede,base.acknowledge,overlap.confirm,output.link,contract.approve,requirement.approve,requirement.supersede --until 30d --summary "L'agente applica queste approvazioni per 30 giorni" --actor-type human --approval-source explicit-user
```

- `--scope` is `project`, `requirement:<REQ-id>` or `story:<ST-id>`; `--actions` lists named action classes (`requirement.approve`, `requirement.supersede`, `breakdown.approve`, `dependency.approve`, `contract.approve`, `evidence.supersede`, `base.acknowledge`, `overlap.confirm`, `output.link`, `story.abandon`, `story.supersede`, `delivery.policy`, `delivery.approve`, `baseline.approve`); `--until` is a date, a date-time or a duration (`30d`, `12h`, `2w`), at most 90 days (`delegation_policy.max_validity_days`).
- The grant uses the same authority as every other person-only approval: refused inside an agent session (and by the agent hook), `--actor-type human --approval-source explicit-user`, and the trusted host receipt (`--host-receipt-file`) where `authority_policy.mode` is `host_verified`. It writes `.sdlc/autonomy/delegations/<id>/delegation.json` with its hash, the grant receipt, and the person's identity (git user, host). The agent cannot write or edit those records.
- The agent then runs the command with `--actor-type agent --approval-source delegated --delegation DLG-TRAVELOPS-001`. The command checks that the delegation exists, was approved by a person, is not expired or revoked, covers that action and that scope, and that its hash is intact; otherwise it refuses with the reason. The record says "approvato dall'agente per delega DLG-x di <persona>" with a validity-at-use receipt under `uses/`; the trace, status, the strict gate and the Change Observatory show it as an agent approval under delegation, never as a direct approval by a person.
- `delivery.policy` carries the person's standing answers to the questions every new pull-request delivery asks, signed with the grant: `--delivery-policy code-review=not-required,merge=automatic` (`code-review` is `required|not-required`, `merge` is `manual|after-confirmation|automatic`; the grant refuses `delivery.policy` without it, and `--delivery-policy` without `delivery.policy`). `autonomy delivery propose` (and `story prepare --level`, which proposes the delivery) with `--approval-source delegated --delegation <DLG-id>` uses those values as the person's answer and records them as "scelta di <persona> per delega DLG-x" (`source: delegation`) in the hash-bound profile. It refuses a delegation that is missing, expired, revoked, altered or does not cover `delivery.policy`, and an explicit `--code-review`/`--merge` for a question the delegation already answers. Without the delegation the usual question stays, and the answer is never inferred from earlier stories. The merge itself still runs only through the governed chain, after every other gate.
- `autonomy delegation list` shows each delegation (active, expiring, expired, revoked) and its uses; `status` and `gate check` list the delegations in use and those expiring. `autonomy delegation revoke --id <id> --reason "<why>" --actor-type human --approval-source explicit-user` ends it at once, again only from the person's terminal.

Never delegable, even when listed (the grant refuses them with a clear error): pushing or merging a protected branch outside the governed delivery chain, the `AGENTIC_SDLC_ALLOW_UNGOVERNED_*` escape variables, deploys and production access, secrets and credentials, and installs. These keep their own person-only rules, because each one either leaves the governed chain or acts outside the project where a recorded approval cannot undo it.

## Parallel Work Across Computers

Stories are the unit of parallel work: one story, one claim, one branch, one pull request. A claim file only coordinates processes on one checkout, so when the project has a git remote, `story claim` first records the claim on that remote with a push the remote accepts only if no one claimed that story first. Of two computers claiming the same story at the same moment, exactly one wins; the other is told who holds it, on which branch, and since when, and nothing is written. Releasing (`story release`, or `--release-claim` on `story complete-step` and `story prepare-handoff`) frees the story for everyone.

```bash
mpsf orchestrate status --json        # free, claimed (with holder and branch), stale, and blocked stories from every computer
mpsf story claim --id ST-002 --agent alice --branch feature/ST-002
mpsf story release --id ST-002 --reason "Merged"
```

The split is simple: publish the approved specs and story breakdown, let every computer pull them, then each runs `orchestrate status`, claims one available story, works on its branch, and opens its pull request. Claiming is the start of work, so if the remote cannot be reached the claim is refused; set `orchestration_policy.coordination.mode` to `local_only` for a project worked on from one computer only (`auto`, the default, shares claims when the remote exists; `required` refuses without it). Taking over a story held elsewhere is a person's decision, made in their own terminal with `--force` and a `--reason` that the previous holder sees. See [Parallel Work Model](docs/architecture.md#several-computers) for the step-by-step guide.

### Computers on different plugin versions

Records an older plugin would misread declare the plugin version they need: a project that uses such a feature keeps a small file under `.sdlc/compatibility/` (one per feature, identical on every computer, so merges never conflict), and a shared claim record carries `minimum_plugin_version`. A computer on an older version then refuses commands that change the project, keeps read-only commands working with a warning, and shows the update command (`claude plugin marketplace update aantenore && claude plugin update mpsf@aantenore`, then `/reload-plugins`) in `status`, `doctor`, and at session start. Records are never migrated; derived data such as the local cache is rebuilt when it was written by another plugin version. Features and their versions are listed in `config/plugin-compatibility.json`.

### Working without messaging

Messaging between computers is optional and only notifies. Claims, waits, delegations and records publication never depend on it. Pick the provider with `AGENTIC_SDLC_MESSAGING_PROVIDER` (`git` keeps the channel in refs on the project's own remote and is what `message setup` picks for a new channel, `github` uses an issue and is the fallback when nothing is set, `local` uses a folder, `none` turns it off) or, for the whole team, with `host_policy.adapters.messaging` in `.sdlc/config.json`:

```json
{ "host_policy": { "adapters": { "messaging": { "provider": "none" } } } }
```

Records can also live in plain files instead of git (`"records": { "provider": "local-fs" }`); a store that cannot guarantee immutable history cannot certify a story as lifecycle-complete. See [Adapters and roles](docs/adapters-and-roles.md) and [Messages between computers](docs/messaging.md).

### Coordinator role

With several computers, one can be named coordinator: it merges pull requests one at a time, publishes records, frees abandoned claims, settles expired waits and keeps the base branch green (stories are not assigned: every computer claims its own), while the others develop up to the pull request. Configure it under `host_policy.roles.coordinator` (`hosts`, `lease_minutes`, `fallback`: `everyone`, `next_host` or `hold`, and optionally `reserved_actions`). With that section, a reserved action (by default merging a pull request and refreshing the baseline) is refused on a computer that does not hold the coordinator lease; without it, roles are assigned automatically among the computers alive on the remote and nothing is refused. Details in [Adapters and roles](docs/adapters-and-roles.md#coordinator-role).

## Native Codex Metering Versus Exact Metering

The bundled `codex-session` adapter reads only the exact task's local
`token_count` events. It is direct and authentication-free, but not
provider-signed billing evidence and cannot by itself guarantee a hard stop.

```mermaid
flowchart TD
  A["Choose a token or cost limit"] --> B{"Must it enforce a hard stop?"}
  B -- "No: warning or forecast" --> C["Local Codex token_count<br/>estimated + advisory_observed"]
  C --> D["Store immutable baseline,<br/>incremental deltas, and receipts"]
  B -- "Yes" --> E{"Trusted signed adapter<br/>covers this exact metric?"}
  E -- "Yes" --> F["Exact cumulative receipts<br/>may satisfy the hard gate"]
  E -- "No" --> G["Fail closed:<br/>do not claim hard enforcement"]
```

| Source | Best use | Assurance | Can satisfy an exact hard limit? |
| --- | --- | --- | --- |
| **Native Codex session meter** | Exact-task token/call visibility and soft-limit warnings; cost unavailable | `estimated` / `advisory_observed` | **No**. A mapped hard metric records the evidence but stops with `metering_violation` |
| **Trusted runtime/provider adapter** | Financial or operational enforcement | Signed, identity-bound, cumulative exact receipts | **Yes**, only for the explicitly trusted metrics and approved pricing reference |

After proposal approval, capture the exact task baseline **before** `apply`.
`CODEX_THREAD_ID` is supplied by the Codex host; outside the host, pass
`--thread-id` explicitly:

```bash
node bin/mpsf.mjs budget meter start \
  --root /path/to/project \
  --proposal ASSESSMENT-001
```

During execution or before completion, record the incremental usage since that baseline:

```bash
node bin/mpsf.mjs budget meter record \
  --root /path/to/project \
  --proposal ASSESSMENT-001
```

The adapter binds the task ID, session identity, project `cwd`, counters, and
source event into immutable snapshots and monotonic deltas. It stores no prompt
or response body, executes no shell, and calls no web or authenticated API.
RTK and Caveman savings affect the next real measured total; the plugin never
deducts synthetic savings from usage. CodeBurn remains a disabled, opt-in
legacy adapter for existing projects. Full details are in
[Native Codex Session Metering](docs/codex-session-metering.md) and
[Autonomy, Limits, and Metering](docs/limits-and-metering.md).

Deliveries are measured too: `status`, `autonomy delivery status`, and the
Change Observatory show each delivery's lead time (proposed, approved, work
started, first action, released or ready for review), the time it waited for a
person, and the cost and tokens recorded against it with
`budget usage record --delivery` or `budget meter record --delivery`; a delivery
with nothing recorded reads "not measured".

## Context Packs And Token Saving

An agent working on one story should not read whole records. `mpsf context pack --story <id> [--phase <phase>] [--budget <tokens>]` prints a deterministic summary for the phase (accepted criteria, contract essentials, decisions, dependencies, write scope with a file index, recent tests and gates, waits, next step); a cut section ends with a reference that `mpsf context get <ref>` expands. Inside an agent session commands also print only the outcome, next step, ids and exact error (`--verbose` for the full text), `--json` returns the agent profile (`--json-profile full` for the complete payload), and hooks stop repeating themselves. Budgets are in `host_policy.context`. See [Token efficiency](docs/token-efficiency.md#context-packs-and-compact-output).

## Windows

The CLI, hooks, messaging, claims and pull-request delivery run on Windows. A local release runs its smoke test in a per-run AppContainer (no network, no loopback, read-only); where PowerShell is locked down the proposal stops early and lists the options (the CLI inside WSL2, or a pull request). See [Portable installation](docs/portable-install.md#windows).

## RTK Context Optimization

RTK is integrated through a shell-free gateway rather than as a budget meter.
The bundled Caveman response skill is the second optimization layer. RTK
reduces command output entering model context; Caveman reduces non-critical
user-facing prose while retaining exact technical content. Approvals, security
warnings, commands, contracts, and durable artifacts retain normal clarity.
Inspect availability, run a supported noisy command, or capture an explicit
manual diagnostic with:

```bash
node bin/mpsf.mjs optimization status --root /path/to/project --proposal ASSESSMENT-001 --json
node bin/mpsf.mjs optimization run --root /path/to/project --proposal ASSESSMENT-001 --command-json '["npm","test"]'
node bin/mpsf.mjs optimization capture --root /path/to/project --proposal ASSESSMENT-001 --phase manual --json
```

Use `optimization run --exact` when unfiltered, complete output is required.
It bypasses RTK but never widens the allowlist or disables the anti-helper
boundary: native `rg` runs with config loading disabled, while native Git
diff/log/show runs with external diff and text-conversion drivers disabled. The
gateway accepts only fixed test commands, execution-safe read-only Git commands,
and `rg` searches without external preprocessors. Mutations and unknown commands are rejected. For an
active assessment, `--proposal` is mandatory and the command starts only when
that proposal's cost gate allows new work. The assessment
lifecycle automatically captures comparable observations at apply, budget
checkpoints, and completion, so manual capture is for diagnostics—not for
manufacturing lifecycle evidence.

RTK's project-cumulative counters may include concurrent activity in the same
checkout. The proposal delta is therefore reported separately and remains an
estimate of command output avoided, not provider usage or billing truth. RTK
always contributes zero budget credit: `usage_adjustment_applied` is `0`, the
budget evaluator continues to aggregate only usage receipts, and soft limits,
completion reserve, hard limits, and metering violations remain sovereign.
Validated observation references may appear in the completion manifest and its
release-gate evidence without changing `budget_decision`.

The standard `rtk` executable is resolved once from `PATH`, canonicalized, and
executed by that absolute path. A first PATH candidate located in the project
root (including a symlink whose real target is there), a custom provider
executable, or prefix argv is not run by doctor, status, lifecycle hooks, or the
gateway unless that exact invocation includes
`--trust-custom-rtk-command` after review.

## Canonical Output Formats

Requested formats are stored as canonical delivery metadata; a Markdown file renamed to another extension is rejected.

| Canonical format | Accepted aliases | Extension | Media type | Generator/verifier |
| --- | --- | --- | --- | --- |
| `markdown` | `md`, `markdown` | `.md` | `text/markdown` | Native checks |
| `docx` | `word`, `doc`, `docx` | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `documents` |
| `xlsx` | `excel`, `spreadsheet`, `workbook`, `xlsx` | `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `spreadsheets` |
| `pdf` | `pdf` | `.pdf` | `application/pdf` | `pdf` |
| `pptx` | `powerpoint`, `slides`, `pptx` | `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `presentations` |
| `html` | `html` | `.html` | `text/html` | Native generation plus rendered validation |
| `json` | `json` | `.json` | `application/json` | Native parse validation |
| `csv` | `csv` | `.csv` | `text/csv` | `spreadsheets` |
| `custom` | `custom` | None (no fixed extension) | `application/octet-stream` | Native checks (text, no binary NUL bytes) |

Assessment delivery is either `artifact` or `artifact-plus-chat-summary`; the latter is the default.

## Generation And Layered Verification Receipts

Every non-native artifact has an `artifact_generator_receipt` for the exact delivered hash. Verification then reports `container_verified`, `content_verified`, and `render_verified` separately, plus optional independent verification. A structurally valid container is never described as semantically or visually verified.

DOCX, XLSX, PDF, PPTX, and HTML outputs also require render or visual-check evidence. The evidence must be a real project file outside `.sdlc/cache/` and `.sdlc/indexes/`, and it must be passed when the artifact is linked:

```bash
node bin/mpsf.mjs output link \
  --story ST-INITIAL-ASSESSMENT \
  --type technical-analysis \
  --artifact docs/technical-assessment.pdf \
  --template technical-analysis-v1 \
  --mode new \
  --requirement REQ-INITIAL-ASSESSMENT \
  --authorization <authorization-id-from-assessment-proposal-approve> \
  --receipt-file .sdlc/receipts/generation/GEN-ST-INITIAL-ASSESSMENT.json \
  --render-evidence .sdlc/tests/ST-INITIAL-ASSESSMENT-render.png
```

`--authorization` is the exact proposal-bound ID returned by checkpoint 2; linking consumes its dedicated `output.link` action/subject pair and persists a usage receipt. `--receipt-file` identifies the real generator; `--render-evidence` is separate render or visual proof, not functional or test evidence. The older `--evidence` spelling remains accepted here as a compatibility alias. Inspect the persisted output link and layered receipt with:

```bash
node bin/mpsf.mjs output status \
  --story ST-INITIAL-ASSESSMENT \
  --type technical-analysis \
  --json
```

The final chat response reports the assessment verdict, major risks, recommendations, artifact path, verification performed, limitations, and open decisions.

## Install

Use a source checkout that is separate from the generated personal-plugin directory:

```bash
cd /path/to/mpsf
python3 scripts/install-personal-marketplace-v2.py check
python3 scripts/install-personal-marketplace-v2.py plan --json
python3 scripts/install-personal-marketplace-v2.py apply --plan-hash <plan_hash-from-plan> --json
# Execute the exact candidate_registration argv/environment returned by apply.
# Default target example only:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

Installer V2 is canonical. Use its returned `restore` command instead of
`confirm` if validation or plugin registration fails. After confirmation, the
token-efficiency autoconfiguration verifies the bundled Caveman/native-meter
components and configures an existing verified RTK binary. It does not use or
install CodeBurn.

On systems where Python 3 is exposed as `python` or `py -3`, use that launcher for the same script. Start a new Codex task after installation so the app reloads plugin skills and agent cards.

`check` and `plan` are read-only. `apply` accepts only the exact current plan
hash, rechecks it under a lock, stages and byte-verifies the package, then
updates `~/plugins/agentic-sdlc-codex-plugin` and the matching entry in
`~/.agents/plugins/marketplace.json` while retaining byte-exact recovery data.
`validate` proves that state is still unchanged; `confirm` removes the retained
copy only after the official candidate list/cache matches, while `restore`
puts the prior local bytes back and uses the official Codex add/remove command
required by the installed-or-absent state captured during `apply`. A failed or
missing Codex command leaves a retryable partial state instead of claiming a
completed rollback. The installer refuses unsafe destinations instead of
traversing or replacing a symlink, Windows junction/reparse point, Git
checkout, source checkout, unmanaged directory, or linked Codex cache
ancestor. Running the script without a mode is the same as `plan`; it never
installs implicitly.

## Update

Update the source checkout, rerun the staging installer, and add the plugin again. The current Codex CLI has no dedicated plugin-update subcommand; re-adding refreshes the installed cache, including when the version is unchanged.

```bash
cd /path/to/mpsf
python3 scripts/install-personal-marketplace-v2.py plan --json
python3 scripts/install-personal-marketplace-v2.py apply --plan-hash <plan_hash-from-plan> --json
# Execute the exact candidate_registration argv/environment returned by apply.
# Default target example only:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

The last step is the same post-confirm autoconfiguration used for a fresh
install. It re-verifies the newly staged Caveman/native-meter files and the
currently selected RTK executable before refreshing global RTK guidance.

Do not edit the generated tree under `~/plugins` directly. Start a new Codex task after the refresh.

## Uninstall

Remove the installed plugin and cache with the supported Codex command:

```bash
codex plugin remove agentic-sdlc-codex-plugin@personal
codex plugin list --json
```

This intentionally leaves the source checkout, generated staging directory, and personal marketplace entry in place. For permanent local cleanup, remove only `~/plugins/agentic-sdlc-codex-plugin` and only the matching JSON entry from `~/.agents/plugins/marketplace.json`; preserve every unrelated plugin entry. Do not remove the shared `personal` marketplace source just to uninstall this plugin.

Plugin removal also leaves RTK's independent global Codex instructions in
place. If no other project should use them, remove and verify them explicitly:

```bash
rtk init -g --codex --uninstall
rtk init -g --codex --show
```

## Diagnose An Install

Run the built-in doctor from the source checkout. The npm script and direct CLI form execute the same checks; without `--root` it checks the project in the current directory, and `--root` points it at another project's KB and output registry:

```bash
npm run doctor
npm run doctor -- --root /path/to/target-project --json
node bin/mpsf.mjs doctor --root /path/to/target-project --json
codex plugin list --available --json
npm run check
npm pack --dry-run --json
```

Doctor checks the Node runtime, version consistency, build identity, the effective configuration, the first assessment prompt, the core and assessment skills, the assessment agent card and preset, the token-efficiency components (RTK adapter and provider, Caveman skill, agent card and provider, Codex session meter, autoconfiguration script), the context-optimization and project-bootstrap schemas, the Change Observatory entry point, launcher, skill, agent card and UI files, and the project records when `.sdlc/` exists. A failed check returns a non-zero exit code.

Exit codes are categorized so a pipeline can tell a rejected request (`1`) from a bad invocation (`2`), a write refused by the mutation guard (`3`), a broken installation (`4`), an internal failure (`70`), and a message that `message send` kept in the local outbox for later sending (`75`, not an error; do not resend). See [Self-service CLI](docs/self-service-cli.md#read-the-exit-code-in-a-pipeline).

For maintainer validation when the Codex system validators are available:

```bash
uv run --with pyyaml python /path/to/plugin-creator/scripts/validate_plugin.py .
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/agentic-sdlc
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/agentic-sdlc-assessment
```

If the plugin is absent or shows an older version, rerun the installer and `codex plugin add`, confirm the result with `codex plugin list --json`, then open a new Codex task. See [Portable Codex Install](docs/portable-install.md) for the full troubleshooting matrix.

## Derived Verification

Requirements and stories get implicit verification criteria without anyone writing them. `requirement propose`, `requirement revise` and `story create` read the write scope (and integrations) and add `derived_acceptance` entries (`source: "derived"`, `rule_id`, `priority: "secondary"`) next to the explicit `acceptance`, which is never changed and always wins. Default rules: automated tests of the touched units (always); an end-to-end user-flow test plus a basic accessibility check when the scope touches UI (`apps/web`, `src/app`, `pages`, `components`, `*.tsx` ...); integration or contract tests for API paths or declared integrations; executable documented steps for docs and demos. A rule is skipped, and reported under `derived_verification.covered_by_explicit`, when an explicit criterion already covers it. `--no-derived-verification` turns derivation off for one record and is recorded in it.

The policy is data, not code: the default is `templates/verification-policy.json` and a project overrides it with a `verification_policy` object in `.sdlc/config.json` (`enabled`, `enforce`, `backfill_enforce`, and `rules` merged by id; `"enabled": false` drops a rule, a new id adds one, `when.write_paths` takes path or glob patterns). Output of `requirement propose` and `story create` carries `assistant_message` with the derived list, and `next` shows the pending ids of a claimed story.

The strict gate (story in validation, and `--lifecycle-complete`) looks for a passing `test record` per derived criterion: it must name the id (`--acceptance DV-ui-e2e`) or its command, framework or summary must match the rule's `evidence_patterns`. `enforce` is stored per record: `block` for new records (default), `warn` for backfilled ones (`backfill_enforce`). Existing open stories are filled in with `story derive-verification --all-open` (or `--id`): idempotent and additive; a story already bound by a contract, task start, claim or delivery profile is only reported, because its record hash is what those bind, and it is not gated.

## Release

From a working branch with the changes already committed:

```bash
npm run release -- [--version X.Y.Z] [--title "..."] [--body "..."] [--no-update]
```

The script aligns the branch with `origin/main`, bumps the version to the next minor (the higher of `origin/main` and the `vX.Y.Z` tags) unless `--version` is given, writes it into the manifests, README and `docs/`, commits `Versione X.Y.Z`, pushes the branch (never with force), opens the PR and merges it at once with a merge commit. Without `--no-update` it also updates the marketplace and the installed plugins with `claude plugin`. It needs `git`, an authenticated `gh` and a clean working tree.

Rules for fixes:

- One small fix at a time, one release per fix: new requests become a separate release instead of widening the current one.
- Run only the tests for the files you touched (about a minute at most), never full suites or slow before/after checks: the real check happens on the project with the released version.
- Release right away, even in pieces; before every release run `git fetch` and align with `origin/main`.
- No plugin command may take more than 10 minutes: if one does, treat it as a performance defect (sample the child git processes, find the repeated call, then read in bulk or cache).

## Safety Boundaries

- Repository application evidence is read-only unless the approved proposal names a write; proposed `.sdlc/` workflow records may be persisted before checkpoint 2.
- Normal writes are limited to the agreed artifact and canonical `.sdlc/` records.
- New installs, external systems, secrets, production access, destructive actions, and unrelated writes require an explicit decision.
- Every assessment uses an explicit story before its contract or output is persisted.
- Every `requirement:v2` has an approved execution profile that is a ceiling, not an executable grant.
- Every pull request and local release has its own explicit delivery execution profile; a prior PR choice is never reused.
- A local release records its target root, smoke tests, governed smoke working directory, rollback, write paths, and allowed actions.
- Protected-branch merge, remote deployment, and production access remain explicit exception decisions.
- A story is claimed on the project's git remote before any work starts, so two computers never hold the same story; an unreachable remote refuses the claim unless the project chose `local_only`.
- A free-text scope or `actor-type human` flag is not authority. Checkpoint 2 binds a host/CI receipt and content authorization to the proposal hash; every covered use stores a validity-at-use receipt.
- The approved budget aggregates main-agent and subagent usage, preserves a completion reserve, and changes only through a versioned amendment.
- Cache and indexes are derived data and never count as canonical evidence.

## Advanced CLI

The CLI remains available for automation and advanced project workflows:

```bash
node bin/mpsf.mjs --help
node bin/mpsf.mjs observe --root /path/to/project --no-open --json
node bin/mpsf.mjs doctor --root /path/to/project --json
node bin/mpsf.mjs optimization status --root /path/to/project --proposal ASSESSMENT-001 --json
node bin/mpsf.mjs optimization run --root /path/to/project --command-json '["npm","test"]'
node bin/mpsf.mjs optimization capture --root /path/to/project --proposal ASSESSMENT-001 --phase manual --json
node bin/mpsf.mjs status --root /path/to/project
node bin/mpsf.mjs approval requests --root /path/to/project --json
node bin/mpsf.mjs capability inventory --root /path/to/project --json
node bin/mpsf.mjs capability recommend --root /path/to/project --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory
node bin/mpsf.mjs assessment proposal status --root /path/to/project --id ASSESSMENT-001 --json
node bin/mpsf.mjs budget meter start --root /path/to/project --proposal ASSESSMENT-001
node bin/mpsf.mjs budget meter record --root /path/to/project --proposal ASSESSMENT-001
node bin/mpsf.mjs budget status --root /path/to/project --proposal ASSESSMENT-001 --json
node bin/mpsf.mjs autonomy delivery checks --root /path/to/project --id AUT-PR-184
node bin/mpsf.mjs budget usage record --root /path/to/project --delivery AUT-PR-184 --cost-amount 0.42 --currency USD
node bin/mpsf.mjs budget status --root /path/to/project --delivery AUT-PR-184
node bin/mpsf.mjs gate check --root /path/to/project --scope release-manifest --release-manifest RELEASE-ASSESSMENT-001 --strict --json
node bin/mpsf.mjs migration active --root /path/to/project --release-manifest RELEASE-ASSESSMENT-001
node bin/mpsf.mjs migration active --root /path/to/project --release-manifest RELEASE-ASSESSMENT-001 --apply
node bin/mpsf.mjs migration identity --root /path/to/project --identity-map-json '{"source":{"email":"old@example.invalid"},"target":{"email":"new@example.test","name":"Current User"}}'
node bin/mpsf.mjs migration identity --root /path/to/project --identity-map-json '{"source":{"email":"old@example.invalid"},"target":{"email":"new@example.test","name":"Current User"}}' --apply --plan-hash <preview-plan-hash>
node bin/mpsf.mjs migration identity --root /path/to/project --recover --recovery-nonce <nonce-from-lock> --plan-hash <hash-from-lock>
```

Natural-language interpretation stays in Codex. The CLI accepts canonical structured intent and performs deterministic state, format, authorization, and evidence checks.

`autonomy delivery checks` prints the checks that were actually recorded for one pull-request delivery as a Markdown table for the pull-request description: test and smoke runs, the secret scan, the code review gate, the strict and lifecycle-complete gate receipts, the standing approval the delivery used, and its budget decision. Each row is `[PASS]`, `[FAIL]`, or `[NOT RUN]`; nothing is re-run, a check nobody recorded is never shown as a pass, and recorded commands go through the privacy redaction before printing. `--format json` prints the same facts as deterministic JSON. See [How It Works](docs/how-it-works.md#the-pull-request-description-lists-what-was-recorded).

Installed tools are discovered, not typed in. `capability inventory` is a read-only listing of the skills, commands, plugins, and MCP servers already installed for the user and the project, read from the well-known local locations of both supported agent hosts (and any location added in `capability_discovery_policy.inventory`). It keeps only names, one-line descriptions, plugin versions, and a server's transport type, never server arguments, environment, headers, or URLs, and it makes no network call. `capability recommend --from-inventory` proposes only the installed entries that name a technology declared by the approved evidence, and `task start` and `status` mention such matches while a story has no tool recommendation. Nothing is ever approved, bound, or installed automatically. See [Architecture](docs/architecture.md#capability-discovery-layer).

The default budget meter is bundled. It reads cumulative `token_count` events
from the exact local Codex task, selected by `CODEX_THREAD_ID`, and advances an
incremental monotonic cursor. It is always
`estimated`/`advisory_observed`, never signed or exact; cost remains
unavailable. CodeBurn is optional legacy compatibility, disabled by default,
and never part of autoconfiguration.

RTK 0.43+ is also optional and separately installed. `optimization run` routes
only allowlisted command profiles without a shell; `--exact` bypasses filtering
without allowing arbitrary command vectors. Ripgrep preprocessors, Git external
diff/textconv drivers, and Git signature-verification helpers remain disabled.
Its savings telemetry is advisory, project-scoped, and always receives zero
budget credit. See [Token Efficiency](docs/token-efficiency.md).

`migration active` is deliberately dry-run first. It validates the immutable records referenced by one exact release manifest, upgrades only missing configuration defaults when `--apply` is present, and never rewrites an approved record. Evidence referenced only by older valid releases remains where it is and is listed in an `archive-record:v1`; this logical archive changes gate scope, not filesystem location. Use the separate `archive closed --apply` workflow only when old closed reports or trace compactions must physically move.

`migration identity` is a separate, exceptional lineage repair for correcting an identity already embedded in `.sdlc`. It is also dry-run first. Before planning any rewrite it schema- and hash-validates legacy plus canonical authorization v1/v2 records, their action-subject bindings, revocations, usage receipts, prior migration receipts, and byte-exact canonical file references. It then computes the transitive subject, scope, authorization, revocation, receipt, and file-reference changes, and refuses unsupported non-JSON records, stale supported file references, opaque receipts, or any signed/attested envelope affected directly or through a dependent hash. Signed evidence must be reissued with its original authority; the migration never invents a replacement signature. The preview emits a deterministic `plan_hash`; `--apply` requires that exact hash and refuses any canonical snapshot drift. Apply uses an exclusive no-auto-reclaim lock, prepares the complete post-state—including rebuilt cache and indexes—in a same-filesystem shadow tree, verifies it, records intent in a hash-checked monotonic journal, and activates it with a directory swap. A caught failure restores the byte-exact prior tree. An interrupted process requires authenticated `--recover` with the nonce and plan hash from the verified lock; recovery rolls back before the durable commit point and only finalizes after it. Other CLI commands remain blocked while that lock exists, and concurrent recovery is claimed separately. The immutable receipt records the reviewed plan hash, source and target digests, and before/after lineage hashes without storing the source email in clear text. Directory `fsync` is used where supported, but resilience to host or power loss still depends on the filesystem and platform.

## Repository Layout

```text
.claude-plugin/plugin.json                   Claude Code plugin manifest
.claude-plugin/marketplace.json              Claude Code marketplace entry for this repository
.codex-plugin/plugin.json                    Codex plugin metadata and starter prompts
commands/                                    Claude Code slash commands (one per starter intent)
assets/                                      Plugin artwork
bin/mpsf.mjs                         CLI entry point: main, command registry, observatory launcher
hooks/                                       Host hooks (hooks.json, guard) for both supported hosts
config/                                      Plugin defaults: feature compatibility, context, waits, release policy
docs/agent-interactions.md                   Two-checkpoint assessment interaction
docs/portable-install.md                     Install and recovery guide
schemas/                                     Canonical data contracts
lib/engine/                                  Command implementations and everything with effects
lib/lifecycle/                               Pure lifecycle rules: validators, normalizers, decisions
lib/runtime/host.mjs                         The one I/O seam: file system, processes, clock, randomness
lib/cli/                                     Command catalog, dispatch, and help
lib/adapters/                                Messaging and record store ports
lib/messaging/                               Messages between computers
lib/context/                                 Context pack/get and compact output
lib/host-hooks/                              Hook guard, injection budget, trusted remotes
lib/delivery/                                Local smoke providers
lib/                                         Proposal, authorization, budget, and workflow primitives
lib/<domain>/                                Other modules: governance/, observability/, release/, ci/, change-observatory/
lib/codex-session-metering-adapter.mjs       Native exact-task advisory usage meter
skills/agentic-sdlc/                         Core project workflow skill
skills/agentic-sdlc-assessment/              Guided assessment skill
skills/agentic-sdlc-assessment/agents/       Assessment agent card
skills/change-observatory/                    Installed visual-lineage launcher skill
skills/caveman/                              Vendored adaptive response-compression skill
scripts/autoconfigure-token-efficiency.py    Post-install/update RTK+Caveman setup check
templates/                                   Reusable artifact templates
ui/change-observatory/                        Bundled build-free lineage application
```

More detail: [Assessment Interactions](docs/agent-interactions.md), [Change Observatory](docs/change-observatory.md), [Claude Code Installation](docs/claude-code-install.md), and [Portable Codex Install](docs/portable-install.md).
