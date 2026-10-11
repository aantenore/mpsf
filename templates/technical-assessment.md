---
preset: technical-assessment
artifact_type: technical-analysis
version: 1
supported_formats:
  - markdown
  - docx
  - xlsx
  - pdf
  - pptx
  - html
  - json
  - csv
default_delivery_mode: artifact-plus-chat-summary
semantic_sections:
  - executive-verdict
  - product-and-context
  - architecture-and-component-inventory
  - quality-and-tests
  - privacy-and-security
  - risks
  - recommendations
  - roadmap
  - evidence
  - open-decisions
word_mapping: ordered-headings-and-native-tables
excel_worksheets:
  - Summary
  - Product-Context
  - Architecture
  - Quality-Tests
  - Privacy-Security
  - Risks
  - Recommendations
  - Roadmap
  - Evidence
  - Open-Decisions
---

# Technical And Functional Assessment

**Assessment Control**

| Field | Value |
| --- | --- |
| Project | {{PROJECT_NAME}} |
| Assessment type | {{ASSESSMENT_TYPE}} |
| Audience | {{AUDIENCE}} |
| Scope | {{SCOPE}} |
| Exclusions | {{EXCLUSIONS}} |
| Evidence cutoff | {{EVIDENCE_CUTOFF}} |
| Canonical format | {{CANONICAL_FORMAT}} |
| Delivery mode | {{DELIVERY_MODE}} |
| Confidence | {{OVERALL_CONFIDENCE}} |

Use `Observed`, `Inferred`, or `Not evidenced` for material claims. Do not turn missing evidence into a positive or negative conclusion.

## Executive Verdict

**Verdict:** {{VERDICT}}

{{VERDICT_RATIONALE}}

