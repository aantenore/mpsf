# Requirements, Context, and Contracts

Workflow steps 5–12 of the MPSF skill (`../SKILL.md`). Step numbers are shared across the workflow reference files; the always-on guardrails in `../SKILL.md` apply to every step.

5. Agree the requirement before treating decomposition as canonical. New requirements use `requirement:v2` and move through `propose`, `approve`, `revise`, and `supersede`; `requirement create` is only a compatibility alias for a proposal and must not create approved authority. Capture outcome, acceptance criteria, non-goals, constraints, NFRs, integrations, source hashes, revision lineage, and the linked requirement execution profile. That profile sets an autonomy ceiling and is not an executable grant. A material change creates a new revision and invalidates downstream profiles bound to the prior hash.

   Before proposing implementation work, list every project area that may need a
   durable change, including source, tests, documentation, and evidence.
   Requirement `--write-path` values must resolve inside the project. The CLI
   accepts an internal relative or absolute input but stores a sorted,
   deduplicated Git-relative path; the project root and paths outside it are
   rejected before any proposal is written. An empty requirement scope is
   allowed for governance-only work, but `task start` fails closed before
   preflight for implementation, validation, release, or a contract that names
   durable outputs.

   ```bash
   node <plugin-root>/bin/mpsf.mjs requirement propose \
     --root <target-project> \
     --id REQ-001 \
     --title "Bounded outcome" \
     --summary "Agreed outcome and material scope" \
     --acceptance "Observable acceptance evidence exists" \
     --write-path src \
     --write-path test \
     --write-path docs \
     --write-path evidence \
     --autonomy-ceiling checkpointed

   node <plugin-root>/bin/mpsf.mjs requirement approve \
     --root <target-project> \
     --id REQ-001 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve this requirement revision and ceiling"

   node <plugin-root>/bin/mpsf.mjs autonomy requirement status \
     --root <target-project> \
     --id REQ-001
   ```

   Omitting `--write-path` from `requirement revise` inherits the current
   canonical scope. Supplying one or more values replaces that scope in full;
   restate every path the revision still needs. Approval never rewrites a
   legacy non-canonical proposal: create a new revision first, for example:

   ```bash
   node <plugin-root>/bin/mpsf.mjs requirement revise \
     --root <target-project> \
     --id REQ-001 \
     --new-id REQ-001-R2 \
     --write-path src \
     --write-path test \
     --write-path docs \
     --write-path evidence
   ```

   Do not confuse this requirement scope with a local-release filesystem
   boundary. Requirement paths are stored relative to the Git project;
   delivery `--target-root`, delivery `--write-path`, and `--smoke-cwd` use
   explicit absolute local paths inside the approved release target. The two
   still interact at the final gate: a release destination inside the
   repository must also appear in the requirement scope (see “Choose where the
   result goes” in [`../SKILL.md`](../SKILL.md)).

   After approval, when the requirement needs decomposition, propose a work breakdown and dependency graph, then ask the user to approve or correct it before treating it as canonical. Each story is a separate delivery with its own profile and autonomy choice. When the user wants one pull request or one local release for several parts, propose one delivery story with tasks instead of several stories:

   ```bash
   node <plugin-root>/bin/mpsf.mjs work item create --root <target-project> --type task --id T-001 --title "First part" --story ST-001 --requirement REQ-001
   node <plugin-root>/bin/mpsf.mjs work item create --root <target-project> --type task --id T-002 --title "Second part" --story ST-001 --requirement REQ-001
   node <plugin-root>/bin/mpsf.mjs breakdown propose --root <target-project> --id BD-REQ-001 --requirement REQ-001 --item story:ST-001 --item task:T-001 --item task:T-002
   ```

   Only when parts should ship separately, propose several stories and their dependencies:

   ```bash
   node <plugin-root>/bin/mpsf.mjs breakdown propose --root <target-project> --id BD-REQ-001 --requirement REQ-001 --item story:ST-001
   node <plugin-root>/bin/mpsf.mjs dependency propose --root <target-project> --id DEP-REQ-001 --edge ST-002:ST-001:requires_artifact:validation:artifact_linked
   ```

   An edge whose required state is `merged` (for example `ST-002:ST-001:blocks:implementation:merged`) is satisfied when the upstream story's pull request is merged, by the plugin or by an acknowledged external merge (`autonomy delivery reconcile`), or through the base-branch certification described below. A pull request that is only `ready_for_review` is not enough. A verified merge stays satisfied even when the upstream story's final certification later reads as stale, for example because the dependent story edits files the upstream story certified.

   Any dependency edge is also satisfied when the base branch already holds the upstream story's final certification and, read from there, that story is complete (terminal, not blocked) and meets the edge's required state, even if this branch does not have its records yet. The CLI reads the base tip in a temporary read-only checkout outside the working tree and never changes it.

   If the user later replaces or drops planned stories that were never started, record that decision instead of leaving them as blocked work: `story supersede --from-breakdown BD-REQ-001 --by <delivering-story>` (or `--id <story-id>`) or `story cancel --id <story-id>`, each with `--reason` and a formal approval from the user. Story records are not rewritten. A started story closes only on its own with `--id`, after every delivery bound to it ended `cancelled` or `rolled_back` (never with an active delivery or delivered work); the closure releases its claim. When one story is split into several, repeat `--by` for every replacement. Dependencies on a split story are never moved onto one part automatically: they block as "needs review" until a person decides. Show the user the dependents and the commands that `story supersede` prints, then record the choice with `dependency revise --id <revision-id> --redirect <from>:<old-to>:<new-to>` (repeatable) or `--retire <from>:<to>`, plus `--rationale`, and have the user approve it with `dependency approve`. Never approve a revision on the user's behalf. Approved dependency records are never rewritten; retired edges stay in the graph as history and are no longer evaluated. A dependency message such as `ST-B depends on ST-A → superseded by ST-A2 [in progress (implementation), claimed by <agent> on another computer]` means ST-B waits for ST-A2: it is not a permanent block. See `commands.md`.

