# Configuration safety

The plugin pins each initialized project's complete effective configuration. Updating the plugin can add new defaults, but it cannot silently change the rules already governing that project.

A Codex plugin installation does not create a global `agentic-sdlc`
executable. Set the installer-managed entry point once before using the
commands in this guide:

```bash
PLUGIN_CLI="$HOME/plugins/agentic-sdlc-codex-plugin/bin/mpsf.mjs"
node "$PLUGIN_CLI" help config
```

An npm installation may expose an equivalent bin shim. The explicit Node form
below always identifies the plugin-local copy.

## The short version

Run:

```bash
node "$PLUGIN_CLI" config status --root /path/to/project
```

The first lines give the outcome, its practical impact, any decision you need to make, what stays protected, and the next step. Technical hashes and internal labels follow only as supporting detail. Inside an agent session the output is shortened to the outcome and next step; add `--verbose` for the full text.

| Status | Shown as | Meaning | What to do |
| --- | --- | --- | --- |
| `locked` | "The project's rules are confirmed and ready to use." | The stored config matches its lock | Nothing |
| `legacy_compat` | "The project is safely using its previous compatible behavior." | This is an older project without a lock | Preview a migration |
| `drifted` | "The rules changed after their last confirmation, so governed changes are paused." | A person or tool changed project policy | Review and accept or restore the change |
| `invalid` | "The saved rules cannot be verified, so governed changes are blocked." | The lock is malformed or inconsistent | Restore a valid config and lock before governed writes |
| `missing` | "The project's saved rules are missing, so this command did not run." | `.sdlc/config.json` is missing | Restore `.sdlc/config.json` from version control, or copy the bundled defaults back with the command shown in the details |
| `uninitialized` | "This project has not been initialized for MPSF yet." | The project has no MPSF configuration yet | Run `init` if you want to prepare the project |

Commands that only inspect state remain available during recovery. Commands that change governed project records stop before writing when the config is drifted or invalid.

## Review before applying

The preview is read-only:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project
```

It reports every JSON path that would be added, replaced, or removed and prints a deterministic plan hash. It does not change `config.json`, create a lock, or write a migration receipt.

When run inside an agent host, the text preview is shortened and ends with `… N more: --verbose`. Add `--verbose` (or set `AGENTIC_SDLC_OUTPUT=full`) to see every changed JSON path before applying.

For automation, the machine-readable preview is compact by default:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project --json
```

It keeps the plan hash and reviewable changes but reports which plan details
were omitted. The envelope explicitly reports `plan_complete: false` and
`plan_hash_verification: requires_full_preview`: its nested `plan` is a compact
summary, not a complete `config-migration-plan:v1`, and its hash cannot be
independently recomputed from that summary alone. The hash remains the exact
opaque reference accepted by apply, which recomputes the full plan before any
write.

Request the complete machine payload to inspect the target configuration or
verify the plan hash independently:

```bash
node "$PLUGIN_CLI" config migrate --root /path/to/project --json --full
```

Here `--full` expands details omitted from compact machine/JSON output; it does
not change the plan or apply it. It reports `plan_complete: true` and
`plan_hash_verification: self-contained`; its nested plan validates against
`schemas/config-migration-plan.schema.json`.

Inside an agent session `--json`, with or without `--full`, uses the short
agent profile: it reports the plan hash and status, leaves out the semantic
diff, impact and the complete nested `plan`, and lists what it dropped under
`omitted`. To get the envelope
described here, add `--json-profile full` (for example
`config migrate --root /path/to/project --json --json-profile full --full`) or
set `AGENTIC_SDLC_JSON_PROFILE=full`.

Apply only the plan you just reviewed:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --apply \
  --plan-hash <displayed-sha256>
```

Before writing, the CLI recomputes the plan under a project lock. If the config, previous lock, or plan changed after review, the command stops and preserves the existing files. A successful apply atomically materializes the reviewed config, writes `config.lock.json`, and stores an immutable receipt under `.sdlc/migrations/config/`.

### Adopt an exact manifestless v0.11 project

Projects initialized by the bundled v0.11 format predate
`.sdlc/bootstrap-manifest.json`. The CLI recognizes only that exact legacy
shape. Preview remains read-only and identifies the adoption separately; it
does not treat a changed project version as proof of a legacy bootstrap.

After reviewing both the migration plan and the identified legacy bootstrap,
apply them with a separate, directly attributed decision:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --apply \
  --plan-hash <displayed-sha256> \
  --confirm-legacy-bootstrap \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Adopt this exact legacy bootstrap"
```

