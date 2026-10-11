# Product Assessment: Guided Project Assessment Journey

## Executive Verdict

### Before The Change

**Verdict: no-go as a self-service assessment product; go as an expert-operated SDLC governance engine.**

The pre-change product has strong contract, approval, evidence, trace, and Git-first KB mechanics. It can govern an assessment correctly when an operator understands baselines, capability profiles, output templates, contracts, and start confirmation. It does not yet turn the primary natural request into a coherent product journey. A user asking to contextualize a repository and prepare an assessment can encounter several internal approvals, SDLC vocabulary, and no enforceable distinction between a Markdown document and a requested Word, Excel, PDF, or PowerPoint artifact.

That is a product gap rather than a missing low-level feature. The engine is credible; the default user experience is not complete.

### Target After The Complete Change Set

**Verdict: conditional go for bounded, local project assessments after the blocking evidence below passes.**

The target product accepts a natural project-contextualization request, activates a dedicated assessment journey, explains inferred context, and uses exactly two normal checkpoints. Checkpoint 2 approves an immutable proposal hash binding the baseline, requirement/story reservation, deliverable, capabilities, contract draft, route intent, write-set, security boundary, verification plan, and complete execution budget.

The go decision requires a full source suite, schema and plugin validators, a clean installed-plugin run, multilingual two-checkpoint transcripts, and real format artifacts with generator, content, and render evidence. Installs, external services, secrets, production, destructive actions, out-of-scope writes, material proposal changes, and unapproved budget extensions remain explicit exceptions by design.

## Assessment Scope

This assessment evaluates the product experience for requests equivalent to:

> Contextualize this existing project and prepare an initial technical or functional assessment in my requested format.

The bounded happy path is read-only repository and KB analysis, already-installed local capabilities, one agreed project artifact, canonical SDLC bookkeeping, format-specific verification, and a concise chat summary. If the assessment also produces a pull request or local release, checkpoint 2 must include the explicit autonomy selection for that exact delivery profile. Implementation work outside that profile, remote deployment, production inspection, secret-bearing systems, and unapproved external research are outside the path.

Evidence considered includes the existing MPSF skill and interaction documentation, CLI routing and approval behavior, project configuration, output-contract schemas, package boundaries, and regression tests. Repository evidence can show implemented behavior; it cannot prove unstored historical decisions or the semantic correctness of every future assessment.

## Product Strengths Before The Change

- Contracts, approvals, hashes, output links, traces, claims, and gates provide a serious governance foundation.
- Existing-project onboarding separates inferred context from confirmed canonical context.
- Approval records distinguish direct user approval, CI, delegated automation, and provisional bootstrap state.
- Capability discovery can model installed tools, missing installs, permissions, targets, and contract bindings.
- The KB is Git-first and auditable; cache and indexes are explicitly non-canonical.
- The language-agnostic router accepts normalized intent rather than embedding English keyword rules in the CLI.
- The test suite already exercises many failure modes around stale evidence, installation approval, contract readiness, and output linking.

## Pre-Change Product Gaps

| Gap | Product impact | Required correction |
| --- | --- | --- |
| Internal artifacts become user-facing checkpoints | A normal assessment can feel like configuring the SDLC engine instead of requesting an outcome | Collapse the journey into inferred context and one combined work proposal |
| Baseline approval can be misunderstood as broader consent | A short confirmation may appear to authorize format, tools, contract, or execution | State and enforce that baseline approval applies only to baseline context |
| Template, capability, contract, start, and budget decisions are fragmented | Users repeat approvals for one conceptual task | Hash scope, sources, sections, format, tools, writes, contract, start, and budget into one proposal |
| Broader autonomy is easy to overstate or misattribute | An agent can appear to self-declare human authority, exceed a requirement ceiling, or reuse a prior PR choice | Require requirement and per-delivery profiles, host/CI approval, exact subject hashes, no cross-delivery reuse, and validity-at-use receipts |
| File format is presentation advice rather than a canonical contract | A `.md` file can be delivered when the user asked for Word or Excel | Store format, extension, media type, delivery mode, and generator capability; reject mismatches |
| Structural verification is easy to overclaim | A valid container can appear semantically and visually verified | Separate generator attestation, container, content, render, and optional independent verification |
| Execution has no explicit resource boundary | The agent may consume disproportionate time/tokens or stop before verification | Approve one concrete budget tranche with warnings, completion reserve, stop policy, usage receipt, and versioned amendments |
| No assessment-specific preset | Assessments vary by agent and can omit product, security, evidence, or decision content | Provide one adaptable semantic preset for document and workbook delivery |
| The starter prompts lead with engine operations | The primary assessment journey is difficult to discover without prior plugin knowledge | Make project contextualization plus assessment the first product prompt |
| Installed-plugin behavior is not the primary release proof | Source-tree success can hide packaging or discovery defects | Exercise the realistic journey from the installed plugin |

## Target Product Behavior

