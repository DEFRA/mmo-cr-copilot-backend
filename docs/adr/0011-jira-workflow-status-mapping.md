# 0011. Jira workflow status mapping

- **Status:** Accepted; detection timing and category fallback under a saved mapping superseded by [0012](0012-lazy-pr-scoped-jira-fetch.md)
- **Date:** 2026-11-05

## Context

Jira delivery metrics ([ADR 0003](0003-jira-cloud-integration.md),
[ADR 0005](0005-shift-left-dora-metric-model.md)) depended on guesses about status names:

- **Start** was the first transition whose target contained "progress" or whose source contained
  "to do" or "backlog".
- **Delivered** was the status category `done` with the window on `resolutiondate`. A workflow that
  never sets a resolution was never counted, and the Done category also holds Cancelled, Rejected
  and Duplicate.
- **Reopens** and the first Done time came from the resolution field being cleared or set.
- **Waiting** statuses were a fixed list, overridable per project by `jira.waitingStatuses`.

Teams name statuses differently, so each project needs to say which of its statuses mean what.

## Decision

**Stage catalogue.** Ten stages in a fixed order, each with a kind that drives every calculation:
To Do (`todo`, required), In Progress (`active`), Ready for Review (`waiting`), In Review
(`active`), Ready for Test (`waiting`), In Test (`active`), Ready for Release (`waiting`), Blocked
or On Hold (`waiting`), Done (`done`, required) and Cancelled (`excluded`). The catalogue and the
default status names (`STATUS_BASELINE`, 113 names) live in `src/services/workflow-stages.js`.
Status names match case- and space-insensitively, and a status belongs to one stage only.

**Effective workflow**, in order:

1. **Project** — the mapping a project admin or dashboard admin saved, stored as
   `projects.jira.statusMapping = { version, stages: [{ id, statuses }], updatedAt, updatedBy }`.
2. **Detected** — when nothing is saved, the statuses the scheduled Jira sync read from
   `GET /rest/api/3/project/{key}/statuses` (stored as `jira.detectedStatuses`, names and
   categories only). Each goes to the stage whose default names include it, otherwise by its Jira
   category (`new` → To Do, `indeterminate` → In Progress, `done` → Done). An empty To Do or Done is
   filled from the defaults so metrics always have a start and an end.
3. **Default** — the baseline names.

**Classifying a status** seen in an issue's history: the effective workflow; then, for a detected
workflow only, the default names; then the Jira category of that name as a current status on any
stored issue; otherwise `unmapped`, which counts as active time and is reported. A saved mapping is
authoritative: its unlisted names never fall back to the defaults.

**Per-issue flow** is recalculated on read from the stored `statusHistory`, so a mapping change
applies retroactively:

- **Start** is the first move out of To Do, into an active, waiting, done or unmapped status
  (creation time if the issue was created there). Cancelled from To Do never starts.
- **Done** is the last move into a done stage, only while the issue is in one; **first Done** is
  the first such move and drives sprint predictability.
- **Reopens** are moves out of a done stage, except into Done or Cancelled. A Cancelled issue
  counts nowhere, and its flow time ends at its last move into Cancelled.
- Time after the start in waiting, To Do, or an earlier Done counts as waiting for flow efficiency.
- A current status the history has not caught up with is added at the last update, never before the
  last recorded move. Issues with no stored history start at creation.

**API.** `GET` and `PUT /api/projects/{slug}/jira/workflow` and
`GET /api/projects/{slug}/jira/statuses`, for project admins and dashboard admins only, `422` when
the project has no Jira key. Saves use the stored `version` for optimistic concurrency (`409` when
stale) and are audited as `jira-workflow.updated`. `GET /jira-issues` gains a `flow` block per issue
and `GET /delivery-metrics` gains `workflow: { source, version, unmappedStatuses }`.

**Sync.** Each project sync, scheduled or `POST /api/projects/{slug}/jira/sync`, stores the detected
statuses next to `jira.lastSyncedAt`; a failed or empty status fetch logs a warning and keeps the
previous list. A changelog the search response cut short
is fetched in full from `GET /rest/api/3/issue/{key}/changelog`.

## Consequences

- Delivery numbers shift on deploy: Done no longer depends on a resolution, Cancelled-stage tickets
  drop out, and start times follow the mapping.
- Projects get sensible metrics with no admin action, and admins can correct them.
- One extra Jira call per project per sync, and paged changelog calls for long histories. Issues
  synced before this change may hold a truncated history; a full `POST /jira/sync` per project
  repairs that.
- Status names, not IDs, are matched. A renamed Jira status needs its old name kept in the mapping;
  storing status IDs is a follow-up.
- One mapping per project covers every issue type.

## Alternatives considered

- **Status categories only** — cannot separate waiting from active work or Done from Cancelled.
- **Mapping applied only from the save date** — needs effective-dated versions; rejected for now.
- **Default names only, no detection** — gives unmapped statuses to every project whose names differ.

## References

- Atlassian, work item statuses and resolutions —
  https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-statuses-priorities-and-resolutions/
- Atlassian, workflow status categories —
  https://support.atlassian.com/jira-cloud-administration/docs/what-is-a-workflow-status/
- Atlassian, control chart (cycle time across statuses) —
  https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-control-chart/
- Jira REST v3, project statuses —
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
- Jira REST v3, issue changelog —
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
