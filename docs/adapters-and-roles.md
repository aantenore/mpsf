# Adapters and roles

Two choices used to be fixed: how computers send each other notes (a GitHub issue) and where the project's records live (the `.sdlc/` folder in git). Since 0.147.0 both are replaceable, and one computer can be named coordinator. Everything here is optional: with no configuration the plugin behaves as before. The design is in [pluggable-adapters](plans/pluggable-adapters.md).

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

- A missing section means the default: GitHub channel, records in git, no roles.
- An unknown provider is refused with a clear error; it is never replaced by the default.
- Credentials never go in the file. A key that looks like a secret must end in `_env` (name of an environment variable) or `_ref` (reference to a credential store, such as `keychain:team-chat`). Values are scanned for secrets.
- Older plugins reject these keys, so computers on a plugin before 0.147.0 are told to update before they change the project.

## Messaging providers

| Provider | What it is | When to use it |
|---|---|---|
| `github` (default) | One issue of the repository, read and written with `gh` | Teams on GitHub |
| `local` | A channel file in a folder (`options.dir`, or `AGENTIC_SDLC_MESSAGING_LOCAL_DIR`) | One computer, tests, a shared network folder |
| `none` | Messaging off | Anything that must not depend on a channel |

Choose per computer with `AGENTIC_SDLC_MESSAGING_PROVIDER`, per clone with `message setup`, or for everyone with `host_policy.adapters.messaging`. Details and the full precedence are in [Messages between computers](messaging.md#working-without-messaging).

## Record stores

| Store | Where the records live | Good for |
|---|---|---|
| `git-sdlc` (default) | The `.sdlc/` folder in git, shared state in refs on the remote, one commit per publication | The normal team flow |
| `local-fs` | Plain files in a folder (`options.dir`, default `.sdlc`), no git involved | A single computer, experiments, projects without a remote |

Code, branches, pull requests and merges stay in git with every store.

Each store declares what it guarantees, and the strictest checks ask for them:

| Guarantee | `git-sdlc` | `local-fs` |
|---|---|---|
| `hash_chain` (traces are tamper-evident) | yes | yes |
| `immutable_history` | yes | no |
| `atomic_publish` | yes | no |
| `base_branch_coupling` (records and code share one history) | yes | no |
| `shared_state` (claims and waits shared across computers) | yes | no (this computer only) |

Assurance level: `full` (all of them), `standard` (hash chain and atomic publish), `local` (less). `gate check` refuses a level the store cannot back: `strict_intermediate` needs `hash_chain`; `lifecycle_complete` needs `hash_chain`, `immutable_history`, `atomic_publish` and `base_branch_coupling`. On `local-fs` the project can work and pass the intermediate gates, but it cannot be certified as lifecycle-complete.

## Coordinator role

With several computers, one can be the coordinator. It governs and does not develop: it assigns stories, merges pull requests one at a time, publishes records and baselines from one place, settles expired waits and unanswered questions, releases the plugin, triages defects and keeps the base branch green. Developers deliver up to the pull request and hand over.

| Setting | Meaning |
|---|---|
| `hosts` | Host ids allowed to coordinate, in order of preference |
| `lease_minutes` | How long a coordinator lease lasts before it must be renewed (default 30) |
| `fallback` | What happens while nobody holds a valid lease: `everyone` (default, every computer acts as without roles), `next_host` (the first listed computer that needs it takes the lease), `hold` (reserved actions wait; everything else continues) |
| `reserved_actions` | Optional override of the actions only the coordinator runs |

Without this section the roles are assigned automatically among the computers alive on the remote (see Computers and roles in `docs/messaging.md`), and nobody is ever refused anything: the coordinator only runs its duties, the others keep doing everything they did before.

With this section a person pinned the coordinator, and its reserved actions are enforced: on a computer that does not hold the coordinator lease, a reserved action (default `autonomy.delivery.action:pull_request.merge`, `story.publish-records`, `baseline.refresh`, `wait.resolve`, `story.assign`, `plugin.release`) is refused with the holder's name while another listed host holds a valid lease, and, with `fallback: hold`, while nobody does. The lease is read from the remote right before the action (one bounded fetch). Without a shared remote there is nobody to wait for, and `AGENTIC_SDLC_ROLES=off` turns the check off on one computer: that is a person's choice, never an agent's. A message saying "I am the coordinator" never counts: only the lease on the remote does.

The holder of a role runs its duties by itself (`config/role-duties.json`), each at most every few minutes, as a detached run started by the host hook, so no hook waits for it: freeing abandoned claims, settling expired waits, checking the story records, opening the P1 fix story when the base branch is red (`coordinator main-green`), distilling the shared knowledge (`knowledge distill`). Duties that message other computers or merge into the base branch (`coordinator digest`, `update-requests`, `merge`) are listed but run by hand until a person turns them on. A duty marked `publish: "base"` (`main-green`, `knowledge distill`) runs in the dedicated worktree on the base branch, never in the person's checkout, and pushes the records it wrote under `.sdlc` to the base branch with `[skip ci]`, never forced; when the base moved meanwhile they go on top of it. `roles status` lists the duties started on this computer; `AGENTIC_SDLC_ROLE_DUTIES=off` stops them.