| Dimension | Finding | Confidence | Evidence IDs |
| --- | --- | --- | --- |
| Product fit and operability | {{PRODUCT_FIT_FINDING}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |
| Architecture | {{ARCHITECTURE_FINDING}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |
| Quality and tests | {{QUALITY_FINDING}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |
| Privacy and security | {{SECURITY_FINDING}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |
| Delivery readiness | {{DELIVERY_FINDING}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |

## Product And Context

**Product Purpose And Users**

{{PRODUCT_PURPOSE_USERS_AND_VALUE}}

**Current State**

{{CURRENT_PRODUCT_AND_LIFECYCLE_STATE}}

**Scope And Constraints**

| Item ID | Type | Description | Status | Evidence IDs |
| --- | --- | --- | --- | --- |
| CTX-001 | {{SCOPE_CONSTRAINT_ASSUMPTION_OR_NON_GOAL}} | {{DESCRIPTION}} | {{OBSERVED_INFERRED_OR_NOT_EVIDENCED}} | {{EVIDENCE_IDS}} |

**Functional View**

| Capability ID | User or actor | Outcome | Current implementation | Gap | Evidence IDs |
| --- | --- | --- | --- | --- | --- |
| CAP-001 | {{ACTOR}} | {{OUTCOME}} | {{CURRENT_IMPLEMENTATION}} | {{GAP}} | {{EVIDENCE_IDS}} |

## Architecture And Component Inventory

**Architecture Summary**

{{ARCHITECTURE_STYLE_BOUNDARIES_AND_KEY_FLOWS}}

**Components**

| Component ID | Component | Responsibility | Boundary or interface | Dependencies | Runtime or deployment | Status | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CMP-001 | {{COMPONENT}} | {{RESPONSIBILITY}} | {{BOUNDARY}} | {{DEPENDENCIES}} | {{RUNTIME}} | {{OBSERVED_INFERRED_OR_NOT_EVIDENCED}} | {{EVIDENCE_IDS}} |

**Data And Integration Flows**

| Flow ID | Source | Destination | Data or event | Protocol or mechanism | Trust boundary | Failure behavior | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FLW-001 | {{SOURCE}} | {{DESTINATION}} | {{DATA_OR_EVENT}} | {{PROTOCOL}} | {{TRUST_BOUNDARY}} | {{FAILURE_BEHAVIOR}} | {{EVIDENCE_IDS}} |

## Quality And Tests

**Engineering Quality**

| Finding ID | Area | Observation | Impact | Confidence | Evidence IDs |
| --- | --- | --- | --- | --- | --- |
| QLT-001 | {{MAINTAINABILITY_RELIABILITY_PERFORMANCE_OR_OPERABILITY}} | {{OBSERVATION}} | {{IMPACT}} | {{CONFIDENCE}} | {{EVIDENCE_IDS}} |

**Test Inventory And Gaps**

| Test ID | Level or type | Covered behavior | Execution evidence | Gap | Criticality | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- |
| TST-001 | {{UNIT_INTEGRATION_E2E_SECURITY_PERFORMANCE_OR_MANUAL}} | {{COVERED_BEHAVIOR}} | {{RESULT_OR_NOT_RUN}} | {{GAP}} | {{CRITICALITY}} | {{EVIDENCE_IDS}} |

## Privacy And Security

**Data And Trust Model**

| Item ID | Data or asset | Classification | Processing or storage | Trust boundary | Existing control | Gap | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-001 | {{DATA_OR_ASSET}} | {{CLASSIFICATION_OR_NOT_EVIDENCED}} | {{PROCESSING}} | {{TRUST_BOUNDARY}} | {{CONTROL}} | {{GAP}} | {{EVIDENCE_IDS}} |

**Security And Privacy Findings**

| Finding ID | Domain | Finding | Threat or privacy impact | Existing mitigation | Required action | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-F001 | {{IDENTITY_SECRETS_DEPENDENCY_DATA_PRIVACY_LOGGING_OR_OTHER}} | {{FINDING}} | {{IMPACT}} | {{MITIGATION}} | {{ACTION}} | {{EVIDENCE_IDS}} |

State `Not assessed` for controls requiring runtime, cloud, tenant, production, secret-bearing, or external access that was outside the approved scope.

## Risks

| Risk ID | Category | Risk | Likelihood | Impact | Severity | Mitigation | Owner | Evidence IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RSK-001 | {{CATEGORY}} | {{RISK}} | {{LIKELIHOOD}} | {{IMPACT}} | {{SEVERITY}} | {{MITIGATION}} | {{OWNER_OR_OPEN}} | {{EVIDENCE_IDS}} |

Order risks by decision impact and urgency. Do not use numeric precision unless the scoring model is defined.

## Recommendations

| Recommendation ID | Recommendation | Linked risks or findings | Rationale | Priority | Effort | Expected outcome | Acceptance signal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REC-001 | {{RECOMMENDATION}} | {{LINKED_IDS}} | {{RATIONALE}} | {{PRIORITY}} | {{EFFORT}} | {{OUTCOME}} | {{ACCEPTANCE_SIGNAL}} |

Separate required remediation from optional optimization. Prefer configurable, modular changes and established tooling where repository evidence supports them.

## Roadmap

| Roadmap ID | Horizon | Action | Linked recommendations | Dependencies | Owner | Exit criteria |
| --- | --- | --- | --- | --- | --- | --- |
| RDM-001 | {{NOW_NEXT_OR_LATER}} | {{ACTION}} | {{RECOMMENDATION_IDS}} | {{DEPENDENCIES}} | {{OWNER_OR_OPEN}} | {{EXIT_CRITERIA}} |

Keep sequencing dependency-aware. A roadmap item is not an implementation commitment unless separately approved.

## Evidence

| Evidence ID | Source path or locator | Evidence type | Observed fact | Relevance | Confidence | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | {{SOURCE}} | {{CODE_DOC_CONFIG_TEST_COMMAND_OR_EXTERNAL}} | {{OBSERVED_FACT}} | {{RELEVANCE}} | {{CONFIDENCE}} | {{LIMITATIONS}} |

Use canonical source files rather than cache or index files. Record commands and outcomes precisely; do not claim a test ran when it was only inspected.

## Open Decisions

| Decision ID | Question | Options and tradeoffs | Recommended default | Owner | Needed by | Consequence if deferred |
| --- | --- | --- | --- | --- | --- | --- |
| DEC-001 | {{QUESTION}} | {{OPTIONS_AND_TRADEOFFS}} | {{RECOMMENDED_DEFAULT}} | {{OWNER_OR_OPEN}} | {{MILESTONE}} | {{CONSEQUENCE}} |

**Format Adaptation**

Preserve the semantic sections and stable IDs in every output format.

- **Word/DOCX, Markdown, HTML, and PDF:** keep the section order, narrative, and native tables. Use a table of contents for long documents.
- **Excel/XLSX:** use the worksheets declared in the preset frontmatter. Put the executive verdict and assessment control on `Summary`; use one record per row, stable ID columns, evidence ID columns, filters, frozen headers, and wrapped text. Put long narrative in `Detail` or `Notes` columns without dropping it.
- **PowerPoint/PPTX:** make the verdict, risks, recommendations, and roadmap the decision narrative; place detailed inventories and evidence in appendix slides.
- **JSON:** use the semantic section names as top-level keys and preserve stable record IDs and evidence references.
- **CSV:** flatten the assessment into `section`, `record_id`, `field`, `value`, `status`, `confidence`, and `evidence_ids` columns. State that hierarchy and rich layout are intentionally reduced.

Do not omit a required section because a target format is less expressive. Mark unavailable values explicitly.
