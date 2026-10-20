# Context module

Status: phase 1 implemented (0.148.0, on top of the 0.147.0 RecordStore/MessagingProvider ports). Owner: plugin maintainers.

## Problem

An agent working on one story today re-reads a lot of text that it does not need:

- whole `.sdlc` records: a final gate report alone can weigh 785 KB, a story trace 90 KB,
  the project trace several MB;
- the long human explanation every CLI command prints (Outcome / What this changes /
  What you need to decide / What remains protected / Next step / Technical details);
- host hook injections repeated on every tool call or prompt: the same unanswered
  messages, the same "processes older than 10 minutes" warning, the same session
  instructions after a resume;
- long skill text that sends the agent to read many files.

Measured on `ST-QA-FIX-SUITE-MAIN-2` (a pilot project, origin/main): the 40 files that belong
to the story weigh about 1.4 MB (~350k tokens); the records the context pack reads to
build its answer weigh ~3.8 MB (~959k tokens, mostly the project trace and gate reports).

## What already exists (reused, not duplicated)

| Existing piece | Where | Reuse |
| --- | --- | --- |
| Iteration dossier / story brief (observatory 0.146.x) | `lib/change-observatory/normalizer.mjs`, `ui/change-observatory/story-brief.js` | Human view in the browser; same lanes (asked, decided, contract, done, verified) inspired the pack sections. Not reused as code: it normalises the whole project model for the UI, too heavy for a CLI call. |
| Next lifecycle step | `nextStoryStep` in `lib/host-hooks/keep-going.mjs` | Used as is for the `next` section, so the pack, the Stop hook and `agentic-sdlc next` agree. |
| Write scope | `pathMatchesApprovedWriteScope` (`lib/lifecycle/project.mjs`), delivery profile `constraints.allowed_write_paths` | Used for the `scope` section and the file index. |
| Secret detection | `lib/secret-scan.mjs` (`scanFiles`, project `gate_policy.secret_scan.rules`), `lib/observability/redaction.mjs` (operational policy) | Both layers applied to every line the module prints. |
| Derived cache folders | `cache_policy.derived_directories` (`cache`, `indexes`), `.sdlc/.gitignore` (`cache/**/*`) | The pack cache lives in `.sdlc/cache/context/` and is written only when `cache` is a derived folder. |
| Compact JSON profiles | `buildContextOptimizationMetadata` (`lib/lifecycle/project.mjs`) | Same idea (omit, then point to `--full`); the text output reuses the pattern with `--verbose`. |
| Policy defaults + `host_policy.<name>` overrides | `config/waits.json` + `resolveWaitsPolicy` | Same pattern: `config/context.json` + `resolveContextPolicy`. |

## Design

### Components

```
lib/context/
  policy.mjs          defaults (config/context.json) + host_policy.context, estimateTokens
  reader.mjs          read port (list/readJson/readText/readLines/hash/observed): fs and RecordStore-backed implementations, cache validity check
  pack.mjs            facts -> sections -> budgeted pack (pure apart from the reader and git ls-files)
  redact.mjs          redaction + secret scan rules on every printed line
  service.mjs         buildContextPack (with cache), getContextRef
  cli.mjs             context pack / context get
  compact-output.mjs  agent form of the CLI human output
  compact-json.mjs    agent JSON profile of --json payloads (compactJsonPayload, record locator)
lib/host-hooks/injection-budget.mjs   dedupe + caps for hook injections
```

Each piece has one responsibility; the pack builder never touches the filesystem directly.

### Read port and the RecordStore adapters

`pack.mjs` reads only through the reader interface:

```
list(dir) · readJson(file) · readText(file, max) · readLines(file, visit) · hash(file) · observed()
```

Paths are project-relative (`.sdlc/stories/<id>/story.json`). `createRecordStoreReader(store, { fallback })`
reads through the RecordStore port of `lib/adapters/records/` (`openRecordStore`): story,
story steps and gate reports with `store.read(kind, key)`, step folders with
`store.list("story-step", { parent })`, traces with `store.readTrace(stream)`. Records the
port does not address yet (requirements, contracts, tests, dependencies, waits, delivery
profiles) come from the filesystem reader given as fallback; when no store can be opened
the filesystem reader is used alone. Hashes of store records are taken over their JSON;
the cache key includes the reader kind and the cache check uses the same reader, so a
change of records adapter rebuilds the pack.

### Context pack

`agentic-sdlc context pack --story <id> [--phase <p>] [--budget <tokens>] [--no-cache] [--json]`

Sections, always in this order (a phase may omit some):

