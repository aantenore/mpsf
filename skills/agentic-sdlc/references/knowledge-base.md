# Shared Knowledge Base

The project KB lives under `<target-project>/.sdlc/`. It is the durable source of truth for agentic SDLC work.

## Required Structure

```text
.sdlc/
  project.json
  config.json
  config.lock.json
  bootstrap-manifest.json
  README.md
  .gitattributes
  .gitignore
  baseline/
  assessments/
  budgets/
  context-optimization/
  contracts/
  autonomy/
  authorizations/
  authorization-uses/
  receipts/
  capability-discovery/
  output-contracts/
  requirements/
  stories/
  work-items/
  work-breakdown/
  dependencies/
  orchestration/
  locks/
  handoffs/
  decisions/
  assumptions/
  risks/
  tests/
  traces/
  releases/
  manifests/
  archive/
  cache/
  indexes/
  reports/
  reviews/
  operations/
```

See `docs/kb-structure.md` for the full layout, including directories created on demand such as `workflows/`.

## Source Of Truth

Use JSON and Markdown files as source of truth. Treat generated cache and indexes as derived artifacts. Reports are durable evidence when they support a review, gate, or release decision.

Manifests under `.sdlc/manifests/` are shared compact maps of canonical KB state. Trace compactions under `.sdlc/traces/compactions/` summarize raw trace JSONL without deleting it. Archive plans under `.sdlc/archive/` can move old reports and compactions only when explicitly applied; live stories, contracts, approvals, and trace JSONL files stay canonical.

## What Belongs In The KB

- Contracts and phase rules.
- Existing-project baselines, including inferred current state, imported documents, source hashes, open questions, and explicit baseline approvals.
- Output contract registry, approved templates, story-artifact links, and structural output decisions.
- Revisioned `requirement:v2` records, constraints, and supersession lineage.
- Requirement execution profiles, per-delivery profiles, and effective autonomy decisions.
- Story workspaces and claims.
- Orchestration snapshots for parent chats.
- Phase/shared-artifact locks.
- Handoffs between agents, phases, and Codex chats.
- Architecture and product decision records.
- Explicit assumptions and rejected alternatives.
- Risks and mitigations.
- Test plans and evidence.
- Release notes and feedback loops.
- Story step completion records and handoff packages that allow another chat or developer to continue from the KB.
- Shared KB manifests, non-destructive trace compactions, activity reports, and archive plans for closed evidence.
- Cache/index files only as local regenerable acceleration data.

## Existing Project Baseline

When SDLC tracking starts on a project that already has code or documentation, create a baseline proposal instead of inventing past history:

```bash
node bin/mpsf.mjs onboard existing-project --root <project> --document README.md
```

The baseline is inferred context until approved. It can describe what exists now, but it cannot prove who made past decisions, why they were made, or whether previous approvals happened unless those facts are present in canonical evidence files.

Approve a baseline only with explicit user or CI confirmation:

```bash
node bin/mpsf.mjs baseline approve --id BASELINE-INITIAL --actor-type human --approval-source explicit-user --summary "<confirmed scope>"
```

## What Does Not Belong In The Plugin

- Project-specific contracts.
- Project-specific traces.
- Project-specific decisions.
- Private project knowledge.
- Generated cache and indexes for a specific project.

Those artifacts must stay in the project `.sdlc/` directory.

## Autonomy Records

Store requirement ceilings and delivery choices under `.sdlc/autonomy/`. A `requirement-execution-profile:v1` binds the ceiling to one immutable requirement revision. A new `delivery-execution-profile:v2` binds the explicit choice, verification-provider bindings, one `pull_request` or `local_release`, and exactly one story/approved-contract pair; it is never reusable across deliveries. Historical `delivery-execution-profile:v1` records remain byte- and hash-compatible and receive only the conservative in-memory legacy provider mapping; they are never rewritten. An `autonomy-decision:v1` records the most restrictive effective result and reason codes.

