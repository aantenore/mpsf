# Software project v3 with integration review

Use this directory as the `--template-dir` for `init` or
`onboard existing-project`. Its complete `sdlc-config.json` adds
`integration-review` between implementation and validation, updates the
matching autonomy presets, and lets bootstrap create all eight phase
contracts.

Before proposing the custom workflow, copy `workflow-definition.json` into the
target project. `workflow definition propose --definition-file` intentionally
accepts only a project-internal file.

For a plain default init that has not started governed work, compare the full
companion config with `.sdlc/config.json`, copy it only after review, preview
`config migrate`, and apply only the displayed plan hash. Do not replace the
full config of a customized or active project.

The detailed command journey and the distinction between editable and
CLI-derived fields are documented in
`docs/configurable-workflows.md`.
