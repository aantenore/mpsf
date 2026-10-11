# Plan: making the engine easier to learn

Status: plan only. Every step is incremental and can ship on its own. No big-bang refactor.

## Starting point (0.146.17)

- `lib/` holds about 154k lines in 243 modules. `lib/engine/` alone holds 76 modules and about 76k lines. Five modules hold 44% of the engine:

  | Module | Lines |
  | --- | ---: |
  | `story.mjs` | 9.9k |
  | `delivery.mjs` | 8.7k |
  | `common.mjs` | 5.2k |
  | `workflow.mjs` | 5.1k |
  | `storage.mjs` | 4.9k |

- The default config (`templates/sdlc-config.json`, 68k characters) has 33 top-level sections. A new adopter sees all of them at once.
- `docs/architecture.md` already describes the layers in "Code Layout": entry point, engine, pure rules (`lib/lifecycle`), and the host seam (`lib/runtime/host.mjs`). There is no per-module index, and some modules bypass the host seam: `test/unit/runtime-host.test.mjs` currently lists 44 violations.

## Steps, in priority order

### 1. Architecture map (docs only; S)

Add `docs/architecture-map.md`: one diagram plus a table with the four layers and the dependency direction (bin → engine → lifecycle/rules, with all I/O through `runtime/host`). For each feature area, name its entry command, engine module, rule module, schema, and test file. Areas: requirements, contracts, stories and claims, workflow, delivery, gates and certification, messaging, observatory, metering. Link it from `docs/README.md` and `docs/architecture.md`. Acceptance: a link check test asserts that every module path named in the map exists.

### 2. Module index generated from code (S)

Add a one-line `// Responsibility:` header to each `lib/**/*.mjs`. Add a script, `scripts/module-index.mjs`, that writes `docs/module-index.md` with path, lines, responsibility, and exported symbol count. Add a test that fails when a module lacks the header or the index is stale. This keeps documentation from drifting without hand maintenance.

### 3. Config presets with progressive disclosure (M)

Ship three presets as overlays over the full default, which stays the canonical schema:

- `minimal`: one developer, local-only or single PR, audit-only authority, no messaging or standing approvals.
- `team`: shared remote claims, messaging, code review default, budget soft limits.
- `strict`: `host_verified` authority, mandatory review, secret scan, signed standing approvals, lifecycle-complete required.

`init --preset <name>` writes only the overlay keys into `.sdlc/config.json`, with `extends: "<preset>@<version>"`. `resolveEffectiveConfig` (`lib/effective-config.mjs`) already merges and locks effective config, so presets plug in there with no new merge engine. Existing projects are unaffected: no `extends` means the full document, as today. Migration is via the existing `config migrate` plan and apply flow, with an explicit plan hash.

### 4. `config explain` (S–M)

Add `config explain [<section>[.<key>]] [--changed-only] [--json]`. For each section it prints:

- what it controls, in one plain sentence;
- the effective value and where it came from (default, preset, project);
- whether it is security-relevant (authority, approvals, gate, release evidence);
- the command that changes it safely.

The descriptions come from the config JSON schema `description` fields, which become required. A test checks that every top-level section has one. `config status` stays the short summary, and `config explain` is the deep dive.

### 5. Split the largest modules along existing seams (M each, one per release)

The rule for each split: move code verbatim behind an unchanged import surface (re-export from the old module first), keep test diffs to zero, and do one module per release. Order, chosen by churn and risk:

1. `delivery.mjs`:
   - local release and smoke (`localRelease*`, `localSmoke*`, which already started with `lib/delivery/local-smoke-providers.mjs`);
   - data migration;
   - pull-request remote actions;
   - authorization subject building.
2. `storage.mjs`: delivery autonomy proposal (`proposeDeliveryAutonomyLocked` and its guidance), then record read and write helpers.
3. `story.mjs`: claims and reservations, steps and handoff, then sync and publish. Several files with these names already exist, so finish moving the remaining functions into them.
4. `common.mjs`: split into `ids`, `paths`, `json-io` and `errors`, and remove any helpers that turn out unused.
5. `workflow.mjs`: transitions apart from canonical evidence, which is already partly in `lib/workflow-canonical-evidence.mjs`.

Each split also removes host-seam violations in the moved code, which shrinks the list in `runtime-host.test.mjs`.

### 6. Contributor "first hour" guide (S)

Add `docs/contributing-engine.md`: how to run one test file, where to add a command (`lib/cli/command-catalog.mjs` → engine → rule → schema → test), the host-seam rule, and the release checklist (the version files and "Versione x.y.z" commit).

## Explicitly out of scope

Changing record schemas or hash subjects, renaming CLI commands, and replacing the config format. Each of those would invalidate approvals already recorded in user projects.
