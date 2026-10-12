# Pluggable messaging and record store

Status: phases 1 (0.147.0) and 2 implemented; phases 3-4 planned. The operational records already have a state-branch store (`sdlc-state`, see ../adapters-and-roles.md).

## Goal

Make the plugin independent of two choices that today are fixed:

1. **Messaging** (coordination notices between computers): today one GitHub issue, one comment per message, through the `gh` CLI.
2. **Where the records live** (the knowledge base: stories, contracts, traces, gates, receipts, claims, waits): today the `.sdlc/` folder in git, plus create-only refs under `refs/agentic-sdlc/*` on the project's remote, published to the base branch with `story publish-records`.

Some teams want team chat for messaging and an issue tracker, a wiki or a database for the records, possibly with no `.sdlc/` folder at all. The core must stay vendor-neutral: it talks to two ports, adapters live behind them, and a gate never trusts an adapter by name, only by the guarantees it declares.

Two rules frame everything below:

- **Messaging is optional and only notifies.** It is never a source of truth, never approves, claims or skips anything, and never blocks an action. Every flow must work with no messaging at all (`none` adapter).
- **Coordination state lives in the record store.** Claims, waits, delegations, reviews, standing approvals, coordinator leases: all shared through the store's create-only shared state, never through messages.

## 1. Current coupling inventory

### 1.1 Messaging

| Where | What it does | Coupling |
|---|---|---|
| `lib/messaging/providers/github.mjs` | channel issue find/create, comment publish/poll, `gh api` calls, `whoami` | GitHub only, behind an informal provider object |
| `lib/messaging/config.mjs` | settings: env, per-clone file in `<git-common-dir>/agentic-sdlc/`, committed `.sdlc/messaging.json` | repo/issue fields are GitHub-shaped |
| `lib/messaging/commands.mjs` | `message send/read/listen/setup/status/who/identity/outbox` | provider map was hard-wired to GitHub |
| `lib/messaging/outbox.mjs`, `cursor.mjs` | retry queue, read cursor `<time>\|<numeric id>` | assumes numeric growing ids (kept as a port requirement) |
| `lib/messaging/auto.mjs`, `attention.mjs`, `presence.mjs`, `join.mjs` | automatic notices, unread digest, presence, channel handshake | go through `resolveProvider` |
| `lib/host-hooks/watch.mjs`, `keep-going.mjs` | background listening, outbox notice, pending questions | through the provider map |
| `lib/change-observatory/now-panel.mjs` | messaging snapshot in the observatory | through the provider map |
| `bin/agentic-sdlc.mjs` | post-command automatic notices (`eventFacts` -> `sendAutoAlert`), `story prepare` announcements | best effort |
| `lib/engine/story-sync.mjs`, `story-close.mjs`, `test-triage.mjs` | `sendAutoAlert` on publication, closure, triage | best effort |
| `lib/engine/story.mjs`, `delivery.mjs` | import `hostLabel` from messaging | host identity lives in the messaging module |

### 1.2 Records and shared state

| Where | What | Coupling |
|---|---|---|
| `context.sdlcRoot` (66 modules use `.sdlc` paths; heaviest: `engine/migration.mjs`, `engine/story.mjs`, `identity-migration.mjs`, `engine/workflow.mjs`, `engine/storage.mjs`) | every record read/write by file path | filesystem layout is the API |
| `lib/trace-integrity.mjs` | hash chain + checkpoint per trace file (`traces/.integrity/*.checkpoint.json`) | file based, generic enough to reuse |
| `lib/engine/shared-refs.mjs` + owners | create-only refs on the remote: `claims`, `waits`, `wait-registry`, `reviews`, `standing`, `commits`, `baseline-refresh` (`refs/agentic-sdlc/*`, tracking copies under `refs/agentic-sdlc-shared/*`, local-only under `refs/agentic-sdlc-local/*`) | git remote |
| `lib/engine/story-records-publish.mjs`, `records-commit.mjs`, `story-sync.mjs` | publication of a story's records to the base branch: one commit, own branch, optional PR | git + base branch |
| `lib/delivery/providers/github-cli.mjs`, `engine/external-merge.mjs`, `engine/remote-work.mjs` | pull requests, merges | code delivery (stays in git, see 1.3) |
| `lib/host-hooks/guard.mjs`, `merge-authorization.mjs` | base-branch protection reading config from the base branch | git |

### 1.3 What stays in git regardless

Code, branches, pull requests, merges and the base branch are the product, not records: they stay in git with every store. With a non-git store, what the records must still carry is the **link** to the code: commit SHAs, PR URLs, the merge commit a certification anchors to. `base_branch_coupling` (below) is exactly the guarantee that records and code share one history; a store without it can still certify only with an explicit anchor (merge commit SHA + record hash) checked by the gate (phase 3).

