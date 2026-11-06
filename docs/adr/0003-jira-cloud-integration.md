# 0003. Jira Cloud integration

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The dashboard is moving from measuring code to measuring delivery. A merged pull request is an
intermediate step; the unit of value is a Jira ticket that has been delivered. Metrics must not wait
for a production release, so DORA is used in a delivery-based form.

**Decided:**

- The tracker is **Jira Cloud**.
- A ticket is **delivered** when its status is in the **Done status category**
  (`statusCategory = Done`). This works across projects with different workflows.

Findings that shape the integration:

- Jira Cloud's legacy `/rest/api/3/search` is being removed; `/rest/api/3/search/jql` with
  `nextPageToken` paging replaces it.
- Status history comes from the issue changelog; sprints come from the Jira Software Agile API.
- Rate limits are points-based hourly quotas plus per-endpoint burst limits. Clients must honour
  `Retry-After` and request only the fields they need.
- The development-panel API is internal and unsupported. Jira's own GitHub integration links work by
  issue keys in branch names, PR titles and commit messages.
- This service has no public route, so Jira webhooks cannot reach it directly.
- Outbound calls go through the CDP proxy, which denies hosts that are not allow-listed.

## Decision

**Accepted in E5-S1.**

- Adopt Jira Cloud REST API v3 `/rest/api/3/search/jql` with `nextPageToken` paging and Basic auth
  (service account email and API token).
- Authenticate via Jira Cloud basic auth token, stored in environment configuration and CDP Portal
  secrets (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`).
- Track Standard Deployable Units (SDUs) as the count of Done stories whose linked PRs pass the Sonar
  Quality Gate.
- Compute Quality-Adjusted Net Throughput (QANT) as `totalQualityELoc / totalCycleDays`, combining net
  code volume, cycle time, and SonarClean Code quality multiplier $Q_{Sonar}$.
- Define delivered tickets strictly by delivery status category **Done** (`statusCategory.key = "done"`),
  enabling cross-workflow normalisation.
- A proxy-aware Jira client using `createProxyDispatcher()`, with timeouts and a graceful "not
  configured" state.
- Link PRs to tickets by parsing issue keys into `pr-jira-links`, supporting many-to-many associations
  and proportional line attribution.
- Store only what metrics need in `jira-issues`: key, type, status, status category, created and
  resolved dates, transitions, and story points. Minimise people data and omit descriptions.

## Consequences

- Delivery metrics become available per project, aggregated server-side.
- New egress: the Jira Cloud site (`*.atlassian.net`), and `api.atlassian.com` if scoped tokens
  require it, per environment.
- Sync lag: data is as fresh as the last sync, not real time.
- A Done ticket that still has open PRs is a data-quality warning, not blocked.
- Merged PRs with no Jira key are counted and listed as a data-hygiene metric.

## Alternatives considered

- **Jira webhooks** — need a public route; may be added later through a dashboard route.
- **Development-panel API** — internal and unsupported.
- **Delivered = a named status** — differs between workflows; the status category does not.
- **Delivered = production deployment** — turns the dashboard into retrospective analysis; kept as
  the optional label instead.

## Open points

- The Jira site URL, and whether a service account with a scoped API token can be created.
- Which non-Done statuses count as active or waiting, per project, for flow efficiency.
  Resolved by [0011](0011-jira-workflow-status-mapping.md).
- Whether sprints always come from Jira boards or a fixed cadence per project.
- Sync interval and the rate-limit budget per project.
- Retention for Jira snapshots, pending the data protection (DPIA) outcome.

## References

- Jira Cloud issue search (`/rest/api/3/search/jql`) —
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Jira Cloud rate limiting — https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Jira Software Cloud board API —
  https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/
- Atlassian API tokens —
  https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- DORA — software delivery metrics — https://dora.dev/guides/dora-metrics/