| Section | Content | Never |
| --- | --- | --- |
| story | id, title, status/phase/priority, contract, claim holder, story acceptance criteria | full audit blocks |
| requirement | per linked requirement: id, revision, status, title; acceptance criteria only when the requirement is approved; non-goals in discovery/analysis/design/handoff | criteria of a requirement not yet approved |
| contract | id, status, phase, autonomy, purpose, outputs, validation, human gate | approvals, hashes |
| decisions | latest `decision` trace events of the story (story trace + project trace), deduplicated, newest first | other event types |
| dependencies | edges to/from the story with the other story's status, overlap reviews | the whole graph |
| scope | delivery profile, write paths, file index (tracked files in scope, ranked: exact write paths, delivery profile, requirement scope) with top-level symbol names | file contents |
| evidence | strict/final gate status and first error, latest test runs, steps done/open | gate receipts |
| waits | open story waits, pointer to `wait list` for channel-derived waits | message history |
| next | the next governed step and its command (same as the Stop hook) | |

Phases: the project's `phase_order` (the lifecycle steps when it is empty), any phase named in
`host_policy.context.pack.phase_sections`, plus `handoff`; a phase without its own weights
uses the implementation weights. Without `--phase` the pack follows the
first open lifecycle step. Each phase weights the sections (`host_policy.context.pack.phase_sections`):
analysis has no file index and no evidence; implementation weighs scope and requirement;
validation weighs evidence; release weighs evidence and dependencies.

**Handoff pack** (`--phase handoff`): everything another agent or computer needs to pick
the story up (coordinator → developer): step summaries, claim holder, decisions, scope
with the file index, evidence, waits, next step. Same determinism and redaction rules.

**Budgets.** `--budget` (default `host_policy.context.pack.budget_tokens`, 2000) is split
across the phase's sections by weight (minimum 24 tokens each). A section keeps its items
in order while they fit and ends with `… N more: context get sec:<story>/<phase>/<section>`.
Tokens are estimated as characters / 4 (deterministic, provider neutral).

**Progressive disclosure.** `agentic-sdlc context get <ref> [--budget <tokens>]`:

- `sec:<story>/<phase>/<section>` the full, untruncated section;
- `rec:<.sdlc path>[#/json/pointer]` one record or part of it (only under `.sdlc/`);
- `trace:<story id|project>#<event id>` one trace event without the integrity block.

Output is redacted and capped (default 1500 tokens, with a hint listing the record keys
to narrow with a pointer).

**Determinism.** No timestamps of the run, sorted listings, fixed section order, canonical
hash (`computeStableHash`) of the pack body: same records + same policy + same
phase/budget + same plugin version ⇒ byte-identical text and the same `pack_hash`.

**Cache and invalidation.** `.sdlc/cache/context/<story>/<phase|auto>-<budget>.json` stores
the pack plus what the reader observed: the sha256 of every file read and the listing of
every folder listed, and the hash of the `git ls-files` listing of the write scope. An
entry is reused only when the cache key (builder revision, policy, plugin version,
phases, reader kind) matches, every observed file has the same hash, every listed folder has the same
entries and the scope listing is unchanged. A new test run, a changed requirement or a
new file in scope rebuilds the pack. The cache is derived data: never canonical, never
committed (`cache/**/*` is ignored), not written when the project treats `cache` as
canonical.

**No secrets.** Every line goes through the operational redaction policy, then the
secret scan rules (built-in + `gate_policy.secret_scan.rules`); a line that still
matches is replaced by `[REDACTED]`. `context get` refuses paths outside `.sdlc/`.

### Agent output of every command

`output()` (`lib/engine/output.mjs`) and the error path of the CLI print the agent form
when the caller is an agent:

```
<outcome>
next: <next step>
decide: <decision>            (only when a decision is needed)
- <ids, commands, errors first, at most max_detail_lines>
… N more: --verbose
```

Errors print `error: <exact message>` (and `cause:` when present). Mode resolution:
`--verbose` → full; `--compact` → compact; `AGENTIC_SDLC_OUTPUT=compact|full`;
`host_policy.context.output.mode` (`auto|compact|full`); `auto` = compact inside an agent
host (`CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_AGENT_NAME`), full for people. `--json` is
never affected. The test isolation helper pins `AGENTIC_SDLC_OUTPUT=full`.

### Agent JSON profile

