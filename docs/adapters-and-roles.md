# Adapters and roles

Two choices used to be fixed: how computers send each other notes (a GitHub issue) and where the project's records live (the `.sdlc/` folder in git). Since 0.147.0 the messaging channel is replaceable. The records store is replaceable only for explicit waits and delegation reads so far; the other records are still written to `.sdlc/`, apart from the operational records that the `sdlc-state` store moves to a branch (see below). One computer can also be named coordinator. Everything here is optional: with no configuration the plugin behaves as before. The design is in [pluggable-adapters](plans/pluggable-adapters.md).

## Configuration

All of it is in `.sdlc/config.json` under `host_policy`:

```json
{
  "host_policy": {
    "adapters": {
      "messaging": { "provider": "local", "options": { "dir": "../team-channel" } },
      "records":   { "provider": "git-sdlc", "options": {} }
    },
    "roles": {
      "coordinator": {
        "hosts": ["pc-coord", "pc-backup"],
        "lease_minutes": 30,
        "fallback": "everyone"
      }
    }
  }
}
```

- A missing section means the default: the channel `message setup` chose for the clone (`git` for a new one, else the GitHub issue already in use), records in git, roles assigned automatically.
- An unknown provider is refused with a clear error; it is never replaced by the default.
- Credentials never go in the file. A key that looks like a secret must end in `_env` (name of an environment variable) or `_ref` (reference to a credential store, such as `keychain:team-chat`). Values are scanned for secrets.
- Older plugins reject these keys, so computers on a plugin before 0.147.0 are told to update before they change the project.

## Messaging providers

| Provider | What it is | When to use it |
|---|---|---|
| `git` | One ref per computer on the project's own remote (`refs/agentic-sdlc/channel/<machine-id>`), each message a signed commit; what `message setup` picks for a new channel | Any git host, no other service or account |
| `github` | One issue of the repository, read and written with `gh`; the fallback when no provider is set | Teams on GitHub, projects that already have a channel issue |
| `local` | A channel file in a folder (`options.dir`, or `AGENTIC_SDLC_MESSAGING_LOCAL_DIR`) | One computer, tests, a shared network folder |
| `none` | Messaging off | Anything that must not depend on a channel |