6. Before creating a contract, gather project-specific context from `.sdlc/`, user-provided files, repository files, or direct user answers. If critical context, output format, acceptance criteria, delivery target, autonomy choice, or a phase-guiding decision is missing, ask concise questions and stop instead of inventing details or creating a vague contract. Use `--allow-incomplete-contract` only for explicit clarification, migration, or recovery drafts, never to start phase work.
7. Before technical analysis or a contract that depends on project-specific tooling, profile the project/story and propose capability recommendations. Do not keyword-match the user's language. Use repo files, `.sdlc/`, user files, or canonical JSON normalized by Codex:

   ```bash
   node <plugin-root>/bin/mpsf.mjs capability profile propose \
     --root <target-project> \
     --id CAP-PROFILE-ST-001 \
     --story ST-001 \
     --phase analysis \
     --context-file .sdlc/requirements/REQ-001.json

   node <plugin-root>/bin/mpsf.mjs capability profile approve \
     --root <target-project> \
     --id CAP-PROFILE-ST-001 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "<user-approved profile>"

   node <plugin-root>/bin/mpsf.mjs capability inventory --root <target-project> --json

   node <plugin-root>/bin/mpsf.mjs capability recommend \
     --root <target-project> \
     --id CAP-REC-ST-001 \
     --profile CAP-PROFILE-ST-001 \
     --from-inventory
   ```

   Do not ask the user to list what is installed and do not hand-build an available-capabilities file. `capability inventory` is read-only: it lists the skills, commands, plugins, and MCP servers already installed for the user and the project, from the well-known local locations of both supported agent hosts and the locations configured in `capability_discovery_policy.inventory`. It keeps only names, one-line descriptions, plugin versions, and a server's transport type (never arguments, environment, headers, or URLs), shows project- or `~`-relative paths, and makes no network call. `capability recommend --from-inventory` then proposes only the installed entries whose name or description names a technology declared by the approved profile (its detected stack and integrations); it never matches the wording of the request, and unrelated user-level tools are not written into the record (only a count is kept). Use `--available-capabilities-json` or `--available-capabilities-file` only for tools the inventory cannot see; the two inputs cannot be combined. The result is still a proposal that the user approves. When the project has a capability catalog (`.sdlc/capability-discovery/catalog.json`), the inventory, recommendations, and suggestions keep only the tools it declares; adding a tool to it is the user's decision.

   `task start` and `status` may return a `capability_suggestion` when the story has no capability recommendation yet and installed tools match its declared technology. Mention it in one plain sentence: which installed tools look relevant, that nothing is used or approved yet, and, if the user wants them considered, run the listed `commands`, returned with `--json-profile full` (profile first when none is approved, then `recommend --from-inventory`). A suggestion never approves, binds, or installs anything.

   Ask for approval before installing missing skills/plugins or using external, write, production, tenant, workspace, endpoint, or secret-bearing targets. When presenting internal capability artifacts, do not teach the SDLC model to the user. Translate them into business/work language: "project evidence and boundaries" means the files, checks, and tool limits I may rely on; "allowed tools for this work" means the concrete tools, permissions, targets, and install decisions I want to use. Explain whether you need more information, whether installs or external access are involved, what approval allows, and what it does not approve. When `capability profile propose` or `capability recommend` returns `assistant_message`, show the business-facing explanation instead of summarizing only IDs. The explanation must be large enough to approve from chat: say what artifact was produced, what is inside it, what decision is needed, and what approval does not cover. If a CLI freshness/hash/stale check appears, do not expose those internal terms as the primary explanation. Say what it means operationally: for example, "I am refreshing the internal reference to the approved tools boundary; this does not change what you approved." Ask again only if the allowed files, tools, installs, external access, output, or work scope changed. Use `capability approve --approve-install` only when that installation approval was explicitly granted.

   Formal SDLC approvals are not implied by a user asking the agent to implement or push. A direct human or CI approval needs host- or CI-issued evidence; an agent-supplied `actor-type human` flag is not authority. By default, a short approval such as "ok", "yes", or "approve" applies only to the immutable subject immediately shown. Assessment checkpoint 2 must create a host approval receipt and proposal-bound content authorization with exact actions, subject hashes, artifact types, use policy, and authority assurance. Every automated use records a validity-at-use receipt. Free-text scope is not an automation credential. A broader delegated scope can cover later artifacts only inside the same immutable delivery unit. Free-text scope never covers another pull request or local release. Only two records the person creates themselves reach further: an approval delegation (`--approval-source delegated --delegation <DLG-id>`), and only for the action classes it lists, such as `delivery.policy` or `delivery.approve`; and a standing approval (`--standing-approval <id>`), only for the repeated low-risk delivery and limits it names. Delegated automation never covers installs, protected-branch merge, remote deploys, secrets, external services, production, destructive actions, or unrelated work unless the exact action and target were explicitly displayed and authoritatively approved. Use bootstrap only for migration/provisional records; it does not satisfy strict gates by default.