What can move: every record kind under `.sdlc/` (stories, contracts, steps, gates, receipts, traces, evidence manifests, delegations), and all coordination shared state.

## 2. Messaging dependencies and how each becomes independent

| Today depends on messages | Independent design | Status |
|---|---|---|
| Claims, releases | shared claim refs (`refs/agentic-sdlc/claims`) decide; the notice only announces | already independent; covered by `test/messaging-off-flows.e2e.mjs` |
| Explicit waits (`wait add/resolve/list`) | wait-registry shared state through the record store | phase 1: routed through `RecordStore.sharedState`; tested with messaging off and on `local-fs` |
| Derived **question** waits (`deriveQuestionWaits` from the channel window) | a question that must be answered becomes an explicit wait record (`wait add --on question:<id>`); the message only points at it | phase 2 |
| **Freezes** (`--kind freeze` messages, `deriveFreezeWaits`) | freeze becomes an explicit wait-registry record (`on: freeze`), the message only announces it | phase 2 |
| **Outdated plugins** (`derivePluginWaits` from versions seen in messages; information only since 0.153.6, no request is sent) | plugin version per host recorded in a presence/lease record of the shared state; release announcement is a record, notice optional | phase 2 |
| Delegations, approvals | records + refs; escalation notice optional | already independent |
| Gate failure "need help" question | notice only; the gate result is the record | already independent |
| `story prepare` announcement | best effort; fixed in phase 1 so a refused message can no longer reject unhandled | done |
| Publication / closure / triage notices | best effort `sendAutoAlert`, never throws | already independent |
| Host identity (`hostLabel` in `messaging/commands.mjs`) | move to a neutral `lib/host-identity.mjs`; messaging and the store both use it | phase 2 |
| keep-going / watch hooks reading the channel | read waits from the store; channel only adds human-readable context | phase 2 |

## 3. MessagingProvider port

Defined in `lib/adapters/messaging/port.mjs`; registry in `lib/adapters/messaging/registry.mjs`, ids in `ids.mjs`.

```
id, guarantees[]
ensureChannel({ config, signal, verify }) -> { issue|null, created, url }      idempotent
publish({ config, message, signal })      -> normalized message ({ id, time, ... })
poll({ config, since, signal })           -> normalized messages after `since`, oldest first
subscribe({ config, since, signal, onMessage, onError, intervalSeconds })
whoami({ signal })                        -> transport login or null
```

- Normalized message: `id` (digits, growing), `time` (ISO UTC), `from`, `host`, `story`, `kind`, `reply_to`, `to`, `version`, `gh_login`, `stories`, `text`, `title`, `plugin_message`, `until`.
- `since`: `all`, duration (`30m`), unix seconds, ISO time, or cursor `<time>|<id>`; `resolveSince` is shared in `lib/messaging/cursor.mjs`.
- Errors: temporary (`setup: true`, status 408/429/5xx, `rateLimited` + `retryAfterMs`) are queued in the outbox; anything else is a permanent refusal.
- Guarantees (`lib/adapters/capabilities.mjs`): `cross_host_delivery`, `ordered_ids`, `authenticated_sender`. No gate requires any of them: messaging is notification only.

Adapters:

| id | aliases | Notes |
|---|---|---|
| `github` (default) | `github-issue` | unchanged behaviour |
| `local` | `file` | append-only `channel.jsonl` in a folder, ids under a lock; for tests, offline work, a shared network folder |
| `none` | `off` | messaging off: settings resolve as disabled, nothing is sent or read |

Contract for future adapters (team chat such as Slack/Teams, issue-tracker comments such as Jira):

- Map a channel to one conversation (chat channel/thread, issue). `ensureChannel` finds it by a stable name or id from options, creates it only when allowed.
- Ids must grow: use the transport's ordered id if numeric (Jira comment id), otherwise keep a local monotonic mapping (Slack `ts` -> integer) persisted next to the outbox; `ordered_ids` must be declared only when true.
- Machine fields travel in a hidden or structured part of the message (chat metadata, an issue-comment property), never parsed from free text.
- Credentials only by reference (`token_env`, `token_ref`), resolved at call time with `resolveCredential`; never stored, logged or echoed.
- Rate limits surface as temporary errors with `retryAfterMs`.
- Must pass `test/helpers/messaging-contract.mjs` with a fake transport.

## 4. RecordStore port

Defined in `lib/adapters/records/port.mjs`; stores in `git-sdlc.mjs`, `local-fs.mjs` (shared file implementation `fs-store.mjs`); registry `registry.mjs` (`openRecordStore(context)`).

