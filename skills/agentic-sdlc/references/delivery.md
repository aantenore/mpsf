# Delivery: Working Mode, Profile, Task Start, and Delivery Actions

Workflow step 13 of the MPSF skill (`../SKILL.md`). Step numbers are shared across the workflow reference files; the always-on guardrails in `../SKILL.md` apply to every step.

13. Before every delivery, ask for and obtain one fresh working-mode choice. Never inherit, infer, or reuse the choice from an earlier delivery, even when it implements the same approved requirement. First show only the concrete destination, files that may change, actions that remain protected, expiry, and material risks in normal product language. Before listing the choices, state whether the most independent option can actually be effective in this installation; if approver identity cannot be digitally verified, explain that selecting option 3 will produce the effective “Autonomy with checkpoints” mode. Likewise, when the approved requirement maximum (or the approved contract level) is below an option, say so before the user answers: that option is still accepted and recorded as the user's choice, but it is capped to the approved maximum. Pass the user's actual answer as `--level` (never pre-lower it), and relay the guidance that states the choice was capped and which mode is effective. Do not lead with internal levels, policy modes, record IDs, hashes, or approval-evidence terminology. A delivery execution profile remains deliberately exact and non-reusable: one story, its one approved contract, and one concrete delivery. If several stories must ship together, agree an aggregation story and contract first.

   For a pull request, ask in the user's language. In Italian, use this copy:

   > Per questa PR, quanto vuoi che lavori in autonomia?
   >
   > 1. Guidato: ti chiedo conferma prima dei passaggi importanti.
   > 2. Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.
   > 3. Autonomia completa entro questi limiti: completo questa PR senza pause ordinarie.
   >
   > Questa scelta vale solo per questa PR e non sarà riutilizzata.

   For a local release, use a separate question; never combine the two destinations in one autonomy question:

   > Per questo rilascio locale, quanto vuoi che lavori in autonomia?
   >
   > 1. Guidato: ti chiedo conferma prima dei passaggi importanti.
   > 2. Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.
   > 3. Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie.
   >
   > Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata.

   Map the explicit answer internally only after the plain-language choice: `Guidato` → `supervised`, `Autonomia con controlli` → `checkpointed`, and `Autonomia completa entro questi limiti` → `bounded-autonomous`. The `--level` value is mandatory for every proposal and must come from this delivery's current answer; past choices may inform a recommendation but never supply the value. Keep the complete JSON record for machine processing and place its IDs, codes, hashes, exact actions, and policy calculations only after `Technical details (optional):` or `Dettagli tecnici (facoltativi):`.

   For a pull request, ask a second question at this same step, before `task start`. It is separate from the autonomy question, it is never asked for a local release, and it applies to this story only. In Italian, use this copy:

   > Vuoi una revisione del codice prima del merge di questa PR?
   >
   > 1. No: il plugin completa la PR in piena automazione (consigliato per questa storia).
   > 2. Sì: prima del merge una persona che non è autore dei commit deve approvare il codice. Fino al merge tutto procede in automatico.
   >
   > Questa scelta vale solo per questa storia.

   In English:

   > Do you want a code review before this PR is merged?
   >
   > 1. No: the plugin completes the PR in full automation (recommended for this story).
   > 2. Yes: before the merge, a person who did not author the commits must approve the code. Everything before the merge proceeds automatically.
   >
   > This choice applies only to this story.

   Suggest option 1 by default. When the story touches security, authentication, payments, data migrations, public APIs, or infrastructure, suggest option 2 instead and move “(consigliato per questa storia)” / “(recommended for this story)” from option 1 to the end of option 2's first sentence. Never inherit the answer from an earlier story or delivery: past answers may only inform the suggestion. If `gate_policy.merge_requires_code_review` is `true`, the project already requires a review for every pull request; say so when you ask, because a “No” does not lower it.

   The answer is a formal decision by the user. Do not propose the delivery or start the task without it, and never answer for the user. Record it on `autonomy delivery propose` with `--code-review required` (“Sì”/“Yes”) or `--code-review not-required` (“No”), together with `--code-review-actor-type human --code-review-approval-source explicit-user --code-review-summary "<the user's words>"` and, when the person is known, `--code-review-actor <person-id>`. The CLI rejects an agent or system choice, and refuses `--code-review` for a local release. It is stored in the approved, hash-bound delivery profile as `pull_request_target.code_review`; a delivery that carries it cannot be approved with `--approval-source automation`. A covered standing-approval delivery does not ask again (see “Standing approvals for repeated toil”). A profile approved before this question existed has no answer and follows the project default without blocking or asking.

   If the person granted a delegation covering `delivery.policy` that answers code review, do not ask again: pass `--approval-source delegated --delegation <DLG-id>` (with `--actor-type agent`) and omit `--code-review`; the profile records their delegated answer as `source: delegation`. Never grant or widen a delegation yourself.

   The requirement is checked only at `pull_request.merge` and, for a merge made outside the plugin, on the merged head when `autonomy delivery reconcile` records it. Commits, push, pull-request create and update, closing as `ready_for_review`, and every gate, including `gate check --strict --lifecycle-complete`, proceed without a review. To change the answer after approval, see the code review paragraphs below.

   Ask a third question at this same step, before `task start`, also only for a pull request and for this story only: how merging should work. In Italian, use this copy:

   > Come vuoi gestire il merge di questa PR?
   >
   > 1. Lo faccio io su GitHub: il plugin non esegue mai il merge. Quando l’hai fatto, lo comunichi al plugin, che lo registra.
   > 2. Dopo la tua conferma: il plugin esegue il merge solo dopo che hai confermato un punto di controllo (consigliato per questa storia).
   > 3. In automatico: il plugin esegue il merge appena tutti i controlli sono superati, senza chiedere conferma. Non disponibile con “Guidato”.
   >
   > Questa scelta vale solo per questa storia.

   In English:

   > How should merging this PR work?
   >
   > 1. I merge it on GitHub: the plugin never merges. Once you have, you tell the plugin, which records it.
   > 2. After your confirmation: the plugin merges only after you confirm a checkpoint (recommended for this story).
   > 3. Automatically: the plugin merges as soon as every check passes, without asking. Not available with “Guided”.
   >
   > This choice applies only to this story.

   Suggest option 2 by default, and option 1 when the user says they merge on GitHub themselves. Offer option 3 only when the autonomy choice is not `Guidato`/“Guided”. Never inherit the answer from an earlier story or delivery. It is a formal decision by the user: do not propose the delivery or start the task without it, and never answer for the user. Record it on `autonomy delivery propose` with `--merge manual|after-confirmation|automatic` (options 1, 2, 3), together with `--merge-actor-type human --merge-approval-source explicit-user --merge-summary "<the user's words>"`. Option 3 also needs `--merge-allowed` and `--allow-action pull_request.merge`. It is refused when the level is `supervised`, whether you chose it or the approved ceiling caps a higher level to it, and it cannot be combined with `--standing-approval`. It is stored in the approved, hash-bound profile as `pull_request_target.merge_decision` (`mode`, `source`, `actor_id`, `user_words`, `decided_at`). With `manual` the plugin never merges: the person merges on GitHub, then acknowledges it with `autonomy delivery reconcile` (below). With `after-confirmation` the plugin merges after the `pull_request.merge` checkpoint the person confirms. With `automatic` it merges once every gate passes, without that checkpoint.

   If the person granted a delegation covering `delivery.policy` that answers merge, do not ask again: pass `--approval-source delegated --delegation <DLG-id>` (with `--actor-type agent`) and omit `--merge`; the profile records their delegated answer as `source: delegation`. Never grant or widen a delegation yourself.

   To change the merge choice after the profile is approved, or to allow merge or add a write path, the person formally approves `autonomy delivery amend --id <profile-id> [--merge-allowed] [--merge <mode> --merge-actor-type human --merge-approval-source explicit-user --merge-summary "<the user's words>"] [--add-write-path <path>]`. This records a new revision of the same profile and needs no new contract. It is refused once the affected action has run (for example, a write path already touched by a governed commit), and it never goes beyond the approved requirement and contract; see commands.md.

   For a new pull request:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-PR-184 \
     --delivery PR-184 \
     --kind pull_request \
     --story ST-001 \
     --contract contract-ST-001-implementation \
     --requirement REQ-001 \
     --level checkpointed \
     --repository owner/repository \
     --base main \
     --head feature/ST-001 \
     --write-path src \
     --allow-action repository.write \
     --allow-action test.run \
     --allow-action git.commit \
     --allow-action git.push \
     --allow-action pull_request.create \
     --allow-action pull_request.update \
     --code-review not-required \
     --code-review-actor-type human \
     --code-review-approval-source explicit-user \
     --code-review-summary "<the user's words>" \
     --merge manual \
     --merge-actor-type human \
     --merge-approval-source explicit-user \
     --merge-summary "<the user's words>" \
     --json
   ```

   For an existing pull request, resolve and display its exact repository, base, head, current SHA, and PR URL. Propose with `--pr-mode existing`, the exact `--pr-number` and `--pr-url`, and `--pr-head-sha` when the local head branch cannot supply the reviewed head. Omit `pull_request.create` and keep only the approved update actions. The CLI pins that PR and reviewed head, and refuses an action on a different PR or on a head that does not descend from the reviewed commit:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-PR-185 \
     --delivery PR-185 \
     --kind pull_request \
     --pr-mode existing \
     --pr-number 185 \
     --pr-url https://github.com/owner/repository/pull/185 \
     --story ST-002 \
     --contract contract-ST-002-implementation \
     --requirement REQ-002 \
     --level checkpointed \
     --repository owner/repository \
     --base main \
     --head feature/ST-002 \
     --write-path src \
     --allow-action repository.write \
     --allow-action test.run \
     --allow-action git.commit \
     --allow-action git.push \
     --allow-action pull_request.update \
     --code-review required \
     --code-review-actor-type human \
     --code-review-approval-source explicit-user \
     --code-review-summary "<the user's words>" \
     --merge manual \
     --merge-actor-type human \
     --merge-approval-source explicit-user \
     --merge-summary "<the user's words>" \
     --json
   ```

   For a local release:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-LOCAL-REL-009 \
     --delivery LOCAL-REL-009 \
     --kind local_release \
     --story ST-001 \
     --contract contract-ST-001-release \
     --requirement REQ-001 \
     --level bounded-autonomous \
     --target-root /absolute/project/.local-release \
     --write-path /absolute/project/.local-release/app \
     --allow-action build.local \
     --allow-action test.run \
     --allow-action release.local \
     --smoke-cwd /absolute/project/.local-release/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --rollback "Restore the previous local package and restart the local process" \
     --json
   ```

   A new local `--target-root` may be absent while the delivery is only being
   proposed, reviewed, approved, or started. It must exist as a real,
   non-symlinked directory before `rollback.verify`, `data.migrate`,
   `data.rollback`, or `release.local` is authorized. Govern creation instead
   of running an untracked `mkdir`: after task start, request `build.local`
   without `--confirm-action` first. If and only if the response is
   `checkpoint_required`, show the exact paused decision and repeat the request
   with direct human or CI approval attribution. A non-checkpointed request can
   return its authorization immediately and must not be confirmed a second
   time. Only while executing the resulting exact authorization may the
   external builder create the exact target root, its approved write-path
   children, and the artifact. Then complete `build.local` with immutable
   evidence. The CLI deliberately creates no release directory itself.

   A destination inside the repository must be ignored by Git (for example
   `/.local-release/` in `.gitignore` or `.git/info/exclude`), or placed
   outside the repository. The proposal lists any in-repository destination
   Git can see under `review.destinations_visible_to_git` with a warning. Its
   files count as story changes: the strict write-scope check accepts them only
   after the delivery is released and only while the destination still matches
   the smoke-tested artifact manifest. Runtime data written there later, any
   edited file, or a file the repository already tracked there before the
   story started fails the lifecycle-complete gate. When the released app
   stores data at runtime, point that data directory outside the destination
   in the app's configuration, and tell the user that running the app from the
   destination before certification will otherwise invalidate it.

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local \
     --json
   ```

   Only when that first response is `checkpoint_required`, repeat it with the
   displayed direct approval:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Authorize creation and build of this exact local target" \
     --json
   ```

   The external builder may now create only the approved root, children, and
   artifact. Complete the same authorization afterward:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-build-authorization> \
     --evidence evidence/local-build.json \
     --json
   ```

   Passing `build.local` completion records the content manifest (paths,
   modes, sizes, SHA-256) of every approved write path; later
   `rollback.verify` and `release.local` require the destination to match it.
   A recreated write path with identical content is accepted; a replaced root,
   a symlink, or different content is refused. To update an existing release,
   propose the destination plus a backup write path, then inside one open
   `build.local` authorization copy the current release into the backup and
   install the new build; complete `build.local`, rehearse the rollback
   without touching the destination, record `rollback.verify`, then
   `release.local`. If smoke fails, restore the backup and close the delivery
   `--terminal-status rolled_back`. Never install files at release time; if
   the destination changed after the build, request `build.local` again.

   When the local delivery changes a data file, add both typed actions and bind
   the reversible boundary at proposal time:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-LOCAL-DATA-009 \
     --delivery LOCAL-DATA-009 \
     --kind local_release \
     --story ST-001 \
     --contract contract-ST-001-release \
     --requirement REQ-001 \
     --level checkpointed \
     --target-root /absolute/project/local-data \
     --write-path /absolute/project/local-data/app \
     --write-path /absolute/project/local-data/data \
     --smoke-cwd /absolute/project/local-data/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --allow-action data.migrate \
     --allow-action data.rollback \
     --allow-action release.local \
     --data-target /absolute/project/local-data/data/store.json \
     --data-scope 'records[*].schemaVersion' \
     --migration-preview evidence/migration-preview.json \
     --backup-path /absolute/project/local-data/data/store.before.json \
     --rollback "Restore store.json byte-for-byte from store.before.json" \
     --json
   ```

   `data.migrate` and `data.rollback` are always separate checkpoints. The CLI
   never accepts migration shell text or performs the mutation. Authorize the
   exact action, execute it externally, then complete it with immutable
   evidence. The local observer proves target and backup hashes and rejects a
   no-op rollback whose target already matched the backup. For a declared data
   migration, `rollback.verify` binds that exact passing rollback receipt.
   `release.local` cannot even be authorized until the bound rollback
   verification and a later passing migration exist.

   Every new local release also includes `rollback.verify`, even when no data
   migration is declared. Authorize it with immutable rollback-rehearsal
   `--evidence`, then complete it with the exact same evidence. The provider
   binds the local root, write paths, rollback procedure, and evidence hashes
   but executes no command. A passing receipt must exist before
   `release.local`; for data migrations it must bind the exact passing
   `data.rollback` receipt. Missing, changed, or out-of-order evidence blocks
   release before terminal close and also blocks the final lifecycle gate.

   Approve and inspect the exact profile:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery approve \
     --root <target-project> \
     --id AUT-PR-184 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Select checkpointed autonomy for PR-184 only"

   node <plugin-root>/bin/mpsf.mjs autonomy delivery explain \
     --root <target-project> \
     --id AUT-PR-184
   ```

   Before the user chooses, when this installation cannot digitally verify the approver, use this primary explanation in Italian:

   > Questa installazione registra l'approvazione ma non può verificare digitalmente chi l'ha data. Se scegli l'opzione 3, il livello effettivo sarà quindi “Autonomia con controlli”: potrò procedere tra i momenti di revisione concordati, ma non in autonomia completa.

   Only after the optional technical-details divider, explain that `audit_only` narrows requested `bounded-autonomous` to effective `checkpointed`. Explain the practical effect and how to enable verification: a trusted external host or CI issues an Ed25519-signed receipt for the exact delivery-profile approval subject; configure `authority_policy.mode: host_verified` and the matching public key in `authority_policy.trusted_host_keys`, then pass it with `autonomy delivery approve --host-receipt-file <path.json>`. The CLI validates external authority and never mints trusted authority for itself.

   Verify that the approved profile ID equals the planned `delivery_execution_profile_id` in the already approved contract. Before `task start` and before completing any story step, start exactly one current story-bound workflow. The included `software-project` v3 definition is valid only when the project uses its exact seven-phase order. If `phase_order` contains, removes, or reorders a phase, propose and approve a story-bound definition with that exact order first; do not force the included preset across a custom configuration:

   ```bash
   node <plugin-root>/bin/mpsf.mjs workflow instance start \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --definition software-project \
     --definition-version 3 \
     --story ST-001
   ```

   For a first custom phase, use the complete distributed overlay
   `<plugin-root>/templates/workflow-software-project-v3-integration-review`
   (for new projects, initialize with `--template-dir` as described in step 1
   of `project-setup.md`). Then copy its definition into the target project, edit that project-local copy,
   propose, review, approve, and start it:

   ```bash
   cp \
     <plugin-root>/templates/workflow-software-project-v3-integration-review/workflow-definition.json \
     <target-project>/workflow-software-project-v3-integration-review.json

   node <plugin-root>/bin/mpsf.mjs workflow definition propose \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1 \
     --definition-file workflow-software-project-v3-integration-review.json

   node <plugin-root>/bin/mpsf.mjs workflow definition show \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1

   node <plugin-root>/bin/mpsf.mjs workflow definition approve \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve the displayed eight-phase workflow"

   node <plugin-root>/bin/mpsf.mjs workflow instance start \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --definition software-project-integration-review \
     --definition-version 1 \
     --story ST-001
   ```

   The companion `sdlc-config.json` contains the same `integration-review`
   phase and exact `phase_order`. For an untouched plain init with no governed
   work, compare and copy that complete config, then run `config migrate`
   without `--apply` and apply only its displayed `plan_hash`. Do not overwrite
   a customized or active project's full config; merge and review its intended
   config change separately. Never splice the phase into config as an
   undocumented workaround.

   Author-edited definition input is limited to `label`, `description`,
   `initial_state`, `states`, `transitions`, `phase_order`,
   `normal_checkpoints`, and `metadata`. The CLI derives `id`, `version`,
   `kind`, `schema_version`, `status`, `created_at`, `approval`,
   `definition_hash`, and `hash_algorithm`. `--definition-file` accepts only a
   path inside the target project, so never reference the mutable plugin copy
   directly.

   Starting a workflow after a task-start receipt or completed step is deliberately rejected. A legacy task without this pre-task binding may continue, but `--lifecycle-complete` cannot certify it and a post-hoc replay is not a repair.

   Only now make the lifecycle's one logical task-start decision with that profile. Do not use `task start` for preview, routing, requirement discovery, or contract preparation. Task start is automatic only when the effective level is not `supervised` **and** the current phase appears in that level's configured `autonomy_policy.presets.<level>.automatic_phases`. If the CLI requires `--confirm-start`, the explicit confirmation completes this same logical start decision; it does not reopen planning or create a second delivery start. Use `--confirm-start` only after the user confirms this concrete start or with an authorization containing `task.start.confirm`; an agent or system confirmation must cite that grant with `--authorization <id>`. The stock `checkpointed` preset makes analysis, design, implementation, and validation automatic, while keeping release actions checkpointed. Do not rewrite the contract:

   ```bash
   node <plugin-root>/bin/mpsf.mjs task start \
     --root <target-project> \
     --story ST-001 \
     --delivery-profile AUT-PR-184 \
     --intent-json '<canonical-route-intent-json>' \
     --json
   ```

   The effective level is the minimum of host, project, requirement, delivery, contract, capability, environment, and budget. The profile is non-reusable, permits one concurrent run, and closes when terminal. Protected-branch merge, remote deployment, production access, destructive work, and material drift are explicit exceptions.

   Every state-changing delivery action uses an authorize → execute → complete sequence. In the primary explanation say what operation is paused, its concrete target, what the person must decide, and what remains untouched. Put the internal receipt, canonical action, policy mode, codes, hashes, and command only after the optional technical-details divider. First request an authorization receipt for the exact canonical action and runtime target, and retain the returned `AUT-ACT-...` ID with the external operation. If the command reports `checkpoint_required`, show the plain-language decision and rerun with `--confirm-action` plus formal approval attribution. Under `authority_policy.mode: host_verified`, this rerun must also supply `--host-receipt-file`; the external Ed25519 receipt signs action `autonomy.delivery.action.<canonical-action>` and the exact subject containing the profile, delivery, runtime target, and action details. In `audit_only`, the explicit approval is recorded but does not become host-verified authority. Then execute exactly the recorded operation through the host/tooling. Finally report `--outcome` with immutable evidence and pass `--authorization-receipt <AUT-ACT-id>` whenever more than one authorization for that action is waiting. An identical completion retry is safe and returns the original completion; do not change evidence or operation arguments merely to force a retry. For `git.commit`, bind the exact changed files with repeatable `--scope-path`; for `git.push`, bind the matching remote; for merge, bind the exact PR URL:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.commit --scope-path src/example.mjs --json

   # Execute exactly one non-merge commit whose parent and file set match the receipt.
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.commit --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-authorization> \
     --evidence evidence/PR-184-commit.txt --json

   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.push --remote origin --json
   # Push the exact recorded SHA/ref, collect host or provider evidence, then complete it.
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.push --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-authorization> \
     --evidence evidence/PR-184-push.json --json
   ```

   **Two parallel stories touching the same file.** When another story merged first and this branch needs its change (for example a shared `src/index.ts` export file), fast-forward or rebase the branch onto the base branch; never create a merge commit. The story's changed-path perimeter then counts only its own commits: commits of other stories' merged deliveries are left out, while its own edit of the shared file still counts. A first story merged on GitHub outside the plugin must be recorded with `autonomy delivery reconcile` before this works. `git.commit` and `git.push` refuse a branch that carries commits since the task start that are neither the story's own nor part of a merged delivery; follow the refusal (`git reset --keep <sha>` back to the last merged delivery, then fast-forward only onto merged work) instead of working around it. Commits touching only `.sdlc/` and a commit followed by its exact revert never block. A commit pushed straight to the base branch is accepted only by a person: ask them to run `story base acknowledge --id <story> --commit <sha> --reason <why> --actor-type human` in their own terminal; never run it yourself unless the person granted a delegation covering `base.acknowledge`; then run it with `--actor-type agent --approval-source delegated --delegation <DLG-id>`. Run `task start` and `story claim` at the start of development, not at integration time. Since a story's perimeter counts only its own commits once other stories merged, the shared claim can protect the work from the first moment. Use `story reserve` when the story cannot start yet. Stories already started from an earlier main are not blocked once another one merges and the context is refreshed: files produced by other stories' merged deliveries after their start are accepted by the context check (also for a replacement delivery) and left out of their perimeter.

   An `authorized` receipt grants only the displayed operation; it does not run it. Push authorization observes the base SHA directly on the selected remote, requires exactly one passing `git.commit` completion for every commit from that SHA to the exact head, and rejects the remote if any configured fetch/push URL identifies another repository. Push/merge authorization records a live remote pre-state, and completion queries the exact Git remote or GitHub PR for the expected post-state after authorization. That observation and the declared evidence are hash-bound, but the observation is not a provider-signed offline attestation; retain durable host/CI/provider evidence and do not call a generic file signed proof. A passing `pull_request.merge` completion or `release.local` completion creates the terminal close receipt automatically; do not manually close either as `merged` or `released`. A pull request whose delivery excludes merge ends successfully open for review: after its last passing `pull_request.create` or `pull_request.update` completion, with no later commit, push, or PR action, close it as `ready_for_review`. That close binds the verified PR completion under the already approved profile and needs no new approval; it is refused when the profile includes `pull_request.merge`. Other terminal outcomes use `autonomy delivery close` with a formal reason and approval, and cannot certify lifecycle success.

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery close \
     --root <target-project> --id AUT-PR-184 \
     --terminal-status ready_for_review \
     --reason "The pull request is open for review at its verified head" \
     --json
   ```

   **A pull request merged outside the plugin.** When a person merges a plugin-managed pull request directly on GitHub, the plugin does not see it. `status` detects the clear cases read-only (a head the plugin's receipts cover is already on the remote base branch; payload key `merged_outside_plugin`) and prints the command, but never records anything. A squash or rebase merge leaves no trace in git, so `status` cannot detect it; `reconcile` still works. Only a person or CI acknowledges the merge, in their own terminal; the command is refused inside an agent session, and the hooks deny it to agents and protect `.sdlc/autonomy/executions/<id>/external-merge.json`. Give the user the exact command and never run it for them:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery reconcile \
     --root <target-project> --id AUT-PR-184 \
     --pr-url https://github.com/owner/repository/pull/184 \
     --actor-type human --approval-source explicit-user \
     --summary "<the user's words>"
   ```

   The plugin checks with `gh pr view` that the pull request is `MERGED` with a merge commit and `mergedAt`; that it was merged no earlier than the plugin's last recorded action; that the merged head equals the head the plugin's receipts cover (the latest passing `git.push` or `pull_request.create`/`pull_request.update`, or the pinned reviewed head of an existing PR); and that the PR URL, head branch, and base branch are the approved ones. A pull request with commits the receipts do not cover, or any mismatch, is refused with the reason and nothing is recorded. The same code review rule as a governed merge applies to the merged head. On success it writes the receipt `external-merge.json` (merge commit, `mergedBy`, `mergedAt`, verified head, the person's approval). A started delivery closes as `merged_externally`; a delivery already closed as `ready_for_review` keeps that close untouched and gains the receipt beside it. No existing record is rewritten, and repeating the command changes nothing. This is never reported as a governed merge.

   Downstream, the story counts as delivered, and `gate check --strict --lifecycle-complete` may pass, but its final certification check carries the reduced label `certification: "externally_reconciled"`. `autonomy delivery checks` shows an “external merge” row, and the Change Observatory labels it “Merged outside the plugin” (“Unita fuori dal plugin”).

   **A story merged but still open.** Story records move only through recorded lifecycle steps, so a pull request merged by hand, or by an agent that stopped before recording completion, leaves the story `available` on every computer, with or without a delivery. `status` reports such stories read-only (payload key `merged_but_open`), from git alone after its fetch: a first-parent commit of the remote base branch that merges one of the story's branches or whose subject names the story id (commits that only change `.sdlc` records, and reverts, never count). It never changes a record. Tell the user which story looks merged and at which commit. When `status` says the story's records are blocked, follow the cause and correction it gives (`lifecycle_reason`, `lifecycle_errors`, `lifecycle_remedy`) instead of recording more steps; otherwise, when the work is really delivered, record the remaining steps with `story complete-step` until the story closes (and, when a started delivery exists, give the user the `autonomy delivery reconcile` command). If the match is wrong (the id was only mentioned), say so. `orchestration_policy.merge_drift` sets the base branch (default: the remote's default branch), whether subjects count, how much history is read, or turns it off.

   For local release completion, repeat the exact approved shell-free smoke-test argv and rollback. The smoke working directory is governed by `--smoke-cwd`, must be equal to or inside one allowed write path, defaults to the only allowed write path, and is mandatory when several write paths are allowed. Shells, indirect dispatchers, inline interpreter code, and ambiguous loaders are rejected. An explicit interpreted entrypoint must resolve inside an allowed artifact path; package managers may use only `test` or one reviewed `run <script>` from a real, non-symlinked `package.json` in that exact directory. Before spawning, the CLI durably records an attempt that consumes the v3 authorization and binds the plugin build, sandbox, resolved launcher/runtime, explicit payload paths and pre-smoke artifact manifest. It runs from the exact released-artifact directory in a supported read-only sandbox that denies external network, then binds ordered output hashes and an unchanged post-smoke manifest before automatically closing as `released`. macOS denies loopback; Linux `bwrap` provides namespace-local loopback only, so portable smoke must not use listeners or connections. Exercise an exported API handler in-process or validate the artifact without sockets. The runner can read host-account files and is neither a confidentiality sandbox nor a transitive-code-attestation boundary; use reviewed code that does not load ungoverned host paths. Failed/interrupted attempts need a fresh authorization, current v3 receipts cannot downgrade to legacy, and later gates reject released-byte drift. Successful completion currently requires `/usr/bin/sandbox-exec` on macOS or `/usr/bin/bwrap` on Linux; unsupported hosts and Linux without `bwrap` fail closed and remain unreleased.

   Authorize and complete the mandatory rollback rehearsal before asking to authorize `release.local`. For a declared data migration, first complete the initial `data.migrate` and real `data.rollback`; the rollback rehearsal must bind that passing rollback receipt, and a later passing final `data.migrate` must still precede release. In `host_verified` mode, add the exact external `--host-receipt-file` to each checkpoint authorization. In the default `audit_only` mode, omit that option; `--confirm-action` plus direct approval attribution records the checkpoint without claiming verified host authority:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action rollback.verify \
     --evidence evidence/rollback-rehearsal.json \
     --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Approve this exact rollback rehearsal evidence" \
     --json

   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action rollback.verify --outcome passed \
     --evidence evidence/rollback-rehearsal.json \
     --json
   ```

   Only after that passing receipt may the local release be authorized and completed. In the full lifecycle, execute these `release.local` commands only after the validation step passes, the intermediate strict receipt is sealed, and the bound workflow has entered `release`:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action release.local --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Release this exact local target" \
     --json

   # Perform the approved local write, then let completion run the exact smoke test.
   node <plugin-root>/bin/mpsf.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action release.local --outcome passed \
     --evidence .local-release/release-evidence.json \
     --smoke-cwd /absolute/project/.local-release/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --rollback "Restore the previous local package and restart the local process" \
     --json
   ```

   For implementation work or parallel worker work, inspect the current orchestration state before editing:

   ```bash
   node <plugin-root>/bin/mpsf.mjs orchestrate status --root <target-project> --json
   ```
