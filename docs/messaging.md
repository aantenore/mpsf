# Messages between computers

Agents on different computers working on the same project can exchange short notes. A new channel lives in the project's own git remote (`git` provider): one ref per computer, each message a small signed commit, any git host, no other service or account. A project that already uses a GitHub issue as its channel keeps it (`github` provider, read and written with the [`gh`](https://cli.github.com) CLI you are signed in with). `local` (a folder) and `none` (off) are the other providers, see [Working without messaging](#working-without-messaging).

Messaging is optional. On a computer where it is not set up, `message send`, `read` and `listen` make no network call, say it is not set up, and succeed; nothing else in the plugin uses messaging. GitHub being down or slow (no answer within 10 seconds), or `gh` missing or not signed in, is reported with the command to run, never as an error: `read` and `listen` succeed, and `send` keeps the note in the local outbox and exits 75 (see [the outbox](#when-github-refuses-the-outbox)).

## Turn it on

On every computer, in its clone of the project, the same command:

```bash
mpsf message setup [--provider git|github|local] [--repo owner/name] [--issue N]
```

Which channel setup picks: `--provider`; else the one the settings already choose; else GitHub when `--repo`/`--issue` are given or the project already has a channel issue (TravelOps and other existing projects stay where they are); else `git`.

### Git channel

```text
refs/agentic-sdlc/channel/<machine-id>      one ref per computer, on the project's remote
```

- Each computer writes only its own ref, so every push is a fast-forward and never conflicts with another computer. A message is an empty-tree commit whose message holds one JSON line, signed with the computer's Ed25519 key (`~/.config/agentic-sdlc/machine-key.pem`).
- Reading fetches `refs/agentic-sdlc/channel/*` (at most every 15 seconds; the hooks read at most every 30) and walks only the commits added since the last read. Messages are kept per clone in arrival order (`.git/agentic-sdlc/git-channel/`), so a message pushed late by a computer with a slow network or a wrong clock is still delivered. Ids are the same everywhere, so replies point at the right message.
- Once a day a computer rewrites its own ref keeping the last 14 days (force-with-lease, its ref only); readers that no longer find their last commit read the ref again and skip what they have.
- A host that refuses custom refs (Bitbucket Cloud does not document them) is detected at the first refused push: the clone switches to branches `agentic-sdlc/channel/<machine-id>`, whose commits carry `[skip ci]`.
- Push budget: GitHub recommends about 6 pushes a minute per repository, summed over every computer. Each computer pushes channel messages, presence and role leases at most once every 2 minutes (`AGENTIC_SDLC_PUSH_INTERVAL_SECONDS`, 0 = no spacing), with exponential backoff after a failed push (30 seconds up to 8 minutes). A message written in between is shown at once on this clone and leaves with the next push (the next message, read, or hook tick, together with presence in a single `git push`); `message send` says so. Role lease changes skip the spacing; presence renewals are spread by a fixed jitter per computer (10 to 15 minutes).
- The remote is `origin`; `AGENTIC_SDLC_MESSAGING_REMOTE`, `remote` in the messaging files or `host_policy.adapters.messaging.options.remote` change it. On a public repository the channel is public, like the issue.

### Signed messages and trusted computers

Every message the plugin writes, on the git channel and on the GitHub issue, carries the computer's id, key fingerprint, public key and signature. `message setup` proposes the key in `.sdlc/machines/<machine-id>.json` (public key only, never a secret); a person commits and merges it, and from then on the other computers trust that computer's messages. That merge is the handshake. Signing costs less than a tenth of a millisecond; only new messages are verified.

`message read`, `listen`, the messages injected into the agent's context and the Change Observatory mark a message `[unverified: key not registered]` (valid signature, key not in `.sdlc/machines` yet) or `[untrusted]` (no signature or a wrong one). On the GitHub issue a hand-written comment is trusted when its author is the repository's owner, a member or a collaborator, so a person can still write from the phone. A signed message counts only when posted by such a member and only the first time: the same signed message copied into another comment, or posted by anyone else, is `[untrusted]`. Trust changes how a message is shown and two more things: an `[untrusted]` question or request is never listed among those the agent must answer first, and only trusted messages (or unsigned ones of the local provider) can announce a newer plugin version to the auto-update. Messages never approve, claim or block anything. `message status` shows this computer's key and whether it is registered.

### GitHub channel

The repository defaults to the `origin` remote. The channel issue is the one given with `--issue`; otherwise the plugin looks for the issue labelled `agentic-sdlc-channel` (or titled "Agentic SDLC · canale tra computer") and, only if there is none, creates it once. Two computers running setup at the same moment end up on the lowest issue number (the extra one is closed). Repository and issue number are stored in the clone's git folder (`.git/agentic-sdlc/messaging.json`), which git never commits; all worktrees of that clone share it. People can read and write in the same issue from github.com or the GitHub app: a comment without the plugin's hidden trailer reads as an `info` message from the author's GitHub login.

A clone that was still set up with the removed ntfy topic is converted by itself the first time any messaging command or hook runs: same repository (the `origin` remote), channel issue found or created, outbox sent through GitHub, automatic-message state kept except the old server's read positions. Nothing to do; if `origin` is not on GitHub, run `message setup --repo owner/name`.

Optionally fix the stable host id of each computer (otherwise `pc-` plus a short code; the readable name is set with `message identity --name`):

```bash
export AGENTIC_SDLC_HOST_LABEL=PC1          # macOS/Linux
setx AGENTIC_SDLC_HOST_LABEL PC1            # Windows (new terminals)
```

## Working without messaging

Nothing in the plugin needs a channel. Set `AGENTIC_SDLC_MESSAGING_PROVIDER=none` (or `AGENTIC_SDLC_MESSAGING=off`) on a computer, or `"messaging": { "provider": "none" }` under `host_policy.adapters` for everyone, and:

- `message send`, `read` and `listen` make no network call, say messaging is off, and succeed;
- claims (git refs on the remote), explicit waits, dependency waits, approval and delegation waits, delegations, reviews and records publication work exactly the same; the waits derived from the channel (unanswered questions, plugin update requests, freezes) are not computed, because there is no channel to read them from;
- no automatic notices are sent and none are expected.

The team-wide `host_policy.adapters` choice applies only where nothing more specific picks a provider; the order is below.

For a channel without GitHub use the `local` provider: a folder holds the channel file, so one computer (or a shared network folder) can still exchange notes.

```bash
export AGENTIC_SDLC_MESSAGING_PROVIDER=local
export AGENTIC_SDLC_MESSAGING_LOCAL_DIR=/shared/team-channel   # optional
mpsf message setup
```

The same choice for the whole team, in `.sdlc/config.json`:

```json
{ "host_policy": { "adapters": { "messaging": { "provider": "local", "options": { "dir": "../team-channel" } } } } }
```

This applies only where nothing more specific picks a provider. The order is: `AGENTIC_SDLC_MESSAGING_PROVIDER`, then the clone's `.git/agentic-sdlc/messaging.json`, then the committed messaging file, then `host_policy.adapters.messaging`. `message setup` writes the provider it set up (`git`, `github` or `local`) into the clone's file. On a clone that has run it, remove that key, or set `AGENTIC_SDLC_MESSAGING_PROVIDER`.

More on providers, record stores and the coordinator role: [Adapters and roles](adapters-and-roles.md).

## Use it

```bash
mpsf message send --story ST-UX-001 --text "Tests on this story still take 30 minutes here"
mpsf message read --since 2h --skip-own
mpsf message read --unread                  # only what this clone has not read yet, then marked read
mpsf message listen --skip-own --json      # stays open (stopped after 8 hours by default, see AGENTIC_SDLC_LISTEN_MAX_HOURS); run it in the background
mpsf watch --timeout 30m                    # background alarm: exits at the first relevant message, story or release (see how-it-works)
mpsf message outbox [--flush | --drop <id>] # messages waiting to be sent
mpsf message identity [--name "Antonio · PC3"] # who this computer is in the channel
mpsf message who [--since 7d]               # who is in the channel
mpsf message send --kind freeze --until 30m --text "Release in progress"  # no merge/push on main until then
mpsf wait list [--all] [--json]             # who waits for what (see "Waits registry")
```

### Identity, join and roster

Every message has one recognisable author: the **name** of the computer, shown in bold with the GitHub login (`**Antonio · PC3** (antonio) · question · ...`); the hidden trailer also carries the host id and the login. The name is unique in the channel. `message identity` shows it (name, host id, git user, GitHub login); `message identity --name "..."` sets it (stored in `.git/agentic-sdlc/messaging.json` under `identity`). Without a name it is `<git user.name> · <host id>`, or the host id when git has no user name. A name another computer already uses is refused. `--sender` is deprecated: it is accepted only when it equals the name or the host id, any other value is an error (rename with `message identity`). Automatic `[auto]` messages use the same name. `--to` takes a name, a host id or a GitHub login. Older messages without a name show the host id they carry.

The first messaging command on a clone (and again after a change of name or plugin version) publishes one `join` message with name, host, GitHub login, plugin version and the stories in progress. The host hook of the other computers answers each join once with a `welcome` (reply to the join) carrying the same facts, so the newcomer learns who is there; the hook shows "<name> joined the channel (version X)". `join` and `welcome` are written by the plugin, never with `message send`. `AGENTIC_SDLC_MESSAGING_JOIN=off` turns the handshake off on one computer.

Right after joining, the command shows on stderr a short recap, built locally without asking the other agents (they may be off): the last 5 messages of the other computers and the stories in progress, parked or waiting as this clone last saw the shared claims (run `status` for the current state).

`message read --unread` shows only the messages of the other computers that this clone has not read yet and then marks them read. It shares the read position with the automatic read before `story claim` and `task start`, so a message shown by one is not shown again by the other; the first time it covers the last 12 hours. With `--story` only that story is shown and nothing is marked read. It cannot be combined with `--since`.

`message who` lists the participants seen in the period (default 7 days) from join, welcome, status and other messages: name, host, GitHub login, plugin version, last activity, stories in progress; it flags duplicate names and old plugin versions.

### When GitHub refuses: the outbox

If GitHub answers a rate limit (HTTP 429, or 403 with a retry-after or "secondary rate limit"), a server error (5xx), or cannot be reached (network down, no answer within 10 seconds), or `gh` is missing or not signed in, `message send` does not lose the message. It keeps it in the local outbox (`.git/agentic-sdlc/messaging-outbox.json`, mode 0600, never in git), prints `MESSAGE QUEUED (not sent yet): <reason>` and exits with code **75** (distinct from the generic error 1: the message is not lost and must not be sent again). Permanent refusals (other HTTP 4xx, invalid or secret-looking text) are errors as before and are never queued.

The queue is sent, oldest first, by the next `message send` (a new message waits behind the queued ones to keep the order), by `message read` and `listen`, and by the host hook (short timeout), at most once every 5 minutes (`AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES`); each new failure doubles the wait, up to 12 times, and a `retry-after` from GitHub is always respected, so the rate limit is not hammered. Messages that go out leave the queue and are remembered as this computer's own, with their `reply_to`. `message outbox --flush` retries now; `--drop <id>` discards one; `message status` shows the queue. A queued message that GitHub later refuses for good is dropped with a notice.

A queued answer (`--reply-to X`) counts as an answer in progress: question X no longer appears as unanswered in the host hook and does not block the Stop hook. The Stop hook instead mentions once, without blocking: "N messages queued, not yet sent (reason); check 'gh auth status' and the network, or run 'mpsf message outbox --flush'".

### Automatic messages

Once the channel is set, the plugin also writes and reads on its own, so agents keep each other informed without being asked:

- it sends a short note (sender, story, reason) when a gate check fails, a story is parked or put on wait (`story wait --on`), or a command stops on a git time limit; the same note for the same story in the same state is sent at most once every 30 minutes, whatever its wording (a failed gate with the same blocker, numbers and paths aside: once an hour); a failing gate check on a story that is already over (merged, closed, released, abandoned or superseded) sends nothing and only prints a local line (0.146.16 and later). A failed gate or a time limit is sent as a `question` ("need help: <error>; reply with --kind answer --reply-to <id>"), so the other computers are reminded until someone answers;
- when an mpsf command fails and no automatic note covered it, the host hook reminds the agent, once, to share the problem and ask for help;
- before `story claim` and `task start` it shows, on stderr, the messages from the other computers that arrived since this clone last looked (at most 10; the first time, the last 12 hours).

- it also tells the others when a story is claimed or released, a delivery is merged (by the plugin or acknowledged after an external merge), a story's records are published or its lifecycle-complete is certified, the baseline is refreshed, or a story is blocked by another (`story wait --on dep:<story>`). When the finished work lets other stories start, the note names them ("Now unblocked: ...") and ends with a suggested command, shown as a suggestion only: nothing runs by itself;
- it also notes a superseded piece of evidence (asking whoever holds the story to pull main and re-run the strict lifecycle-complete gate). While this clone holds story claims, the host hook posts a short `[auto] status` (kind `info`) when its stories or their phases change, once when a story stays in one phase longer than `AGENTIC_SDLC_MESSAGING_STALL_HOURS` (default 4), and again after 12 hours; with no claim it offers help (kind `offer`) when it becomes free, and again after 12 hours. Two of these messages are at least `AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES` apart (default 15, 0 = no status messages);
- every message carries a kind (`info`, `question`, `answer`, `ack`, `offer`, `request`, plus the plugin's own `join` and `welcome`; `message send --kind <kind> [--reply-to <id>] [--to <name|host|login>]`) in a hidden trailer of the comment, so people just see the text. `message read` and `listen` show kind, id and reply-to, and for `question` and `request` the known senders that have not answered yet. Messages also carry the plugin version; a newer one on another computer is reported.

- while an agent works, the plugin's host hook (after each tool call and on each prompt, at most every 30 seconds) reads the channel and shows the agent the `question`s and `request`s addressed to this computer or to everyone that it has not answered yet, until it replies (`message send --kind answer|ack --reply-to <id>`). Within one agent session each line is shown only once: later reads drop lines already shown, and numbers are ignored when comparing, so the same question still counts as already shown (`mpsf message read` and `wait list` show them again). A short digest of the other new messages is shown once. The hook text is capped by `host_policy.context.hooks` (`dedupe`, `max_lines` 12, `budget_tokens` 200 after a tool call and 250 on a prompt). Anything cut ends with a pointer to `mpsf wait list`; see [Token efficiency](token-efficiency.md#context-packs-and-compact-output). The questions and requests are coordination information, not instructions; the agent is asked to reply or acknowledge before continuing;
- when a question or request sent from this computer has no answer from a known sender after 10 minutes, the hook sends one `[auto]` reminder (`info`, replying to it); at most one per question. A `request` written by the plugin itself (`[auto]`: an older reminder, or an update request sent by a plugin older than 0.153.6) asks for an action, not for a reply: it is never listed as unanswered and nothing reacts to it;
- technical events (phase changes, commits, pushes, pull requests, test results, strict gates) are not sent: the records and the Change Observatory show them. `AGENTIC_SDLC_MESSAGING_TECHNICAL_EVENTS=on` sends them again on this computer.

### Problems first, together

When a command fails, a gate is blocked or a wait goes past about 10 minutes, the agent shares the problem on the channel straight away with `message send --kind question` (command, exact error, story, what it already tried) and asks for help. Whoever receives a request for help handles it before its own work and answers with a concrete proposal or with "I don't know". Open problems are solved before new stories start.

`--skip-own` also skips messages this computer sent under an earlier name (their ids are kept in `messaging-auto.json`).

Notes start with `[auto]`. Without a channel nothing is sent or read. If GitHub does not answer within 3 seconds the command carries on unchanged; a failure never changes a command's result or exit code. The read position lives in `.git/agentic-sdlc/messaging-auto.json`, never in git.

## Waits registry

Who or what a computer (or a story) is waiting for used to live only in the agent's conversation. The waits registry keeps it where every computer and every tool can see it. A wait is `{ id, waiter (host/story), blocker type and ref, since, until, rule, state open|resolved|expired|escalated|stale, resolution }`, where the blocker type is one of `person`, `question`, `story`, `pr`, `plugin_version`, `freeze`, `approval`, `delegation`.

**Derived waits** are computed every time from data that already exists and are never written:

| Source | Wait | Rule |
|---|---|---|
| dependency graph (`.sdlc/dependencies/graph.json`) | a story waits for a dependency not merged yet | merged: the story is ready, keep-going and `watch` suggest starting it right away |
| channel questions/requests without an answer | the asker waits, with the age of the question | after `question_decide_after_minutes` (10): for this computer's own question, "decide on this computer's own work (never assign work to others) or ask your person, announce the decision, proceed"; the decision is recorded with `wait resolve --id q:<message id> --resolution "..."`; after `question_max_age` (2h) the question is `stale`: it is listed but never blocks |
| `message who` roster | a computer of the channel runs an older plugin | information only: nothing is sent to it. Each computer checks its own version against what the project needs (`config/plugin-compatibility.json`, the records' minimum version) and against the newest version announced on the channel, and tells its own person in its session, with the update command |
| channel freezes (off by default: `host_policy.waits.freezes_enabled`; while off, `message send --kind freeze` is refused and freeze messages are ignored) | everyone waits for the end of the freeze | `message send --kind freeze --until <duration>` carries the end explicitly; an announcement such as "30 minuti senza merge/push su main" is recognised too (`freeze_patterns`). During the freeze keep-going does not ask to publish records; when it ends it suggests resuming the suspended actions |
| pending human approvals (breakdown, dependency, contract, requirement, autonomy profile...) | this computer waits for a person | shown once to the person working with this computer, in its own session (agent context and Stop hook note), with the exact command, never on the channel; then the wait is `escalated` and never repeated; keep-going does not block on it |
| expired approval delegations | same as approvals | same as approvals, with the `autonomy delegation grant` command |

**Explicit waits** are declared and closed by hand:

```bash
mpsf wait add --on person:Antonio --until 2h --story ST-UX-002 --reason "layout choice"
mpsf wait resolve --id WAIT-20261010120000-a1b2c3 --resolution "two-column layout"
mpsf wait list [--all] [--offline] [--json]
```

They are kept as dedicated refs on the project remote, the same mechanism as the shared claims, independent of every branch:

```
refs/agentic-sdlc/wait-registry/<wait id>/open      declaration (sealed JSON in a parentless commit)
refs/agentic-sdlc/wait-registry/<wait id>/resolve   resolution, created once: the first one wins
```

Each record is pushed create-only (`--force-with-lease=<ref>:`), so two computers never overwrite each other, nothing lands on `main` or on a story branch, and there is nothing to merge or publish: every computer sees the wait right after the push (`wait list` fetches the unseen records; status, keep-going, watch and the observatory read the copies already fetched, never the network). Without a remote the record stays a local ref with the same name and is listed as not shared. A derived wait can be resolved the same way (`wait resolve --id q:<message id>`), which is how a decision is recorded. The history of closed waits stays in these refs; copying it into a story's `.sdlc` records when the story is published is possible later but not done today.

Where the waits show up:

- `status`: section "In attesa di", one group per waiter, with age and deadline.
- `next` / keep-going: open waits and the suggested actions; escalated waits on a person never block; no publish request during a freeze.
- `watch`: also wakes up when a wait expires, is resolved (for example a dependency merged) or is escalated.
- the host hook that reads the channel applies the automatic rules and shows each suggestion once, including the waits that need this computer's own person; `AGENTIC_SDLC_WAIT_RULES=off` turns the rules off on this computer.
- Change Observatory: panel "Chi aspetta chi" (Who waits for whom) in the Now panel, with ages and deadlines.

The rules are configured in `.sdlc/config.json` under `host_policy.waits` (defaults in the plugin's `config/waits.json`): `question_decide_after_minutes`, `question_max_age`, `freezes_enabled`, `freeze_default_minutes`, `explicit_default_until`, `explicit_max_until`, `escalate_approvals`, `escalate_delegations`, `list_limit`, `freeze_patterns`. What has been shown already (escalations, suggestions) is remembered per clone in `.git/agentic-sdlc/waits-state.json`.

## Computers and roles

Every computer that runs the plugin on a project with a shared remote keeps a presence ref there, and the computers share two roles without any message:

```
refs/agentic-sdlc/presence/<computer id>        replaced by its computer at each renewal: when, until when, stories held and when each was last worked on, roles held, plugin version
refs/agentic-sdlc/roles/<role>/<epoch>          one lease per epoch, created only if it does not exist yet: who, until when
```

- A computer is alive while its presence has not expired (30 minutes); the host hook renews it every 10 to 15 minutes (a fixed jitter per computer) while the plugin is used, and at most every 5 minutes it reads the others (one fetch, one push, each bounded to 3 seconds). A computer that is off simply lapses.
- Roles: `coordinator` (the duties done once for everyone: serial merges, records and baselines, expired waits and claims, digest, welcome, plugin release) and `knowledge` (the shared knowledge). One computer holds each role: the first alive host of `host_policy.roles.coordinator.hosts` when hosts are pinned, else the one chosen by rendezvous hashing among the alive computers. Alone, a computer holds every role.
- The holder keeps a lease (`lease_minutes`, 30 by default) and renews it after half of it. When another computer should hold the role (one joined that ranks first) it hands over at that renewal; when the holder disappears its lease expires and the next computer takes it. Two computers trying at the same moment cannot both win: an epoch is created only once.
- Without a valid lease, without a shared remote, or with `AGENTIC_SDLC_ROLES=off`, every computer does the duties itself, as before roles. Older plugins ignore these refs.
- The holder of a role runs its automatic duties by itself, detached from the hook (`config/role-duties.json`; `AGENTIC_SDLC_ROLE_DUTIES=off` stops them); a pinned coordinator's reserved actions are refused on the other computers (`docs/adapters-and-roles.md`). Automatic roles refuse nothing.
- `roles status [--offline] [--json]` shows the alive computers, who holds each role, who should, and what this computer is. The Change Observatory shows the same from the copies already fetched.
- The presence also carries, for each story held, when it was last worked on here (an agent's tool calls in the worktree that has the story's branch, its branch reflog, that worktree's index and HEAD log, the workflow checkpoint). That renews the claim's lease for every computer, so the claim time to live can be short: a forgotten claim lapses, one in progress does not.
- When a session ends and no other session of the same clone worked in the last 15 minutes, the SessionEnd hook starts a detached push (bounded to 5 seconds, outside the hook's 3) that marks the presence expired and hands back the roles this computer holds. Claims are not released: the same person resumes them, or they lapse one time to live after the last work. If the push is cut, presence and leases lapse on their own.
- Pushing these refs triggers no CI: they are not branches.
- The coordinator's duties about claims and waits are standalone, idempotent commands, each with `--dry-run` and `--json`, that do nothing on a computer that does not hold the role:
  - `coordinator free-claims` frees a claim only when its lease ended (no push within the claim time to live), no declared wait protects it and its holder has no live presence (nor one that ended in the last 15 minutes: a slow link or a skewed clock), and saves the freed story's handoff pack; for every other abandoned claim it shows the commands a person runs. Without any presence known it frees nothing.
  - `coordinator handoff --story <id>` builds the handoff context pack of a story again on demand (previous holder, branch, last push) and saves it in `.git/agentic-sdlc/handoffs/<id>.md`.
  - `coordinator settle-waits` closes the explicit waits past their end and the channel questions older than `question_max_age` with a resolve record.

### Coordinator tasks

The duties the coordinator runs once for everyone are plain commands. Each is idempotent, takes `--dry-run` and `--json`, and does nothing on a computer that does not hold the coordinator role (without roles every computer runs them, as before). A scheduler or host hook may run them periodically; running them by hand is the same.

- `coordinator digest [--force]` sends one `[auto] digest:` summary (alive computers, stories in progress, waiting and parked, open P1 stories), only when it changed and at most every 15 minutes. It replaces the periodic heartbeat; the Change Observatory shows the latest digest apart from each computer's status.
- `coordinator check-records [--ref <git-ref>]` checks the story records on the remote base branch (git objects only, offline): `story.json` present, valid and matching its folder, a claim before completed steps, valid priorities, known fixed stories. Exit code 1 on errors.
- `coordinator main-green [--failing <check>]` opens one ready P1 fix story `ST-MAIN-GREEN-<commit>` when CI of the base branch is red, never a revert; while it is open nothing else is created. The state comes from the forge, or from `--failing`.
- `coordinator merge [--max <n>] [--method merge|squash|rebase]` merges the ready pull requests one at a time in the priority order of their stories (not drafts, no conflicts, checks green, no review asking changes, head commit unchanged); with none ready it updates the first branch that is only behind. Forges are adapters (`lib/coordinator/forges/`), picked from the remote URL or `AGENTIC_SDLC_FORGE` (`github`, `gitlab`, `gitea`, `forgejo`):
  - GitHub through `gh`.
  - GitLab (gitlab.com or self-managed) through REST API v4: merge requests, head pipeline as the check, `detailed_merge_status` for conflicts, approvals and rebase; `--method merge|squash` (rebase or fast-forward is the project's own setting); behind means a rebase request.
  - Gitea and Forgejo (Codeberg included) through REST API v1: commit statuses as checks, latest review per reviewer, merge with `head_commit_id`; a title starting with `WIP:` or `Draft:` is a draft.
  - Token: `GITLAB_TOKEN`, `GITEA_TOKEN`/`FORGEJO_TOKEN` or `AGENTIC_SDLC_FORGE_TOKEN`, else what the system keychain holds for the host through `git credential fill` (never prompting). Without one the command stops and says how to store it (`git credential approve`). Tokens are never written to `.sdlc`.
  - Hosts whose name does not say gitlab, gitea or forgejo: set `AGENTIC_SDLC_FORGE`; `AGENTIC_SDLC_FORGE_URL` sets the web address when it differs from the remote (another port, a path prefix).
- Welcomes to computers that join the channel come only from the coordinator. The recap a joining computer prints is local and unchanged.

## Settings

Each setting is taken from the first place that has it:

| Where | What |
|---|---|
| `AGENTIC_SDLC_MESSAGING_REPO`, `AGENTIC_SDLC_MESSAGING_ISSUE` | environment variables, for this computer (`owner/name`, issue number) |
| `.git/agentic-sdlc/messaging.json` | written by `message setup`: `{"provider": "github", "repo": "owner/name", "issue": 12}`, for this clone, never committed |
| `.sdlc/messaging.json` | optional, committed, for everyone (nothing secret): `repo`, `issue`, `provider` (`github`, `local`, `none`), `dir` (the local provider's folder), or `"enabled": false` (only used when the clone has no local file) |
| `AGENTIC_SDLC_MESSAGING=off` | turns messaging off on this computer |
| `AGENTIC_SDLC_MESSAGING_AUTO=off` | keeps the `message` commands but stops the automatic messages on this computer |
| `AGENTIC_SDLC_MESSAGING_AUTO_TIMEOUT_SECONDS` | network limit for one automatic step (default 3) |
| `AGENTIC_SDLC_MESSAGING_TECHNICAL_EVENTS=on` | also sends phase changes, commits, pushes, pull requests, test results and strict gates (off by default: the Change Observatory shows them) |
| `AGENTIC_SDLC_MESSAGING_POLL_SECONDS` | minimum gap between two reads by the host hook (default 30; each read is one request, so 120 an hour at most per computer against the 5000/hour limit) |
| `AGENTIC_SDLC_MESSAGING_ESCALATE_MINUTES` | wait before the one reminder for an unanswered question (default 10) |
| `AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES` | minimum gap between two automatic attempts to send the queued messages (default 5, doubled after each failure) |
| `AGENTIC_SDLC_HOST_LABEL` | the stable host id of this computer (default: the id kept in `~/.config/agentic-sdlc/machine.json`, decided on first use as `pc-` plus a short hash of the host name, so a laptop whose host name changes with the network keeps it; the same for every clone, worktree, session and subagent); the shown name is set with `message identity --name` |
| `AGENTIC_SDLC_MACHINE_DIR` | folder of the computer's kept id and Ed25519 key (`machine.json`, `machine-key.pem`, mode 0600; default `$XDG_CONFIG_HOME/agentic-sdlc`, `%APPDATA%\agentic-sdlc` on Windows, else `~/.config/agentic-sdlc`) |
| `AGENTIC_SDLC_MESSAGING_JOIN=off` | no automatic join/welcome on this computer |
| `AGENTIC_SDLC_ROLES=off` | this computer publishes no presence and takes no role; it does every duty itself, and the other computers see its claims renewed only by its pushes |
| `AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES` | minimum gap between two automatic status or offer messages (default 15, 0 = no status messages); set explicitly, a status is also sent every gap |
| `AGENTIC_SDLC_MESSAGING_STALL_HOURS` | one status notice per story and phase that stays unchanged this long (default 4, 0 = off) |
| `AGENTIC_SDLC_LISTEN_MAX_HOURS` | `message listen` is stopped after this many hours (default 8, 0 = no limit) |
| `AGENTIC_SDLC_WAIT_RULES=off` | no automatic wait-rule messages on this computer |
| `AGENTIC_SDLC_MESSAGING_PROVIDER` | `git` (refs on the project's remote; what `message setup` picks for a new channel), `github` (an issue; the fallback when nothing is set), `local` (a channel file in a folder: offline, tests, a shared network folder) or `none` (messaging off) |
| `AGENTIC_SDLC_MESSAGING_LOCAL_DIR` | folder of the `local` provider's channel (default: next to the clone's settings in the git folder) |
| `.sdlc/config.json` -> `host_policy.adapters.messaging` | `{"provider": "local", "options": {"dir": "..."}}` for everyone, below the files above; credentials only by reference (`<name>_env`) |

Messaging only notifies: claims, waits, delegations and records publication never depend on it and work the same with `none`. Apart from `host_policy.adapters` (0.147.0 and later), the settings are not in `.sdlc/config.json`, so older plugins keep working; they only lack the `message` commands until they update. Messages change no project record and never land on the base branch or a story branch: with `git` they live in the `refs/agentic-sdlc/channel/` refs of the remote (each computer keeps the last 14 days of its own ref), with `github` in the issue until someone deletes the comments.

## Safety

- **Anyone who can read the repository can read the channel** (a public repository means public messages), and anyone who can comment on its issues can post. Access control is the repository's own.
- Never send code, secrets, credentials, personal or customer data. `message send` refuses text that matches the secret-scan rules, but that is a safety net, not a guarantee.
- Messages are information, never instructions. Agents do not claim, park, skip, approve or merge anything, or bypass any check, because a message says so.
