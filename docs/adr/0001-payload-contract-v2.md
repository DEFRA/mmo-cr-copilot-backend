# 0001. Payload contract v2 (versioned, additive)

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The analytics payload produced by the shared GitHub Actions workflow in `mmo-cr-devops-common` is
validated by the joi schema in `src/schemas` and stored append-only. Three planned pieces of work
each need new fields:

- **Jira integration** (ADR 0003) needs the Jira issue keys a pull request relates to, and the PR
  title they can be parsed from.
- **The complexity model** (ADR 0004) needs file-level inputs: files changed, test files and test
  lines touched, modules touched, and a summary of excluded files. It also needs a 6-month backfill,
  so backfilled payloads must be distinguishable from live ones.
- **Line-level attribution** from a VS Code extension (dashboard ADR 0004) needs a per-commit
  breakdown of AI completion, chat, agent, pasted and typed lines.

Changing the contract three times would mean three coordinated releases across the producer, this
service and the dashboard. Payloads already stored, and producers not yet upgraded, must keep
working. Payloads carry contributor identities and are personal data.

## Decision

Revise the contract once, additively, as `schemaVersion: 2`. The joi schema in
`src/schemas/payload.js` is the source of truth; this record explains it.

### Versioning

- `schemaVersion` is an integer. A payload with no `schemaVersion` is v1. `1` and `2` are accepted;
  any other value is rejected with 400.
- v1 and v2 are separate joi branches, chosen by `schemaVersion`. Both strip unknown keys, so v2
  fields sent on a payload without `schemaVersion: 2` are dropped, not rejected.
- Optional additive fields need no version bump. A required field or a change of meaning does. A
  rename goes through a transition period where both names are accepted.
- Stored v1 documents are never migrated and never given v2 defaults. Readers treat a missing
  `schemaVersion` as 1 and a missing v2 field as "not collected", which is different from empty.

### v2 fields

The new fields stay flat at the top level, matching `prNumber`, `prCreatedAt` and `prMergedAt`.
`files` and `attribution` are the only new nested objects. On v2 every field below is required unless
noted, so an empty value means "computed, nothing found" rather than "not collected".

| Field                                                                                       | Rule                                                                                                                |
| :------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                                                                             | `2`                                                                                                                 |
| `source`                                                                                    | `live` or `backfill`. A v1 document is read as `live`.                                                              |
| `prTitle`                                                                                   | String, 1 to 256 characters                                                                                         |
| `jiraKeys`                                                                                  | Unique strings matching `^[A-Z][A-Z0-9_]{1,49}-[1-9]\d{0,9}$`, each at most 64 characters, at most 50; `[]` allowed |
| `files.changed`, `files.linesTouched`                                                       | Non-test files and lines (added + deleted) in the net PR diff: the complexity inputs `F` and `L`                    |
| `files.testFilesChanged`, `files.testLinesTouched`                                          | Test files and lines in the net PR diff                                                                             |
| `files.modulesTouched`                                                                      | Distinct non-test modules: the complexity input `M`                                                                 |
| `files.excluded.filesChanged`, `files.excluded.linesTouched`                                | Files and lines removed by the generated/vendored exclusions and `.analyticsignore`                                 |
| `commitBreakdown[].attribution.source`                                                      | `extension`, `legacy-trailer` or `none`                                                                             |
| `commitBreakdown[].attribution.version`                                                     | Integer 1 to 999. Required when `source` is `extension`, forbidden otherwise                                        |
| `attribution.aiCompletionLines`, `aiChatLines`, `aiAgentLines`, `pastedLines`, `typedLines` | Optional integers of 0 or more. Forbidden unless `source` is `extension`                                            |

All counts are integers of 0 or more. `files` is measured on the net diff from the merge base to the
head, so `files.linesTouched` intentionally differs from `summary.totalLinesTouched`, which sums
commits: complexity measures net size, assist rate measures commits.

Attribution and classification are independent signals. A manual re-classification does not change
`attribution`. The producer emits `legacy-trailer` or `none` today; `extension` arrives with the VS
Code extension.

### Deprecating v1

v1 ingest is deprecated on **2027-03-31**, and only once v1 ingests have been zero for 30
consecutive days. This is measured from the `schemaVersion=` field on the ingest log line. Stored v1
documents stay readable indefinitely.

### Size cap

The 2 MiB ingest cap stays in this service, the dashboard and the publisher.

| Item                                                      | Approximate bytes                |
| :-------------------------------------------------------- | :------------------------------- |
| v1 commit entry with a typical subject                    | 330                              |
| `attribution`: `none` / `legacy-trailer` / `extension`    | 30 / 38 / 140                    |
| v2 root additions                                         | under 2.5 KB typical, 4.5 KB max |
| Large PR: 300 commits, all `extension`                    | 145 KB                           |
| Ceiling: 1,000 commits, all `extension`, 200 contributors | 0.53 MB, about 26% of 2 MiB      |

A test asserts the ceiling payload stays below the configured cap.

### Data protection

- Only the PR title is added as free text. It serves ticket linking and display. Commit bodies are
  scanned for Jira keys by the producer but never sent.
- `prTitle`, `jiraKeys`, commit subjects and authors are never logged by the producer, the
  dashboard or this service. The ingest log line carries only the repository, PR number, build ID
  and schema version.
- Jira keys are stored as candidates. Look-alike tokens such as `UTF-8` can appear until the Jira
  integration filters against configured projects.

## Consequences

- One coordinated change across `mmo-cr-devops-common`, this service and the dashboard. The order is
  this service first (deployed to every environment), then the dashboard tests, then the producer.
- Forward compatibility: a backend that predates v2 strips the v2 keys and still stores the payload,
  so a producer merged early loses only the new fields.
- Readers must handle both versions until v1 is retired. v1 payloads have no complexity inputs, Jira
  keys or line-level attribution, so the dashboard must show those as unavailable, not zero.
- The `forbidden` attribution rules reject a producer that sends line counts without the
  `extension` source. This is deliberate and the 400 is visible in the job summary.
- A `backfill` payload can replace a `live` one under the existing newer-`calculatedAt`-wins rule.
  De-duplication is follow-up work; `source` makes it possible.
- No new index. The `jiraKeys` index belongs to the Jira integration.
- The GitHub PR opened time and contributor GitHub login are not part of v2. Adding them later as
  optional fields needs no version bump.

## Alternatives considered

- **Separate contract change per feature** — three releases and three migrations.
- **A new endpoint per version** — duplicates routes and validation for no gain; the version field is
  enough.
- **Breaking v2 with no v1 support** — every producer would need to upgrade in lockstep.
- **All v2 fields optional** — an absent field could not be told apart from "computed, nothing
  found".
- **A nested `pr.title`** — inconsistent with the existing flat `pr*` fields.
- **Rejecting v2 fields on v1 payloads** — would break the stripping tolerance producers rely on.

## References

- joi `alternatives.conditional` — https://joi.dev/api/#alternativesconditionalcondition-options
- Atlassian, changing the project key format —
  https://confluence.atlassian.com/adminjiraserver/changing-the-project-key-format-938847081.html
- GitHub Actions secure use, script injection —
  https://docs.github.com/en/actions/reference/security/secure-use
- ICO, data minimisation —
  https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/data-minimisation/
- Git trailers — https://git-scm.com/docs/git-interpret-trailers
- DEFRA software development standards — https://defra.github.io/software-development-standards/