For a pull request, retain repository, base/head branches, canonical actions, explicit write paths, story/contract refs, and merge boundary. For a local release, retain the target root, allowed writes/actions, shell-free JSON-argv smoke tests, and rollback. `audit_only` is capped at `checkpointed`, even for local targets; effective `bounded-autonomous` requires an external trusted host/CI Ed25519 receipt under `host_verified` policy. Protected-branch merge and remote/production deployment require separate explicit authority.

Persist the immutable delivery start/close receipts and single-use action receipts. Actions follow authorize → host/tool execution → complete with evidence. Passing local release or merge completion creates the success close receipt automatically. Push/merge receipts include live remote pre/post observations, but those are not provider-signed offline attestations; retain durable host/CI/provider evidence too.

## Output Consistency

Before producing a durable output, inspect `.sdlc/output-contracts/registry.json`.

- Use an approved template for the artifact type.
- Prefer reuse plus delta when another story already covers the same requirement.
- Ask the user before approving a new template, changing structure, or creating a duplicate new artifact.
- If no approved template exists for the step/type, propose the template and stop; do not create a contract that references the draft template and do not produce the phase output.
- If a story has no approved contract, create or update the draft contract and stop for user agreement before producing phase work.
- Link the final artifact with `output link` so future agents can discover it.

## Cache Policy

`.sdlc/cache/` is local and regenerable. It may store full-text indexes, story-requirement graphs, artifact fingerprints, compact summaries, dependency graphs, `output resolve` results, and context packs under `.sdlc/cache/context/`; `cache clear` removes all of it.

Never cite cache files as canonical evidence. Cite the source paths recorded in the cache entry instead.

## Activity And Scale

Use `report activity` to answer recent-history questions from real trace events:

```bash
node bin/mpsf.mjs report activity --root <project> --since 3d --view business
```

Use `report query` for broader questions such as "all changes by me", "new functional stories in the last 10 days", or "outputs changed for a requirement". Natural language must be normalized by Codex or another LLM into `schemas/report-query.schema.json`; the CLI executes only the canonical query JSON:

```bash
node bin/mpsf.mjs report query --root <project> --query-json '<canonical-report-query-json>' --json
```

Use `manifest rebuild` for a compact shared map of stories, contracts, outputs, approvals, and activity. In each story entry, `status` and `phase` preserve the canonical record; use `effective_status`, `effective_phase`, and the `lifecycle_*` fields for the verified workflow projection identified by `story_projection_schema_version`. Use `trace compact` when raw JSONL history is too long for context; compaction is additive and must keep the original source trace. Use `archive closed` as a plan-first command for old reports and compactions.

Use `migration identity` only for an explicit attribution correction. Preview the mapping first; require valid legacy/canonical authorization, binding, revocation, every prior migration receipt, and supported file-reference lineage; and require zero unsupported or signed-envelope impacts. Signed evidence is reissued by its authority, never rewritten by this migration. Apply only with the exact preview `plan_hash`; any drift requires a new review. Apply builds and validates the complete result in a same-filesystem shadow tree before a journaled directory swap. If interrupted, leave the lock intact and use authenticated recovery with its nonce and plan hash; pre-commit state rolls back and committed state only finalizes. The resulting record under `.sdlc/migrations/identity/` must retain only the plan hash, source/target identity digests, and before/after lineage hashes; cache and indexes are rebuilt, not treated as canonical inputs.

## Attribution

Claims, traces, handoffs, approvals, locks, and sync events should record:

- actor id and type for the executor;
- `requested_by` when an action was requested by a different human, agent, CI actor, or system;
- `authorized_by` when execution was explicitly authorized by a different human or CI actor;
- request metadata such as summary, thread, run, session, or external request id when available;
- Codex thread/run/session when available;
- Git branch and head SHA;
- event timestamp;
- evidence paths or related artifact IDs.

## Approval Governance

Do not equate implementation authorization with formal artifact approval. Approval records should include `approval_source`, approver attribution, summary or evidence, content hash, Git metadata, and run metadata. Use `approval_source: bootstrap` only for migration/provisional records.
