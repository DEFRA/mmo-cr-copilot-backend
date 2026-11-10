# 0012. Lazy, PR-scoped Jira fetch

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

[ADR 0003](0003-jira-cloud-integration.md) and [ADR 0011](0011-jira-workflow-status-mapping.md)
synced a whole Jira project on a schedule. In practice:

- The full-project sync stored 11,156 `FI0` issues.
- The metric counted every stored Done issue, so `storiesDelivered` was 10,698.
- The wrong story points field (`customfield_10016`) left every point null.
- SDU was 0 because PR quality gates were only captured when the SonarCloud panel opened.
- Long manual syncs returned 502 behind the dashboard BFF's 10 s timeout.

## Decision

- **D1 Fetch scope.** Only issues referenced by a project's PRs are fetched, filtered to the
  project's Jira key prefix, plus the Story or Bug parent of a referenced Task or Sub-task. Epics
  are never fetched.
- **D2 Refresh candidates per view.** Ordered tiers, capped at `JIRA_LAZY_FETCH_MAX_KEYS`: (1)
  window keys that are missing, legacy or re-fielded; (2) window keys stale and not Done; (3)
  all-time referenced keys stale and not Done; (4) all-time referenced keys missing, legacy or
  re-fielded. Done issues are never re-pulled.
- **D3 No scheduled sync.** `POST /api/projects/{slug}/jira/sync`, the timer and
  `JIRA_SYNC_INTERVAL_MINUTES` are removed.
- **D4 Ingest fetch.** Keys first seen at ingest are fetched in the background, prefix-restricted,
  with their parents.
- **D5 Story points field.** Detected from `GET /rest/api/3/field` ("Story Points", else "Story
  point estimate"; numeric schema first) and stored with `jira.storyPointsFieldSource: 'detected'`.
  An admin value sets `'admin'`; `null` hands the choice back to detection.
- **D6 Done stage.** A saved project mapping is authoritative: no Jira-category fallback. The
  fallback stays for detected or default workflows only.
- **D7 Concurrency.** In-process single-flight per `slug|from|to`, an in-process set of keys in
  flight, and idempotent `bulkWrite` upserts by `key` with duplicate-key errors ignored.
- **D8 Slow or unavailable Jira.** Stored data is served. The response carries
  `jira: { configured, stale, pending, error, refreshedAt }`; work continues in the background.
- **D9 SonarCloud.** Missing PR gates of linked PRs for Done stories are fetched through the
  existing client: at most 4 in parallel, 50 PRs, 2.5 s budget, reported as `sonar: { stale }`.
- **D10 Sprint predictability.** Committed items are sprint-scope keys among the PR-scoped issues.
- **D11 Metric selection.** Always by referenced keys, never by `projectSlug`.

**Delivery unit.** The Story. `storiesDelivered` counts distinct Done Stories reached through
PR-referenced keys; `bugsDelivered` counts Bug units; Tasks without a Story or Bug parent count in
`otherItemsDelivered`. `storyPointsDelivered` sums Story points.

**Storage.** New issue fields `parentKey`, `parentIssueType`, `storyPointsField`, `fetchedAt`. New
project fields `jira.storyPointsFieldSource`, `jira.storyPointsFieldDetectedAt`,
`jira.detectedStatusesAt`. New collection `jira-unresolved-keys` `{ key, projectSlug, checkedAt }`,
unique on `key`, expiring after 24 h.

**Config.** `JIRA_FRESHNESS_MINUTES` (15), `JIRA_LAZY_FETCH_BUDGET_MS` (5000),
`JIRA_LAZY_FETCH_MAX_KEYS` (300), `SONAR_LAZY_GATE_BUDGET_MS` (2500), `SONAR_LAZY_GATE_MAX_PRS` (50).

## Consequences

- The numbers drop to PR-referenced work.
- Legacy issues stay in place and are ignored unless referenced.
- The first view of a window may return `jira.pending: true`.
- A Done issue reopened after its last fetch is not seen.
- `firstScanPassRate` for lazily captured PRs reflects the gate at capture time.

**Supersedes** from ADR 0003: "Delivered = status category Done", the sync, and the open point
"Sync interval". From ADR 0011: detection "at the scheduled sync", and category fallback under a
saved mapping.

## Alternatives considered

- **Whole-project sync** — fetches thousands of irrelevant issues and caused the inflated count.
- **Window keys only** — misses Stories whose PR merged last sprint but reached Done this sprint.
- **Repurposing `POST /jira/sync` as a refresh** — nothing is left to sync, and it 502'd on long runs.
- **Fixed `customfield_10016`** — wrong for the eaflood site.
- **A Mongo lock for refreshes** — adds latency to a GET; a multi-instance double fetch is harmless.

## References

- [Jira enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira issue fields](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/)
- [Jira rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
- [SonarCloud Web API](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/web-api/)
- [DEFRA software development standards](https://defra.github.io/software-development-standards/)
