# Architecture decision records

An architecture decision record (ADR) captures one significant decision: the context, what was
decided, and the consequences. ADRs are written before the change that depends on them and are never
rewritten once accepted — a later decision supersedes them instead.

## Lifecycle

- **Proposed** — drafted for discussion; the direction may still change.
- **Accepted** — agreed; code and instruction files follow it.
- **Superseded** — replaced by a later ADR, which is linked from the status line.
- **Deprecated** — no longer applies and has no replacement.

## Writing an ADR

- Copy [0000-template.md](0000-template.md) to `NNNN-kebab-title.md`, using the next free
  four-digit number. Numbers are never reused.
- Keep it short. Link to sources rather than repeating them.
- Add it to the index below in the same change.

Any deviation from a [DEFRA software development standard](https://defra.github.io/software-development-standards/)
must be raised as a formal exception with DEFRA Delivery Architecture
(delivery.architecture@defra.gov.uk) and recorded in the ADR.

## Index

| ADR                                                     | Title                                                        | Status            |
| :------------------------------------------------------ | :----------------------------------------------------------- | :---------------- |
| [0001](0001-payload-contract-v2.md)                     | Payload contract v2                                          | Accepted          |
| [0002](0002-project-data-model-and-scoping.md)          | Project data model and data scoping                          | Accepted          |
| [0003](0003-jira-cloud-integration.md)                  | Jira Cloud integration                                       | Partly superseded |
| [0004](0004-pr-complexity-model.md)                     | PR complexity model and Leverage methods                     | Accepted          |
| [0005](0005-shift-left-dora-metric-model.md)            | Shift-Left DORA metric model and Delivery Quadrant           | Accepted          |
| [0006](0006-local-sonar-snapshot-fallback.md)           | Local SonarCloud snapshot fallback                           | Accepted          |
| [0007](0007-ai-survival-and-usage.md)                   | AI code survival records and usage                           | Accepted          |
| [0008](0008-role-mappings-and-authorize-endpoint.md)    | Entra token validation, role mappings and authorize endpoint | Accepted          |
| [0009](0009-copilot-usage-ai-credits.md)                | Copilot usage in AI credits                                  | Accepted          |
| [0010](0010-project-slug-jira-key-and-sonar-mapping.md) | Project slug, Jira project key and SonarCloud mapping rules  | Accepted          |
| [0011](0011-jira-workflow-status-mapping.md)            | Jira workflow status mapping                                 | Partly superseded |
| [0012](0012-lazy-pr-scoped-jira-fetch.md)               | Lazy, PR-scoped Jira fetch                                   | Accepted          |