An approved CI actor may instead use `--actor-type ci --approval-source ci`.
Both human and CI adoption require a decision summary or approval-evidence
file. A missing, mismatched, or previously locked bootstrap stops before any
configuration file, lock, or receipt is written. This flag is only for the
first v0.11 lock; it cannot repair or bypass an incomplete newer bootstrap.

## Change the autonomy rollout mode

Do not edit `autonomy_policy.mode` by hand. Preview one of the four supported modes through the same hash-bound configuration workflow:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --autonomy-mode observe
```

The preview shows the semantic JSON change, for example:

```text
replace /autonomy_policy/mode: "enforce_new_only" -> "observe"
```

Inside an agent host the shortened preview can hide this line behind `… N more: --verbose`; add `--verbose` to show it.

Apply the exact reviewed mode and plan together:

```bash
node "$PLUGIN_CLI" config migrate \
  --root /path/to/project \
  --autonomy-mode observe \
  --apply \
  --plan-hash <displayed-sha256>
```

Valid modes are `off`, `observe`, `enforce_new_only`, and `enforce_all`. The mode is part of the plan hash: omitting it, selecting a different mode, or changing the config after preview causes apply to fail before any file is written.

Release-history migration is deliberately separate. It never upgrades configuration as a side effect; pin the project config first, then run the release migration.

## Esempio in italiano

```text
Risultato: Le regole sono cambiate dopo l’ultima conferma, quindi le modifiche controllate sono in pausa.
Cosa cambia in pratica: Il programma non presume che il cambiamento fosse intenzionale e non continuerà da solo.
Cosa devi decidere: Dovrai esaminare le differenze e confermare soltanto quelle desiderate.
Cosa resta protetto: Nessuna regola nuova viene accettata e nessun file di lavoro viene modificato durante questo controllo.
Prossimo passo: Crea una nuova anteprima con il comando nei dettagli facoltativi, poi applica soltanto quella approvata.
```

L'anteprima non modifica file. Se qualcuno cambia nuovamente la configurazione prima dell'applicazione, il vecchio hash viene rifiutato e occorre revisionare un nuovo piano.

## English example

```text
Outcome: The rules changed after their last confirmation, so governed changes are paused.
What this changes in practice: The software will not assume the change was intentional or continue on its own.
What you need to decide: You will need to review the differences and confirm only the intended ones.
What remains protected: No new rule is accepted and no work file is changed during this check.
Next step: Create a fresh preview with the command in the optional details, then apply only the reviewed result.
```

The preview changes no files. If the configuration changes again before apply, the old hash is rejected and a new plan must be reviewed.

A command that would change governed records on a drifted project stops with a separate message, which is shown in English only:

```text
This command was not run because the project configuration is drifted.
Impact: no governed project files were changed.
Next: run `mpsf config migrate`, review the exact plan, and apply its hash before retrying.
Technical detail: blocked command <command>.
```

## Technical records

- `.sdlc/config.json` is the fully materialized project policy.
- `.sdlc/config.lock.json` binds the complete config hash, defaults profile, inherited paths, and creation time.
- `.sdlc/migrations/config/*.json` records an applied plan, resulting lock, audit attribution, and immutable receipt hash.
- `templates/config-compat/` contains frozen compatibility defaults used only for older projects that do not yet have a lock.

The lock is hash-bound evidence, not a digital signature. A signed host approval is a different record with a verified trusted-key attestation; the CLI does not call an ordinary config lock “signed.”

## Standing approval limits

`standing_approval_policy` caps what any standing approval may request: `max_validity_days`, `max_deliveries`, `max_changed_files`, `max_changed_lines`, and `expiry_warning_hours`, plus `enabled`. Projects created before this section existed use the same documented fallback values without changing their effective configuration hash. Changing the configuration later, through the hash-bound workflow above, suspends every standing approval approved under the previous configuration: it reports `stale` and covers nothing until the user approves a new one. `standing_approval_policy.coordination` (`mode`: `auto` (default), `required` or `local_only`; `remote`; `timeout_seconds`) decides whether used deliveries and revocations are shared through a git remote. See [How it works](how-it-works.md) for when a standing approval stops covering deliveries because the remote is missing or has changed.