### Checkpoint 1: Project Context

The product explains what it inferred from repository and KB evidence: purpose, stack, components, constraints, important files, assumptions, contradictions, and unknowns. The question explains what is asked, why, what the answer authorizes and excludes, and gives Italian and English response examples. The user approves or corrects only those facts. No assessment finding is produced yet, and this approval does not leak into later records.

### Checkpoint 2: Combined Work Proposal

The product presents one concrete proposal containing:

- assessment outcome and audience;
- in-scope and out-of-scope areas;
- exact evidence sources and local checks;
- ordered sections and format adaptation;
- canonical format, extension, media type, path, delivery mode, generator, and verifier;
- concrete tools, permissions, and targets;
- exact write-set, subject IDs/hashes, contract draft, and route intent;
- concrete active-time, step, and token defaults (all estimated soft limits with no hard limit), warning thresholds, verification reserve, and stop/extension policy; cost is unavailable and non-binding unless backed by a trustworthy pricing adapter, pricing reference, and currency;
- assumptions, missing information, limits, and escalation boundaries;
- the exact records and actions that approval will authorize;
- the execution start and final delivery behavior.

One answer covers only the immutable proposal hash shown. The question explains what is asked, why, what it authorizes/excludes, and gives bilingual examples. A material change requires a revised proposal. A budget increase is a versioned amendment, never a mutation of the approved base budget.

### Execution And Delivery

After approval, `assessment proposal approve` creates host approval evidence and a proposal-bound content authorization. `assessment proposal apply` idempotently creates only the represented records and each automation use gets a validity-at-use receipt. The product performs the assessment, records budget usage, creates the artifact using the required format skill, records a generator receipt, verifies container/content/render dimensions, links the output, and completes without a routine third approval.

## Format Product Contract

The first-class formats are `markdown`, `docx`, `xlsx`, `pdf`, `pptx`, `html`, `json`, and `csv`. Common user language such as `word` and `excel` must normalize to `docx` and `xlsx`. Every approved output template must carry canonical format metadata, and every linked artifact must have the matching extension.

The semantic assessment model remains stable across formats. Word preserves headings and tables. Excel uses section-specific worksheets, stable row IDs, and evidence references. PowerPoint condenses the decision narrative and retains detailed evidence in an appendix. JSON preserves section keys and IDs. CSV explicitly flattens the hierarchy rather than pretending to preserve rich document layout.

## Required Product Evidence

Do not turn planned checks into historical claims. A release evidence bundle must contain:

- passing source, schema, package, plugin, and skill validation outputs;
- clean installed-package execution on supported platforms;
- Italian and English transcripts showing exactly the two normal checkpoints and full question contracts;
- negative tests for missing baseline, changed proposal hash, self-declared human approval, authorization replay, stale subject hash, and budget overrun;
- real DOCX/XLSX/PDF/PPTX examples whose generator receipt, container checks, semantic checks, and renders all refer to the delivered artifact hash;
- a release manifest linking proposal, requirement/story, authorization-use, execution-usage, verification, and gate evidence.

## Remaining Limits

These are product boundaries rather than incomplete happy-path behavior:

- Generator skills are runtime dependencies. If one is missing, installation remains a direct decision and the product must not fabricate the requested format.
- Static repository inspection cannot validate production topology, live security controls, data handling, or operational performance without separately approved access.
- Container and visual validation cannot guarantee strong reasoning. Content verification therefore applies an evidence/ID/section rubric and still records limitations.
- PPTX and CSV are intentionally reduced views of a detailed assessment; appendices or flattened records preserve required evidence.
- The two-checkpoint promise applies to the normal bounded path. A materially changed scope or risky capability properly creates an exceptional decision.

## Release Criteria