```
id, guarantees[]
read(kind, key)                          -> record | null
write(kind, key, record, { mode })       -> { location, created }   mode create (default) | replace
list(kind, parentKey)                    -> ids, sorted
location(kind, key)                      -> where it lives (path, URL)
appendTrace(stream, event)               -> sealed event
readTrace(stream), verifyTrace(stream)   -> events; { valid, errors }
sharedState { namespaces, read(ns, opts), write(ns, payload) }       create-only
publish(request)                         -> outcome
```

- Records are addressed by **kind + key**, never by a caller-built path. Phase 1 kinds: `story`, `story-step`, `story-parking`, `delegation`, `delegation-revocation`, `delegation-use`, `gate-report`; traces by stream (`<story>` or `project`). Immutable kinds refuse `replace`.
- Shared-state namespaces are registered by their owner (`shared-namespaces.mjs`), so the git store reaches refs without importing the owner. Phase 1 registers `wait-registry`.

### 4.1 Guarantees, assurance and gates

| Guarantee | Meaning | git-sdlc | local-fs |
|---|---|---|---|
| `immutable_history` | a written record cannot change without a visible trace | yes (git history) | no |
| `hash_chain` | traces carry a hash chain + checkpoint | yes | yes |
| `atomic_publish` | a publication lands entirely or not at all | yes (one commit) | no |
| `base_branch_coupling` | records and code share one history | yes | no |
| `shared_state` | create-only state shared between computers | yes (remote refs) | no (this computer only) |

Assurance level: `full` (all), `standard` (hash chain + atomic publish), `local` (less).

Gate requirements (`GATE_REQUIREMENTS`), enforced in `gate check` through `recordStoreGuaranteeErrors` (fail closed, also when the store cannot be opened):

- `standard`: none;
- `strict_intermediate`: `hash_chain`;
- `lifecycle_complete`: `hash_chain`, `immutable_history`, `atomic_publish`, `base_branch_coupling`.

Explicit waits across computers additionally need `shared_state`; on a store without it they work for one computer only, and the wait commands say so (`note`). Claims still use the git claim refs directly until phase 2 registers the `claims` namespace with the store. Phase 2 also makes multi-computer coordination refuse to start (fail closed) when `shared_state` is missing and more than one host is configured.

Contract for future stores (wiki/issue tracker, database):

- `immutable_history`: only with append-only versioning the plugin can verify (page history with immutable versions, WORM table, ledger). An editable page without verifiable history must not declare it.
- `hash_chain`: traces stored as ordered entries with the same sealing as `lib/trace-integrity.mjs` (hash of previous + checkpoint record); the checkpoint stored separately from the trace.
- `atomic_publish`: one transaction or one versioned batch; partial publications must be detectable and rolled back.
- `base_branch_coupling`: only if every record version carries the base-branch commit it belongs to and the gate can verify it against git. Otherwise not declared; lifecycle certification then needs the phase 3 explicit anchor.
- `shared_state`: create-only writes with a conditional create (unique key, `If-None-Match`, insert-only constraint); first writer wins; reads list everything under a namespace.
- Credentials by reference only; must pass `test/helpers/records-contract.mjs`.

## 5. Configuration

`.sdlc/config.json`:

```json
"host_policy": {
  "adapters": {
    "messaging": { "provider": "local", "options": { "dir": "../team-channel" } },
    "records":   { "provider": "git-sdlc", "options": {} }
  },
  "roles": {
    "coordinator": { "hosts": ["pc-coord", "pc-backup"], "lease_minutes": 30, "fallback": "everyone" }
  }
}
```

- Absent sections mean today's behaviour (GitHub channel, `.sdlc/` in git, no roles).
- Messaging precedence: `AGENTIC_SDLC_MESSAGING_PROVIDER` (and `AGENTIC_SDLC_MESSAGING_LOCAL_DIR`), then the per-clone file, then `.sdlc/messaging.json`, then `host_policy.adapters.messaging`.
- Secrets never in config: keys that look like credentials must end in `_env` (environment variable name) or `_ref` (credential-store reference such as `keychain:team-chat`); values are also scanned with the secret scanner. Resolution at call time only (`resolveCredential`).
- Validation: schema (`schemas/sdlc-config.schema.json`) plus `validateSdlcConfig` (known providers only, credentials by reference, valid roles). Unknown provider = refused, never replaced by the default.
- Compatibility: plugins older than 0.147.0 validate `config.json` strictly and reject `host_policy.adapters` / `host_policy.roles`; the keys are declared in `config/plugin-compatibility.json` so those computers are told to update first.

## 6. Coordinator role

When several computers work together, one computer (or agent) can be the **coordinator**: it governs and does not develop.

Duties (`COORDINATOR_DUTIES`):

1. assign and rebalance stories;
2. merge pull requests one at a time (serialized merges, no races);
3. publish records and baselines from one place (no publication races);
4. settle expired waits and unanswered questions;
5. release the plugin;
6. triage defects;
7. keep the base branch green;
8. check record consistency.

