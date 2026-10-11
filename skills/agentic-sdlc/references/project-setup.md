# Project Setup and Request Routing

Workflow steps 1–4 of the Agentic SDLC skill (`../SKILL.md`). Step numbers are shared across the workflow reference files; the always-on guardrails in `../SKILL.md` apply to every step.

1. Identify the target project root. Default to the current workspace root unless the user names another project.
2. If `.sdlc/project.json` is missing, initialize the project:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs init --root <target-project> --project-name "<name>"
   ```

   When a new project's agreed phase order includes `integration-review`
   between implementation and validation, initialize with the complete
   distributed overlay instead of adding the phase after bootstrap:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs init \
     --root <target-project> \
     --project-name "<name>" \
     --template-dir \
       <plugin-root>/templates/workflow-software-project-v3-integration-review
   ```

   The same `--template-dir` works with `onboard existing-project` when the
   repository has useful code but no `.sdlc/`. It validates and pins the
   seven-phase config and creates its phase contracts in the initial
   bootstrap.

   **Starting over a project that was never published.** Never delete `.sdlc` and never ask the user to run `rm -rf .sdlc`: the host hooks refuse it because `.sdlc` holds permanent approvals and consumption records. Run `project archive` (read-only plan) and show the user what it reports. It moves `.sdlc` aside, never deleting it, and only when nothing shows the records were published or shared (shared refs, a remote, delivery records, pushes or merges in the trace); otherwise it refuses and explains why, and you continue with the governed commands instead. Only the user applies it, from their own terminal, with the plan hash, a reason, and `--actor-type human --approval-source explicit-user --summary "<their words>"`; add `--reinit` to start a fresh project that keeps a trace of the archive. See `commands.md`, "Archive And Restart A Never-Published Project".

   For an existing repository with useful current code, docs, or configuration, prefer onboarding so the KB starts with an explicit proposed baseline instead of pretending the historical SDLC is known:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs onboard existing-project \
     --root <target-project> \
     --project-name "<name>" \
     --document README.md \
     --question "Which inferred facts are canonical?"
   ```

   Treat `.sdlc/baseline/<id>.json` as proposed until the user explicitly confirms what is canonical. When asking for that confirmation, summarize the baseline contents in chat: inferred project summary, documents read, detected stack, important files, assumptions, and open questions. Do not tell the user to inspect `.sdlc/baseline/<id>.json` or `<id>-current-state.md` manually as the main approval path; links are supporting evidence only.

   Run `baseline refresh` only from the base branch with the work committed; the CLI refuses a story branch that is not merged and uncommitted changes in the baseline scope, and says how to proceed. A proposed refresh that must not become the project state (for example one taken from a story branch) is withdrawn with `baseline refresh withdraw --id <id> --reason <why>` and a person's approval, never approved to get past a gate. See `commands.md`.

3. When the user invokes Agentic SDLC for project context, discovery, analysis, design, implementation, validation, release, or other generic phase work, normalize the request into canonical route intent JSON as a read-only preview. Do not call `task start` yet. Explain the intended outcome, delivery destination, known boundaries, and missing decisions in ordinary language. Do not keyword-match inside the CLI. For an assessment, follow the dedicated skill instead: approve the baseline, prepare and approve the immutable combined proposal, apply it idempotently, then make its one proposal-bound start decision. Do not treat natural-language requests such as "initial technical assessment" as permission to analyze directly.

4. Select the SDLC phase: `discovery`, `analysis`, `design`, `implementation`, `validation`, `release`, or `operations`.
