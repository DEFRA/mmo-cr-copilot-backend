# 0013. Editable Jira project key

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

[ADR 0010](0010-project-slug-jira-key-and-sonar-mapping.md) §2 fixed a project's Jira key once set,
so a wrong or superseded key needed a data fix. The CR project was onboarded with `MMOCR`, while its
work is tracked under `CRAR`, so every CR pull request's Jira keys are filtered out.

Scoping is computed at read time: payload and manual-link keys are filtered by the project's current
key (`inProjectKeys`), and issues are fetched lazily by key (ADR 0012). The stored state that is
derived from the old key is `jira.lastSyncedAt` (incremental sync cursor), `jira.detectedStatuses`
and `jira.detectedStatusesAt` (statuses of the old Jira project), and `jira.boardId` (a board of
the old Jira project).

## Decision

1. A Dashboard Admin may **change** a set Jira key through `PUT /api/projects/{slug}`. The key stays
   a single-item array matching `^[A-Z][A-Z0-9_]+$`.
2. A set key cannot be **removed**: `jira.projectKeys: []` on a project with a key is `400` with
   `The Jira project key cannot be removed`. The AI-Native rule of ADR 0010 is unchanged.
3. When a set key is replaced, the same write resets `jira.lastSyncedAt` and
   `jira.detectedStatusesAt` to `null`, `jira.detectedStatuses` to `[]`, and unsets `jira.boardId`
   unless the request sends one. The next sync is full and statuses are re-detected. The saved
   workflow (`jira.statusMapping`) is kept for the admin to review.
4. The write is conditional on the key read by the same request. A concurrent change makes it `409`
   with `The Jira project key was changed by someone else`.
5. The `project.updated` audit entry records `jiraKey` before and after.
6. Stored issues, sprint scope and PR links are not deleted. Issues of the old Jira project simply
   fall out of scope.

## Consequences

- Admins can correct a key without a data fix. Jira metrics switch to the new key on the next read.
- Pull requests whose payloads carry no key of the new project show no Jira data until they are
  re-collected (backfill) or linked manually.
- The dashboard must offer the change, explain its effect, and handle the new `400` and `409`.

## Alternatives considered

- **Keep the key fixed and fix the data by hand** — the reason for this ADR.
- **Allow several keys** — ADR 0010 limited projects to one Jira project; out of scope.
- **Delete issues of the old key** — they may be referenced again if the key is changed back, and
  the lazy fetch re-reads what it needs.

## References

- [ADR 0010](0010-project-slug-jira-key-and-sonar-mapping.md),
  [ADR 0012](0012-lazy-pr-scoped-jira-fetch.md)