8. Decide the contract execution policy and capability policy with the user only when it matters. By default, leave model and reasoning as `inherit`, which means spawned Codex agents reuse the main Codex thread settings. Set `--model`, `--reasoning`, capability policies, capability bindings, or `--capability-recommendation` only when the user asks, the approved capability recommendation says so, or the project KB mandates them.
9. Before creating a phase/story contract that will produce a durable output, resolve the output type. If there is no approved output template for that step/type, propose the template, summarize it to the user using the returned `assistant_message` or `approval requests`, and stop. Do not create a contract that references a draft template and do not produce the phase output until the user agrees the format:

   ```bash
   node <plugin-root>/bin/mpsf.mjs output resolve --root <target-project> --story ST-001 --type functional-analysis
   node <plugin-root>/bin/mpsf.mjs output template propose --root <target-project> --type functional-analysis --summary "..."
   node <plugin-root>/bin/mpsf.mjs approval requests --root <target-project> --story ST-001
   ```

   Every newly created delivery story must include at least one observable
   `--acceptance` criterion before contract/profile setup. If an older story is
   missing criteria, never repair it with `story create --force`: creation is
   intentionally non-overwriting. Before task start, use the additive,
   story-locked recovery command:

   ```bash
   node <plugin-root>/bin/mpsf.mjs story acceptance add \
     --root <target-project> \
     --id ST-001 \
     --acceptance "<observable story-level success criterion>" \
     --summary "Complete the story definition before task start"
   ```

   This command preserves exact requirement refs, the historical contract
   reference, breakdown links, phase/status, audit origin, plan, and
   implementation log. It refuses terminal, claimed, already-started, or
   partially completed stories and unsafe workspace or trace files. If a
   contract already exists, the changed definition marks it for mandatory
   replacement: create and approve a new contract ID, and use a new delivery
   profile ID when that contract reserves one. Existing active delivery
   profiles remain stale by design and cannot be reused. `task start` stays
   fail-closed until these exact bindings are current. Do not bypass that
   freshness check.