Developers develop and deliver up to the pull request (or delivery), then hand over: the hand-over is the PR plus the story's records published to its own branch; the coordinator merges and publishes.

Configuration: `host_policy.roles.coordinator` with `hosts` (ordered), `lease_minutes`, `fallback`, optional `reserved_actions`.

**Who is coordinator, without trusting text:**

- Eligibility comes from the configuration on the **base branch** (protected by the guard; read the same way `guard.protect_base_branch` is read), not from the local copy.
- The active coordinator holds a **lease**: a create-only record in the store's shared state (`coordinator-lease/<epoch>`, git: `refs/agentic-sdlc/coordinator/<epoch>`), pushed with the person's own credentials, so the remote authenticates the writer. A lease names host, epoch, `expires_at`; renewal writes the next epoch before expiry.
- A message saying "I am the coordinator" has no effect. Host ids are self-declared, so phase 3 binds a host to the git identity that pushed its lease (and, optionally, to a signed commit).

**No single point of failure (fallback while no valid lease exists):**

- `everyone` (default): every computer runs the reserved actions as today;
- `next_host`: the first listed host that needs a reserved action takes the lease (create-only: exactly one wins the epoch), which is an election by first valid write;
- `hold`: reserved actions wait for a coordinator; everything else continues.

**Reserved actions** (default `DEFAULT_RESERVED_ACTIONS`): `autonomy.delivery.action:pull_request.merge`, `baseline.refresh`. With a valid lease held by another host, these are refused locally with the coordinator's name and a hint to hand over; automatic publication on a developer computer becomes "leave it to the coordinator".

Phase 1 ships the schema, validation and the pure resolver (`lib/coordination-roles.mjs`: `coordinatorPolicy`, `resolveRole`, `isReservedAction`). Since 0.149.1 the leases are refs on the remote shared with the automatic roles (`refs/agentic-sdlc/roles/coordinator/<epoch>`, `lib/engine/role-leases.mjs`); reserved actions are now refused in the CLI dispatch when the coordinator is pinned (`lib/engine/role-guard.mjs`), never with automatic roles, and the role's duties start by themselves on its holder (`lib/engine/role-duties.mjs`, `config/role-duties.json`).

## 7. Phases

### Phase 1 (done, behaviour-preserving)

- Ports: `MessagingProvider`, `RecordStore`, guarantees and assurance (`lib/adapters/`).
- Registries; default adapters wrap the existing code (`github`, `git-sdlc`).
- New adapters: messaging `local` (file channel) and `none`; records `local-fs`.
- Config: `host_policy.adapters`, `host_policy.roles` in schema and validation; credentials by reference.
- Routed through the ports: every messaging call site (already through the provider map, now the registry); delegation record reads; explicit wait records (read and write).
- `gate check` fails closed when the store lacks a guarantee the certification level needs.
- Contract suites: `test/helpers/messaging-contract.mjs`, `test/helpers/records-contract.mjs`; flows with messaging off: `test/messaging-off-flows.e2e.mjs`.

### Phase 2: independence and roles (done)

- Questions and freezes as explicit wait-registry records; derived waits from the channel become optional hints.
- Neutral host identity module; messaging and store use it.
- Remaining shared namespaces registered with the store: `claims`, `waits`, `reviews`, `standing`, `commits`, `baseline-refresh`.
- Coordinator lease records, `role status` command, enforcement of reserved actions, hand-over flow, serialized merge queue on the coordinator.
- Multi-computer coordination refuses to start on a store without `shared_state`.
- `message setup --provider local|none`.

### Phase 3: records through the store

- Route record writes (stories, steps, contracts, gates, receipts, evidence manifests) through `RecordStore.write`, family by family, behind the existing mutation-guard authorization.
- Traces through `appendTrace`; publication through `publish` everywhere (`story sync`, auto-publish).
- Explicit merge anchor for stores without `base_branch_coupling`.
- Observatory reads through the store.

### Phase 4: external adapters

- Reference adapters outside the core (separate packages) for team chat, issue-tracker comments, a wiki and a database, each passing the contract suites; the core keeps no vendor SDK.
- Migration command between stores (`records migrate --to <provider>`), verifying hashes on both sides.

## 8. Risks and open points

- `.sdlc/` paths are used directly in ~66 modules; phase 3 is long and must go family by family with the existing e2e suites as the safety net.
- A store without `immutable_history` weakens tamper evidence: such stores can never give `lifecycle_complete`; this is intentional.
- The local messaging provider trusts the sender text (`authenticated_sender` not declared); fine because messages never carry authority.
- Older plugins reject the new config keys: roll out 0.147.0 to every computer before adding them.
