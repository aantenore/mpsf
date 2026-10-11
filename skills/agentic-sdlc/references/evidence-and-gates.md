# Evidence, Handoffs, Gates, and Certification

Workflow steps 15–19 of the MPSF skill (`../SKILL.md`). Step numbers are shared across the workflow reference files; the always-on guardrails in `../SKILL.md` apply to every step.

15. Capture durable autonomy decisions, assumptions, risks, tests, handoffs, sync/push/PR events, dependency revalidation, and release evidence as traces. Include requirement/profile, delivery/profile, requested/effective level, and deterministic reason-code references. Strict gates require `test` and `release` traces to include real evidence paths outside cache/index directories and explicit successful outcomes (`passed` for tests; `ready` or `passed` for release). A local release also requires target-bound smoke-test evidence and its rollback procedure:

   ```bash
   node <plugin-root>/bin/mpsf.mjs trace append --root <target-project> --story ST-001 --type decision --summary "..." --actor <host-agent> --actor-type agent
   node <plugin-root>/bin/mpsf.mjs trace append --root <target-project> --story ST-001 --type implementation --summary "Implemented the requested change" --actor <host-agent> --actor-type agent --requested-by antonioantenore --requested-by-type human --request-summary "User-requested change"
   node <plugin-root>/bin/mpsf.mjs trace append --root <target-project> --story ST-001 --type implementation --summary "Added the requested launcher" --input-summary "Approved contract" --output-summary "Installed launcher" --rationale-summary "Keep evidence local" --alternative "Hosted dashboard" --explanation "The installed plugin now opens recorded project lineage locally." --explanation-kind codex-generated
   node <plugin-root>/bin/mpsf.mjs trace append --root <target-project> --story ST-001 --type test --outcome passed --summary "Tests passed" --evidence .sdlc/tests/ST-001-test-run.json
   node <plugin-root>/bin/mpsf.mjs sync record --root <target-project> --story ST-001 --event push --summary "Pushed feature/ST-001"
   ```

   Stories and requirements may carry `derived_acceptance` (secondary to the explicit acceptance). Produce those checks as well and record each one with `test record --acceptance DV-<rule-id>`; the strict gate flags a derived criterion with no passing run (see "Derived Verification Criteria" in `commands.md`).

   For validation, record test evidence with `test record` instead: it binds the story to the exact executed test command, its exit code, its result counts, and at least one immutable evidence file in a durable `test-run:v1` record. Treat a plain `trace append --type test` entry as the legacy weaker form; the validation gate warns when a story in validation has only that trace and no `test record`:

   ```bash
   node <plugin-root>/bin/mpsf.mjs test record \
     --root <target-project> \
     --story ST-001 \
     --command '["npm","test"]' \
     --exit-code 0 \
     --passed 42 \
     --evidence .sdlc/tests/ST-001-run.log \
     --framework node:test \
     --summary "Full suite on the reviewed implementation branch"
   ```

   Scan the changed files for credentials before validation closes. `secret scan` compares the delivery's base and head, records the result as a `secret-scan:v1` record under `.sdlc/security/`, and exits `1` when it finds something. Matches are always redacted, in the output and in the record:

   ```bash
   node <plugin-root>/bin/mpsf.mjs secret scan \
     --root <target-project> \
     --story ST-001
   ```

   When `gate_policy.secret_scan.enabled` is `true`, a story in validation needs a record whose outcome is `clean` for the current head, and the lifecycle-complete gate requires one for the head it certifies, so run the scan again after every change to the delivery. Remove and rotate any credential the scan reports; never paste the matched value into a trace, a summary, or a commit message.

   When a code review is required before the merge (the user's answer for this story, or a project policy that requires it for every pull request), a reviewer who authored none of its commits records a review of the current head. `review record` reads the head commit from the repository and the reviewer's Git identity from the local Git configuration, and writes a `code-review:v1` record under `.sdlc/reviews/`:

   ```bash
   node <plugin-root>/bin/mpsf.mjs review record \
     --root <target-project> \
     --delivery AUT-PR-001 \
     --verdict approved \
     --actor <reviewer-id> --actor-type human
   ```

   When a review is required, `pull_request.merge` is refused (exit `1`) until an approved review exists for the exact head being merged by a reviewer whose actor and Git email differ from every commit author of `base..head`. A later independent `changes_requested` blocks the merge, and any new commit on the head branch needs a new review. The requirement is checked only at `pull_request.merge`: never at `git.commit`, `git.push`, `pull_request.create`, `pull_request.update`, closing as `ready_for_review`, or any gate (including `gate check --strict --lifecycle-complete`). Never record a review on behalf of someone who did not read the diff, and never record an approval as the author of the change.

   The template sets `gate_policy.merge_requires_code_review` to `false`, so by default a review is required only where the user chose it. The sources, in order: `true` requires a review for every pull request (`project_policy`) and no story answer lowers it; otherwise a change recorded after approval (`change`), then the answer in the approved profile (`delivery_profile`, or `standing_approval` when a standing approval supplied it), then the project default for a profile approved before the question existed (`project_default`). An existing project that explicitly has `true` keeps it. To change the policy, the project uses the reviewed path: edit `.sdlc/config.json`, preview with `config migrate`, then `config migrate --apply --plan-hash <hash>`. `autonomy delivery explain` and `status` show which source applies and, when a review is required, how many valid reviews of the current head are recorded on this computer.

   To change the answer after approval, before the task starts just propose the delivery again with the new answer. Once it is approved, use a requirement change, which applies at once, also to a delivery in progress, and only at merge. `review require --delivery <profile-id> [--summary "<text>"]` adds the requirement and anyone may run it. `review waive --delivery <profile-id> --actor-type human --approval-source explicit-user --summary "<the user's words>"` drops it: only the user can decide that, so give them the exact command to run in their own terminal; it is refused inside an agent session and when the project policy requires reviews for every pull request. Each writes a record bound to the profile id and hash under `.sdlc/reviews/requirement-changes/` and a `review.require` or `review.waive` trace event.

   A review recorded on another computer counts only after its recorder runs `review publish --delivery <profile-id> [--review <review-id>]`. That pushes each record to the project's coordination remote as a create-only ref `refs/agentic-sdlc/reviews/<profile-id>/<profile-hash16>/<review-id>`; it never touches the pull-request branch or any other branch, and nothing publishes automatically. `review fetch --delivery <profile-id>` reads those refs into `refs/agentic-sdlc-shared/reviews/` and shows which are valid, and the plugin does a read-only fetch itself at merge. A received review counts only when its schema and `record_hash` are valid, it belongs to the same delivery profile (id and hash) and repository, its `reviewed_head_sha` equals the head being merged, and its reviewer is independent of the `base..head` authors recomputed locally; otherwise it is ignored with a reason. If the remote cannot be reached, only the reviews recorded on this computer count. The remote and timeout come from `orchestration_policy.coordination`.

   `review record` takes the reviewer's identity from the Git configuration, so the person guiding the agent can record an independent review on the same computer only when the agent commits under another identity. Recommend that the agent commit with a dedicated identity through environment variables, for its own commits only (`GIT_AUTHOR_NAME=agent-dev-1 GIT_AUTHOR_EMAIL=agent-dev-1@users.noreply.invalid GIT_COMMITTER_NAME=agent-dev-1 GIT_COMMITTER_EMAIL=agent-dev-1@users.noreply.invalid`), and leave the repository's `user.name` and `user.email` as the person's identity. Never set the agent identity in the repository Git configuration: the person's review would carry it.

   Put the recorded checks in the pull-request description. The host writes that description, so before it creates or updates the pull request, print the table and include it unchanged:

   ```bash
   node <plugin-root>/bin/mpsf.mjs autonomy delivery checks \
     --root <target-project> --id AUT-PR-001
   ```

   The table lists the test and smoke runs, the secret scan, the code review gate, the strict and lifecycle-complete gate receipts, the standing approval the delivery used, and its budget decision, each as `[PASS]`, `[FAIL]`, or `[NOT RUN]` with project-relative evidence links. It only reports what was recorded and re-runs nothing, so record the test, scan, and review evidence first, print it again after any later change, and never edit a status by hand. `autonomy delivery action` also returns the table as `pull_request_body_checks.markdown`, with the command as `pull_request_body_checks.command`, when it authorizes `pull_request.create` or `pull_request.update`; if `markdown` is `null`, run the command and read `unavailable_reason`.

   Keep `actor` as the executor. When an agent acts because a human or another system requested it, record `requested_by`; when execution was explicitly authorized, record `authorized_by`. This lets reports answer both "what did Codex execute?" and "what was done on Antonio's request?" without rewriting attribution. Narrative flags are optional; when used, store only shareable summaries derived from recorded evidence. Never put private chain-of-thought, hidden scratch reasoning, or secrets in a trace narrative.

16. When a phase lane is complete, record the step with hashed evidence. `story complete-step` requires the story contract to be approved and fresh unless `--allow-unapproved-contract-output` is being used for explicit migration/recovery. If the step produced a durable artifact, pass `--type` so the CLI verifies the output is linked in the registry:

   ```bash
   node <plugin-root>/bin/mpsf.mjs story complete-step \
     --root <target-project> \
     --id ST-001 \
     --step functional-analysis \
     --type functional-analysis \
     --summary "Functional analysis accepted for implementation"
   ```

   A step is accepted only while the story's bound workflow is in that step's phase: completing `operations` while the workflow is still in `release` fails immediately instead of at the final gate. When the contract assigns an output to the phase, exactly one active link must match it. Links recorded under an earlier contract (for example by a cancelled delivery) no longer count once the current contract has its own link; to replace an earlier link explicitly, link the new artifact with `output link ... --supersedes <link-id> --rationale "<why>" --actor-type human`. The earlier link stays in the registry as superseded history.

   After each non-terminal phase step is completed, transition the bound workflow to the next configured phase. The completion command seals an exact step-file attestation in the append-only story trace. A current canonical workflow refuses to leave the phase when that step is missing, stale, or manually changed; `workflow instance status` reports the blocker in `current_phase_completion` and keeps `ready_next_states` empty. The ordering is evidence: workflow start must be no later than task start, phase entry must be no later than that phase's completion, and the next phase entry must be no earlier than the previous phase completion:

   ```bash
   node <plugin-root>/bin/mpsf.mjs workflow instance transition \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --to <next-configured-phase> \
     --request-id <unique-phase-transition-id>
   ```

17. Use `story prepare-handoff` when passing work between chats, machines, or phases.Give the receiving agent `context pack --story <id> --phase handoff` (criteria, decisions, scope with file index, evidence, waits, next step) so it does not re-read the records.  Use `--release-claim` only when the next agent should be able to claim the story after pulling the shared KB; the release is also shared through the git remote, and if the output says it was not shared, run `story release --id ST-001` again once the remote can be reached:

   ```bash
   node <plugin-root>/bin/mpsf.mjs story prepare-handoff \
     --root <target-project> \
     --id ST-001 \
     --to-agent implementation-agent \
     --release-claim \
     --summary "Ready for implementation"
   ```

   Close the handoff when the receiving lane accepts it. Use phase locks only for shared phase artifacts that multiple story lanes could modify.

18. After the validation step and latest passing test evidence, run the ordinary strict story gate. It must validate the requirement revision and ceiling, current non-reused delivery profile, most-restrictive effective level, material-scope freshness, exact authorization uses, and applicable evidence. A passing gate does not itself authorize a release, protected-branch merge, or remote/production deployment:

   ```bash
   node <plugin-root>/bin/mpsf.mjs gate check --root <target-project> --story ST-001 --strict --out .sdlc/reports/ST-001-gate-report.json
   ```

   This is an intermediate readiness check, not the final delivery certificate. It verifies validation and seals the distinct strict receipt used to move the current story-bound workflow to its configured `release` phase with a unique request ID:

   ```bash
   node <plugin-root>/bin/mpsf.mjs workflow instance transition \
     --root <target-project> \
     --id <workflow-instance-id> \
     --to release \
     --request-id <unique-release-transition-id>
   ```

   Only after entering `release`, authorize and complete the exact local release or PR delivery (closing a PR without merge as `ready_for_review`), append the passing release trace, and complete the `release` story step. Entry into `release` must precede both the release trace and terminal delivery close. Then transition the workflow to `operations` (no additional guard) and complete the `operations` story step — a plain completion marker, never gated on an incident or feedback record existing. When those results are complete, release the story claim so no active worker can race final certification. Then run the lifecycle-complete gate. It replays the task-bound workflow's immutable instance, event history, checkpoint, audit trace, and alternating phase timeline, and requires every configured phase to have a completed canonical step — configured phase order now ends at `operations`, not `release`. Do not claim that the story or discovery-to-operations lifecycle is complete unless this stronger command passes and seals its separate final receipt. When a later story legitimately changes files this story certified and seals its own valid final receipt, `status` reports this story as a historical certification superseded by that later story: it stays completed, needs no recertification, and accepts no new evidence. Any change that no later valid certification binds still requires recertification. After certification, a story's own records (contract, requirements, profiles, workflow records, test and story records) never change: any change voids the receipt (`final_receipt_check:story_record_changed`, restore the named record), except files added to its delivery executions, related governance, `base-acknowledgements/`, and `autonomy delivery reconcile` events appended to its trace. Shared files (project, configuration, referenced governance, write-path files, release targets) changing make the certification stale, which keeps the story completed only once its delivery finished (pull request merged or reconciled, local release `released`); before that the story is blocked and needs recertification on the current files. A merged pull-request story is certified, and later checked, on its merge commit, which must be in the clone and an ancestor of HEAD. A missing certified commit (`certified_commit_missing`, run `git fetch`) or a rewritten history (`certified_history_rewritten`) blocks the story. Keep recorded evidence in story-scoped paths so later stories never overwrite it:

   ```bash
   node <plugin-root>/bin/mpsf.mjs gate check \
     --root <target-project> \
     --story ST-001 \
     --strict \
     --lifecycle-complete \
     --out .sdlc/reports/ST-001-lifecycle-complete.json
   ```

19. Release any remaining phase locks when work is complete or handed off. A completed story claim must already be released before the lifecycle-complete gate in step 18.