| Priority | Criterion | Pass condition | Required evidence |
| --- | --- | --- | --- |
| Blocking | Natural trigger | Technical, functional, architecture, and project-assessment requests in more than one language activate the dedicated journey | Installed-plugin scenario tests |
| Blocking | Product entry point | The first starter prompt asks the plugin to contextualize the project and prepare an assessment | Installed-plugin manifest/UI assertion |
| Blocking | Context boundary | Checkpoint 1 presents evidence and inference clearly; its approval is stored only against the baseline | Approval-record assertions |
| Blocking | Two-checkpoint journey | A low-risk local assessment completes with at most context plus combined proposal decisions | End-to-end interaction transcript/assertions |
| Blocking | Combined proposal completeness | Scope, sources, sections, artifact metadata, tools, limits, missing information, approval meaning, and start are all displayed | Proposal snapshot or structured assertion |
| Blocking | Immutable proposal | Baseline hash, requirement/story, deliverable, capabilities, contract draft, route intent, write-set, security, and budget are bound by one proposal hash | Hash mutation and replay tests |
| Blocking | Question clarity | Every normal and exceptional question states what/why/authorizes/excludes and gives Italian/English examples; open-question category guidance and fallback are configuration-driven | Transcript and configuration-schema assertions |
| Blocking | Exact approval scope | A short approval covers only displayed proposal elements; unseen or changed artifacts remain unapproved | Negative approval tests |
| Blocking | Host authority | Direct human/CI approval has a host/CI receipt; an agent flag cannot impersonate authority | Provenance tests |
| Blocking | Authorization history | Each automated use stores an authorization snapshot valid at use time; later close/revoke preserves valid history | Lifecycle and strict-gate tests |
| Blocking | Delegated autonomy | The requirement ceiling and current delivery choice are preserved exactly; later covered approvals remain inside that delivery and use `actor_type: agent` with `approval_source: automation` | Approval provenance and no-cross-delivery-reuse tests |
| Blocking | Local capability bookkeeping | Already-installed local read-only tools do not add a separate checkpoint when policy permits; installs/external/secrets/production/out-of-scope writes do | Happy-path and escalation tests |
| Blocking | Canonical formats | All eight formats store format, extension, media type, delivery mode, and generator; aliases normalize deterministically | Schema and CLI tests |
| Blocking | Extension enforcement | Linking an artifact whose extension contradicts the approved format fails consistently | Negative CLI test for every format family |
| Blocking | Generator verification | DOCX, XLSX/CSV, PDF, and PPTX have a generator receipt for the exact hash, separate render evidence, and passed required verification dimensions | Generator receipt, artifact, semantic rubric, and renders |
| Blocking | Budget tranche | Checkpoint 2 shows concrete meterable limits, accuracy, warnings, reserve, limit action, and extension policy; usage aggregates subagents | Budget snapshots, threshold, overrun, amendment, and usage-receipt tests |
| Blocking | Requirement lineage | The assessment creates/reuses a real requirement and links the same ID through story, output, and release | Referential-integrity tests |
| Blocking | Recovery | Apply is idempotent and a partial failure resumes without a new normal checkpoint or duplicate records | Fault-injection tests |
| Blocking | Release evidence | Release manifest links proposal, receipts, output, verification, budget, and gate receipts; logical legacy exclusion and transactional filesystem archive plans are distinct | Manifest/gate/archive-record/archive-plan schema and rollback tests |
| Blocking | Assessment coverage | The preset includes product/context, architecture/component inventory, quality/tests, privacy/security, risks, recommendations, roadmap, evidence, and open decisions | Template structure test |
| Blocking | Word and Excel adaptation | The same semantic assessment renders as a readable Word document and a usable workbook without dropping required sections or evidence IDs | Rendered DOCX review and workbook inspection |
| Blocking | Installed package | The installed plugin discovers the skill and preset and completes the realistic journey | Clean-install smoke/e2e evidence |
| Blocking | Regression safety | Existing strict gates, approval governance, template reuse/delta behavior, and legacy template compatibility still pass | Full automated test suite |
| Advisory | Assessment usefulness | Findings cite evidence, confidence, impact, and actionable recommendations; unknowns are explicit | Content rubric on representative repositories |

## Representative Acceptance Scenarios

1. An Italian request for a Markdown technical assessment uses exactly two normal checkpoints, each with the full question contract, and returns a content-verified `.md` artifact plus chat summary.
2. A request for a "Word assessment" normalizes to DOCX, uses `documents`, renders the result, and links only `.docx`.
3. A request for an "Excel architecture assessment" normalizes to XLSX and produces the prescribed worksheets with stable IDs and evidence references.
4. A proposed Markdown template cannot link an `.xlsx` artifact, and a DOCX template cannot link a `.md` artifact.
5. An approved baseline followed by "ok" does not approve capabilities, format, contract, budget, or start.
6. Already-installed local read-only capability records are handled as policy-backed automation without a third checkpoint.
7. A missing generator skill, external evidence source, secret-bearing endpoint, production target, or new write location produces an explicit decision before use.
8. A user-declared autonomy scope is copied into automation approval evidence only for the same delivery, without adding installs, merge/deploy, or unrelated work; a later PR or local release asks again.
9. The same assessment preset produces coherent Markdown, Word, and Excel outputs with all mandatory sections represented.
10. A budget reaches 70% and 90% with non-blocking warnings, preserves verification reserve, and requires a versioned amendment before an unapproved overrun.
11. Revoking the authorization after completion blocks future use without invalidating historical validity-at-use receipts.
12. A clean plugin install shows the contextualization-and-assessment starter before low-level initialization, contract, or gate prompts.

## Product Decision

Ship the self-service assessment claim only when every blocking criterion has durable release evidence. Describe the boundary precisely: repository and local-tool assessments may run after the two displayed decisions; if one pull request or local release is included, its autonomy choice is part of the second decision and applies only to that delivery. A new delivery, protected-branch merge, remote deployment, external system, installation, secret, production access, destructive operation, new write path, material proposal change, or unapproved budget extension requires an explicit decision.