10. Create or locate the story first, then create its final phase contract before doing phase work. It must include enough agreed context, zero unresolved open questions, exact requirement execution profile references, and `--output-ref` for durable story outputs. When delivery work is in scope, reserve a new stable profile ID and store it through `--delivery-profile`; this writes only the planned `delivery_execution_profile_id`, not a delivery-profile hash or approval. Approve the contract before step 13 creates the matching profile against the approved hashes. Never rewrite the approved contract to point back to that profile. A contract or phase override may narrow the effective autonomy level but never widen it.

   When a delivery of a started story ends `cancelled` or `rolled_back`, continue the same story with exactly one new delivery rather than inventing a replacement story: a new contract ID with `--replace-story-contract` and a new `--delivery-profile`, its approval, a new profile with a fresh autonomy choice, `story release`, `task start` with the new contract and profile, then `story claim` again. The workflow run and completed phases are kept and the new task start links the replaced delivery. `story claim` refuses a story whose current contract still points to a cancelled, closed, rolled-back, superseded, or revoked delivery, so the claim always rests on the new contract and its task start. Active, released, merged (also outside the plugin), or ready-for-review deliveries cannot be replaced; the same rule applies to stories without a workflow binding.

   Story contract creation auto-populates `story.contract_id`; use `--replace-story-contract` only for explicit renegotiation or recovery. Contract creation is a proposal, not approval to proceed. Summarize the complete contract through `approval requests` and stop until the user explicitly approves, answers, requests changes, or has already granted a broader contract-approval scope that clearly covers it. A broader contract approval never supplies the mandatory autonomy choice for a new delivery unit.

   Show the returned `assistant_message` whenever available: it explains what is being approved, what approval means, and what happens next. When `assistant_message_presentation.translate_to_chat_language` is true, translate and contextualize it in the active chat language while preserving artifact IDs, story IDs, contract IDs, template IDs, file paths, CLI commands, status codes, and schema keys. Inside an agent session `--json` returns the compact agent profile, which omits `assistant_message_presentation` (translate into the active chat language by default) and reduces nested records such as `capability_suggestion` to identity fields, so its `commands` are not included. Rerun with `--json-profile full` when you need those fields. Keep the primary explanation non-technical and business-facing: say "project context" before baseline, "project evidence and boundaries" before capability profile, "allowed tools for this work" before capability recommendation, "assessment format" before template, and "work brief" before contract. For every prepared artifact, show what it contains, what decision is needed, what is missing, what approval authorizes, and what it does not authorize. Give enough detail for a decision in chat; do not make JSON or Markdown the primary approval flow. Approval scope is single-use and artifact-specific unless the user explicitly grants a broader in-delivery scope. Ask again for every new delivery unit. Do not produce technical/functional analysis, implementation outputs, tests, or release evidence before the contract is approved:

   ```bash
   node <plugin-root>/bin/mpsf.mjs story create --root <target-project> --id ST-001 --title "..." --requirement REQ-001 --acceptance "<observable story-level success criterion>"
   node <plugin-root>/bin/mpsf.mjs contract create \
     --root <target-project> \
     --phase <phase> \
     --story ST-001 \
     --context-file .sdlc/requirements/REQ-001.json \
     --context-summary "Project-specific summary" \
     --qa "Who is the target user?|Back-office operators" \
     --capability-recommendation CAP-REC-ST-001 \
     --delivery-profile AUT-PR-184 \
     --output-ref functional-analysis:functional-analysis-v1:new
   node <plugin-root>/bin/mpsf.mjs approval requests --root <target-project> --story ST-001
   ```

11. Before creating a durable output artifact, resolve the project-wide output contract:

   ```bash
   node <plugin-root>/bin/mpsf.mjs output resolve --root <target-project> --story ST-001 --type functional-analysis
   ```

   If an approved template exists, use it. If a related story already covers the same requirement, prefer reuse plus delta. If no template exists or the structure must change, propose a template and ask the user to approve it before making it canonical:

   ```bash
   node <plugin-root>/bin/mpsf.mjs output template propose --root <target-project> --type functional-analysis --summary "..."
   node <plugin-root>/bin/mpsf.mjs output template approve --root <target-project> --id functional-analysis-v1 --actor-type human --approval-source explicit-user --summary "<user-approved template>"
   ```

12. Confirm how every durable output will link back to story, requirement, approved template, and mode, but do not create or link an implementation/release output before the final contract, delivery profile, and task start are approved. After execution produces the artifact, run `output link` before completing the phase lane. `output link` requires the story contract to be approved and fresh unless `--allow-unapproved-contract-output` is being used for explicit migration/recovery. The CLI records fingerprints, and strict gates fail if the artifact, base artifact, or approved template changes after linking:

   ```bash
   node <plugin-root>/bin/mpsf.mjs output link \
     --root <target-project> \
     --story ST-001 \
     --type functional-analysis \
     --artifact .sdlc/requirements/functional-analysis.md \
     --template functional-analysis-v1 \
     --mode new \
     --requirement REQ-001
   ```

   `--render-evidence` is reserved for render or visual verification of the
   produced output: a PNG, JPEG, WebP, or PDF render, or a typed
   `render-verification-receipt:v1` JSON file. It is not functional or test
   evidence; record those with `story complete-step` or `trace append`.
   `--evidence` remains accepted by `output link` only as a compatibility
   alias for the same render-only input.
