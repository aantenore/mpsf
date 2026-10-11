# Knowledge Base Cache, Reports, Migrations, and Visual History

Workflow steps 20–24 of the MPSF skill (`../SKILL.md`). Step numbers are shared across the workflow reference files; the always-on guardrails in `../SKILL.md` apply to every step.

20. Rebuild/search the local cache and KB index when context retrieval is needed. For large KBs, rebuild the shared manifest and use non-destructive trace compaction before relying on long raw trace history:

   ```bash
   node <plugin-root>/bin/mpsf.mjs manifest rebuild --root <target-project>
   node <plugin-root>/bin/mpsf.mjs trace compact --root <target-project> --story ST-001
   node <plugin-root>/bin/mpsf.mjs cache rebuild --root <target-project>
   node <plugin-root>/bin/mpsf.mjs cache status --root <target-project>
   node <plugin-root>/bin/mpsf.mjs index rebuild --root <target-project>
   node <plugin-root>/bin/mpsf.mjs kb search --root <target-project> "query"
   ```

   Keep retrieval token-efficient: prefer the human-readable CLI view when it
   contains enough information. Inside an agent session `--json` returns the
   agent profile (outcome, ids, hashes, `context get` refs), which leaves out
   the `kb search` result list; add `--json-profile full` (or `--verbose`) when
   the results are needed. Outside an agent session JSON from `kb search` and
   `cache status` is compact by default; add `--full` only when the omitted
   derived payload is genuinely needed.

   For supported noisy test, Git, and `rg` commands, use the project-configured
   RTK gateway rather than invoking an assumed global wrapper directly:

   ```bash
   node <plugin-root>/bin/mpsf.mjs optimization status --root <target-project> --proposal <proposal-id> --json
   node <plugin-root>/bin/mpsf.mjs optimization run --root <target-project> --proposal <proposal-id> --command-json '["npm","test"]'
   ```

   Add `--exact` for byte-exact or complete output from an already allowlisted
   command. It preserves argv but never allows mutations, external preprocessors,
   unknown executables, or arbitrary diagnostics. The gateway is shell-free and
   applies the configured native fallback only after the active proposal cost
   gate permits new work. A custom provider command requires the invocation-local
   `--trust-custom-rtk-command` switch after its exact argv has been reviewed.

   When `context_optimization_policy.response_provider` selects `caveman`, load
   `../../caveman/SKILL.md` for user-facing explanations and status updates. Use
   its configured intensity, but preserve normal wording for approvals,
   irreversible actions, security warnings, exact commands, contracts, and
   durable artifacts. Response compression never creates usage credit:
   thresholds and limits use only usage measured by the selected budget-meter
   adapter after RTK and Caveman have affected the real session.

   In an assessment execution, let the lifecycle capture optimization evidence
   automatically at apply, budget checkpoints, and completion. Use manual
   capture only for an explicit diagnostic:

   ```bash
   node <plugin-root>/bin/mpsf.mjs optimization capture --root <target-project> --proposal <proposal-id> --phase manual --json
   ```

   Never fabricate lifecycle phases with manual capture. Treat RTK counters as
   project-cumulative and the hash-linked proposal delta as interval-only,
   advisory evidence. RTK always applies zero usage credit and no gate override:
   budget usage comes only from receipts, and soft limits, completion reserve,
   hard limits, and metering violations remain sovereign. A release manifest
   may reference validated optimization observations without changing its
   `budget_decision`.

21. Use activity reports or report queries when the user asks what happened, who changed something, which stories were created, which outputs changed, or similar history questions. For raw natural language, normalize the request into canonical report query JSON first; do not keyword-match the user's language in the CLI. Reports must cite canonical source files and must not infer unstored history:

   ```bash
   node <plugin-root>/bin/mpsf.mjs report activity --root <target-project> --since 3d --view business --out .sdlc/reports/activity.md
   node <plugin-root>/bin/mpsf.mjs report query --root <target-project> --query-json '<canonical-report-query-json>' --json --json-profile full
   ```

   Inside an agent session, plain `--json` returns the compact agent profile, which keeps only ids and omits `source_paths`, `source_hashes` and `summary`. Pass `--json-profile full` whenever the answer must cite sources.

22. When upgrading an existing KB, migrate only a manifest-defined active release. Run `migration active --release-manifest <id>` first without `--apply`, explain the planned config changes and exact historical evidence set, then apply only after the release manifest and every referenced immutable record validate. The command may add missing configuration defaults and a logical `archive-record:v1`; it must never rewrite approved records or move historical files. Use `archive closed --apply` separately only for an explicitly requested filesystem move.

23. When the user explicitly requests correction of an identity embedded in `.sdlc`, use `migration identity` as a separate recovery class. Run it without `--apply` first. Confirm that legacy/canonical authorization, action-subject, revocation, every prior migration receipt, and supported file-reference lineage validates; the plan has no unsupported records or affected signed envelopes; and the source identity will be absent afterward. Signed evidence must be authoritatively reissued, never rewritten or re-signed by the migration. Apply only with the exact emitted `plan_hash`; any canonical snapshot drift requires a new preview and review. Require its digest-only receipt and rebuilt cache/index state; never use broad text replacement or store the source identity in the receipt. If the journaled shadow-tree swap is interrupted, do not remove or age-reclaim the lock: recover only with the verified lock's `nonce` and `plan_hash`, rolling back before commit or finalizing after commit.

24. When the user asks for a visual explanation of what was requested, changed, decided, or verified, load `../../change-observatory/SKILL.md`. It launches the bundled read-only app through the installed plugin-local CLI; do not copy assets, add a build, or depend on global `PATH`.