Choose per computer with `AGENTIC_SDLC_MESSAGING_PROVIDER`, per clone with `"provider"` in `.git/agentic-sdlc/messaging.json` (`message setup` writes the provider it set up there), or for everyone with `host_policy.adapters.messaging`. Examples are in [Working without messaging](messaging.md#working-without-messaging) and the full precedence is in [Settings](messaging.md#settings).

## Record stores

| Store | Where the records live | Good for |
|---|---|---|
| `git-sdlc` (default) | The `.sdlc/` folder in git, shared state in refs on the remote, one commit per publication | The normal team flow |
| `local-fs` | Explicit wait records are kept as plain files in `<options.dir>/.shared-state/wait-registry/` (`options.dir` defaults to `.sdlc`), no git involved; the other records are still written to `.sdlc/` | A single computer, experiments, projects without a remote |
| `sdlc-state` | Like `git-sdlc`, but the operational records live on an orphan branch of the same remote (`sdlc-state`) | Busy projects whose base branch fills up with record-only commits |

Code, branches, pull requests and merges stay in git with every store.

Each store declares what it guarantees, and the strictest checks ask for them:

| Guarantee | `git-sdlc` | `local-fs` |
|---|---|---|
| `hash_chain` (traces are tamper-evident) | yes | yes |
| `immutable_history` | yes | no |
| `atomic_publish` | yes | no |
| `base_branch_coupling` (records and code share one history) | yes | no |
| `shared_state` (claims and waits shared across computers) | yes | no: explicit waits stay on this computer; claims and reservations still use git refs on the remote |

`sdlc-state` gives the same guarantees as `git-sdlc`: what the base branch certifies stays there.

### Operational records on the state branch

Delivery action receipts (`autonomy/actions/`), autonomy executions (`autonomy/executions/`) and gate reports (`gates/`, except the final receipts `gates/<story>-final.json`) are written often and read rarely. On a busy project they make most of the commits on the base branch. With the state branch they stay plain files in `.sdlc/`, so every command reads them as before, but git no longer tracks them on the base branch; an orphan branch of the same remote carries them.

Stays on the base branch: requirements, contracts, decisions, baseline, config, stories (`story.json`, claims, steps) and dependencies.

From 0.159.0 (level 2) the traces with their checkpoints, the workflow instances and the final gate receipts move too. A history both computers extended is never overwritten: the events only this computer has are re-sealed after the branch's (as `trace rebase` does) and then pushed fast-forward. Dependency checks, closing-record warnings, the trace fork warning and story sync read them from the state branch. A project migrated with 0.154 runs `state migrate` again to move them; do it on a checkout whose records are up to date with the base branch (`story sync` first).

```bash
mpsf state migrate --dry-run   # what would move
mpsf state migrate             # push the records, ignore them, stop tracking them (files and history stay)
git commit -m "Operational records on sdlc-state" && git push   # through your usual flow
mpsf state status              # where they are, how many are not pushed yet
```

`state migrate` adds `.sdlc/compatibility/sdlc-state-records.json` and `sdlc-state-traces.json`. They switch every computer to the state branch and make plugins older than 0.154.0 (0.159.0 for level 2) ask for an update instead of missing records. No configuration key is needed. To change the defaults, set `host_policy.adapters.records` to `{ "provider": "sdlc-state", "options": { "branch": "sdlc-state", "remote": "origin", "push_interval_seconds": 120, "pull_interval_seconds": 60 } }` through `config migrate`.

How the records move:
- The host hooks run `state sync --if-due` in the background at session start and at every stop, and `state push` at session end. `state pull`, `state push` and `state sync` do it by hand.
- A push is one commit on the remote tip with only the records changed here since the last sync. It is fast-forward only, so a branch moved by another computer is refused and the push is rebuilt on the new tip, with backoff. Records are never deleted by a push.
- A pull never overwrites a record changed here and not pushed yet.
- Pushes are throttled (`push_interval_seconds`, default 2 minutes), so many computers together stay well under the forge's push rate (GitHub suggests about 6 pushes a minute per repository).
- Every state commit says `[skip ci]`, and the branch has no CI files, so no pipeline starts on GitHub, GitLab, Bitbucket, Azure DevOps or Gitea/Forgejo. With CircleCI, filter out `sdlc-state` in the project settings.
- Paths on the branch are the same as in `.sdlc/`. `state status --json` groups them by story (`shards`), so a branch or ref per story can be switched on later without changing the format.
- CI jobs that read these records run `mpsf state pull` after checkout. The Change Observatory fetches the state branch and shows its records together with the base branch.

Assurance level: `full` (all of them), `standard` (hash chain and atomic publish), `local` (less). `gate check` refuses a level the store cannot back: `strict_intermediate` needs `hash_chain`; `lifecycle_complete` needs `hash_chain`, `immutable_history`, `atomic_publish` and `base_branch_coupling`. On `local-fs` the project can work and pass the intermediate gates, but it cannot be certified as lifecycle-complete.

## Coordinator role

With several computers, one can be the coordinator. It governs and does not develop: it merges pull requests one at a time, publishes records and baselines from one place, settles expired waits and unanswered questions, frees abandoned claims, checks record consistency, releases the plugin and keeps the base branch green. It does not assign stories (every computer claims its own) or triage defects. Developers deliver up to the pull request and hand over.

| Setting | Meaning |
|---|---|
| `hosts` | Host ids allowed to coordinate, in order of preference |
| `lease_minutes` | How long a coordinator lease lasts before it must be renewed (default 30) |
| `fallback` | What happens while nobody holds a valid lease: `everyone` (default, every computer acts as without roles), `next_host` (the first listed computer that needs it takes the lease), `hold` (reserved actions wait; everything else continues) |
| `reserved_actions` | Optional override of the actions only the coordinator runs |

Without this section the roles are assigned automatically among the computers alive on the remote (see Computers and roles in `docs/messaging.md`), and nobody is ever refused anything: the coordinator only runs its duties, the others keep doing everything they did before.

With this section a person pinned the coordinator, and its reserved actions are enforced: on a computer that does not hold the coordinator lease, a reserved action (default `autonomy.delivery.action:pull_request.merge` and `baseline.refresh`; `reserved_actions` replaces the list with another one) is refused with the holder's name while another listed host holds a valid lease, and, with `fallback: hold`, while nobody does. The lease is read from the remote right before the action (one bounded fetch). Without a shared remote there is nobody to wait for, and `AGENTIC_SDLC_ROLES=off` turns the check off on one computer: that is a person's choice, never an agent's. A message saying "I am the coordinator" never counts: only the lease on the remote does.

The holder of a role runs its duties by itself (`config/role-duties.json`), each at most every few minutes, as a detached run started by the host hook, so no hook waits for it: freeing abandoned claims, settling expired waits, checking the story records, opening the P1 fix story when the base branch is red (`coordinator main-green`), distilling the shared knowledge (`knowledge distill`). Duties that message other computers or merge into the base branch (`coordinator digest`, `merge`) are listed but run by hand until a person turns them on. A duty marked `publish: "base"` (`main-green`, `knowledge distill`) runs in the dedicated worktree on the base branch, never in the person's checkout, and pushes the records it wrote under `.sdlc` to the base branch with `[skip ci]`, never forced; when the base moved meanwhile they go on top of it. `roles status` lists the duties started on this computer; `AGENTIC_SDLC_ROLE_DUTIES=off` stops them.