With `--json` an agent gets the `agent` profile (`lib/context/compact-json.mjs`):
`profile: "agent"`, `status`, `correlation_id`, `outcome`, `next`, `ids` (keys
`*_id`/`*_ids`, ids of listed records), `hashes` (keys `*_hash`), `records` (per nested
record only id, kind, status, levels and its `*_hash` fields, plus `ref: rec:<path>` found
by id under `.sdlc/`), `warnings`/`errors`/`human_blockers`/`blockers` (first 5), other
short scalar fields (booleans, numbers, strings up to 80 characters), `error`, `refs`
(`context get rec:...` for the `*_path` fields), `omitted` and
`full: "--json-profile full"`. `assistant_message` and `decide` stay only when a person
must decide (approval requests or a real required decision). Keys are sorted.

Resolution: `--json-profile agent|full`; `--verbose` → full, `--compact` → agent;
`AGENTIC_SDLC_JSON_PROFILE`; `AGENTIC_SDLC_OUTPUT` (compact → agent, full → full);
`host_policy.context.output.json_profile` (`auto|agent|full`); `auto` = agent inside an
agent host. Internal callers that parse the payload pass `--json-profile full`: the
SessionStart standing status, `next` scope checks, `story close` sub-steps and its
background run, `story fix`, test triage, prepared starts, the release verifier's
`doctor`. Tests run with `AGENTIC_SDLC_OUTPUT=full` from the isolation helper.

Measured (e2e fixture, mean per call): `autonomy delivery approve --json` 5206 → 453
tokens (-91%), `requirement approve --json` 4397 → 426 tokens (-90%).

### Hook injections

`lib/host-hooks/injection-budget.mjs` filters what SessionStart, UserPromptSubmit,
PostToolUse, PreToolUse warnings and Stop (`systemMessage` only; `decision`/`reason` are
never touched) inject:

- per-session ledger (`<git-common-dir>/agentic-sdlc/hook-ledger/<hash(session)>.json`):
  a line already injected in the session is not injected again; numbers are normalised
  so "3 processes over 10 min" and "4 processes over 12 min" count as the same line;
- section headers survive only with new content under them;
- caps per event: `host_policy.context.hooks.budget_tokens.<event>` and `max_lines`
  (SessionStart: token budget only), with `… N more: agentic-sdlc wait list` (or
  `context pack --story <id>`);
- the plugin update notice stays first and is never deduplicated (safety);
- the ledger keeps per-event stats (injected tokens, suppressed lines, calls) for
  measurement.

SessionStart adds one line pointing to `context pack` / `context get` instead of reading
records one by one.

### Configuration

`host_policy.context` (schema in `schemas/sdlc-config.schema.json`, defaults in
`config/context.json`):

```json
{
  "output": { "mode": "auto", "json_profile": "auto", "max_tokens": 300, "max_detail_lines": 6 },
  "hooks": { "dedupe": true, "max_lines": 12, "ledger_max_keys": 500, "ledger_max_age_days": 7,
             "budget_tokens": { "session_start": 700, "user_prompt_submit": 250, "post_tool_use": 200, "pre_tool_use": 150, "stop": 150 } },
  "pack": { "budget_tokens": 2000, "file_index_max_entries": 40, "symbols_per_file": 8, "test_runs": 3, "decisions": 8,
            "phase_sections": { "implementation": { "story": 1, "requirement": 3, "contract": 2, "...": 1 } } }
}
```

## Phases

1. **Done (0.148.0):** `context pack`, `context get`, cache, redaction, phase and handoff
   packs, compact CLI output and the agent JSON profile (`--json-profile agent|full`), hook
   dedupe/caps, pointers in hooks, skill and `story` hints.
2. **Done:** story commands (`story claim`, `task start`) print the pack hash and the
   `context pack` command as their next step; `next` and the Stop hook add the pack ref of
   the active claim.
3. Pack refs become store-neutral (`rec:<kind>/<key>`) as the RecordStore port covers more
   kinds; the filesystem fallback shrinks with it.
4. Messaging digest through the MessagingProvider port: the hook reads "new since the
   ledger cursor" from the provider instead of filtering text.
5. `context stats`: per-session report from the hook ledger and pack cache (tokens
   injected, suppressed, saved) for the observatory.

## Risks

- A capped section can hide an item an agent needed: every cut carries a `context get`
  ref, and budgets are configurable per project and per phase.
- Dedupe hides a repeated reminder of an unanswered question after the first time in a
  session: the question stays visible in `wait list` and `agentic-sdlc next`, and the
  Stop hook still blocks on it.
- Agent hosts that do not set the known environment markers get the full output; they
  can set `AGENTIC_SDLC_OUTPUT=compact` or the project policy.
- Token counts are estimates (chars / 4), good for budgets and comparisons, not billing.
