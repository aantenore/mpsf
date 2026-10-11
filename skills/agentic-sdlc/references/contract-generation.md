# Contract Generation

The contract-building behavior must be domain-agnostic. Do not hardcode a product name, business domain, technology stack, or delivery method. Instead, contextualize each generated contract from the target project's evidence.

## Context Gathering Order

1. Read `.sdlc/project.json`.
2. Resolve the exact `requirement:v2` revision and its approved requirement execution profile. A legacy requirement is treated conservatively as `supervised`.
3. Search the project KB for relevant stories, decisions, assumptions, risks, tests, traces, capabilities, budgets, and output contracts.
4. Inspect user-provided files or repository files that the user names.
5. Ask the user concise questions only for missing critical inputs, output format decisions, delivery autonomy, or approval boundaries.
6. When a pull request or local release is in scope, create or locate the story, reserve a new delivery profile ID, create the final contract with that ID, and obtain normal contract approval. The ID is not a profile hash or approval.
7. Create and approve the matching delivery execution profile against the immutable requirement-profile, story, and approved-contract hashes. Never copy a profile from another delivery and never rewrite the contract to point back to the profile.
8. Only after both approvals, start the task with that delivery profile and record its receipt.

## Model And Reasoning Policy

Contracts may specify which Codex model and reasoning level spawned agents should use. This is not a domain rule; it is an execution policy for the contract.

Default behavior:

- Set `execution_policy.model.mode` to `inherit`.
- Set `execution_policy.reasoning.mode` to `inherit`.
- Interpret `inherit` as "reuse the main Codex thread settings".

Override behavior:

- Ask the user before setting a model override unless a project artifact already requires it.
- Propose a higher or lower reasoning level when phase risk clearly calls for it, then ask the user before storing the override.
- Store a short `execution_policy.notes` entry when the override changes cost, latency, risk, or review expectations.
- Keep model IDs as free-form Codex model identifiers; do not hardcode a model catalog into prompts or contracts.

Use higher reasoning for phases with broad architectural ambiguity, high-risk implementation, security-sensitive validation, or release decisions. Use inherited reasoning for routine contract generation and normal implementation work unless the user chooses otherwise.

## What To Ask

Ask only questions that change the contract. Good questions include:

- What outcome must this phase produce?
- Who approves this gate?
- Which requirements or files are authoritative inputs?
- Which integrations, APIs, or external systems are in scope?
- Which constraints or non-functional requirements are non-negotiable?
- What counts as evidence that this phase is done?
- What is the requirement's approved autonomy ceiling?
- Is this delivery one named `pull_request` or one named `local_release`, and which level does the user select for it?
- For a PR, which repository/base/head/actions are in scope, and is protected-branch merge excluded?
- For a local release, what exact target, canonical writes/actions, shell-free JSON-argv smoke tests, rollback procedure, and immutable `rollback.verify` rehearsal evidence are required? If local data changes are declared, what exact regular file, logical scopes, immutable dry-run/preview evidence, backup path, and data rollback cycle apply?
- Which contract actions must narrow the selected delivery level or remain checkpoints?
- Should this contract inherit the main Codex thread model/reasoning, or use a specific model or reasoning level?
- Should any required output use an existing approved template, a delta from a base artifact, or a user-approved new structure?

Avoid generic brainstorming questions when the KB already contains enough evidence.

## Autonomy Recommendation And Binding

The agent may recommend `supervised`, `checkpointed`, or `bounded-autonomous` from requirement clarity, unresolved questions, deterministic acceptance tests, reversibility, known tools and write paths, environment, data/security impact, external dependencies, and budget. Give deterministic reason codes and explain the recommendation in plain language. Do not use an opaque trust score, and never treat the number of previous successful runs as authority.

The user selects the level for each delivery. The effective result is the most restrictive of host, project, requirement, delivery, contract, capability, environment, and budget. A contract can narrow its phase but cannot expand any upstream boundary. Multiple requirements use the lowest ceiling.

`bounded-autonomous` requires `host_verified` authority or trusted CI; `audit_only` is capped at `checkpointed`. Any material requirement or delivery drift, new PR, new path/tool/environment, budget extension, secret/external/production access, destructive action, protected-branch merge, or remote deployment stops for a new explicit decision.

## CLI Pattern

Use `--context-file` for authoritative files and `--qa` for answered questions. Ask the user before normal contract creation when questions are still open. Use `--question` with `--allow-incomplete-contract` only for an explicit clarification, migration, or recovery draft. Story contract creation links `story.contract_id` automatically; replacing another contract needs explicit `--replace-story-contract`.

```bash
node <plugin-root>/bin/mpsf.mjs contract create \
  --root <target-project> \
  --phase analysis \
  --context-file .sdlc/requirements/REQ-001.json \
  --context-summary "Analyze the MVP around the approved business workflow." \
  --qa "Who approves this phase?|Product owner" \
  --qa "Which external provider is authoritative for MVP?|Provider selected by the approved requirement" \
  --constraint "Must keep provider-specific logic behind an adapter" \
  --assumption "External provider sandbox access is available" \
  --reasoning high \
  --execution-note "Higher reasoning requested for integration-risk analysis"
```

## Output Rule

Every generated contract should answer:

- Which project is this for?
- Which phase or story does it govern?
- Which immutable requirement revision and requirement execution profile set its ceiling?
- For delivery work, which stable delivery profile ID, kind, and target boundary does it reserve for the later per-delivery selection?
- What contract autonomy cap applies before that selection, and how may it narrow the requirement ceiling?
- Which checkpoints and exception actions remain?
- Which sources informed it?
- Which questions were answered?
- Which questions remain open?
- Which assumptions and constraints shape the work?
- Which artifacts must be produced and validated?
- Which output templates or registry links govern those artifacts?
- Which Codex model/reasoning policy should spawned agents follow?
- Which orchestration scope applies: single story, multiple story lanes, or shared phase artifact?
- Which actor attribution, handoff, lock, and strict gate rules apply?
