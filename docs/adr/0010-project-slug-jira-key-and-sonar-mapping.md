# 0010. Project slug, Jira project key and SonarCloud repository mapping rules

- **Status:** Accepted; the fixed Jira key in §2 is superseded by
  [ADR 0013](0013-editable-jira-project-key.md)
- **Date:** 2026-11-05

## Context

Three admin inputs were looser than the data they drive:

- **Slugs** accepted digits (`^[A-Z][A-Z0-9]{2,3}$`). New projects should use 3 or 4 letters, but
  stored slugs with digits must keep resolving in paths, role mappings and repository links.
- **Jira keys** were an array of up to 20. Each project maps to one Jira project. AI-Native
  delivery metrics (ADR 0005 §4) depend on Jira, so an AI-Native project without a key shows
  nothing. `PUT /api/projects/{slug}` also replaced the whole `jira` sub-document, wiping
  `jira.lastSyncedAt` written by the Jira sync, and the update schema's defaults reset
  `projectKeys` and `storyPointsField` on any partial update.
- **SonarCloud keys** were free text with no uniqueness. A SonarCloud project measures one
  repository; one key on two repositories reports the same quality data twice. Project admins
  also had no way to change a key after mapping other than re-sending the whole mapping.

## Decision

1. **Slug.** `POST /api/projects` requires `^[A-Z]{3,4}$` (`PROJECT_SLUG_CREATE_PATTERN`). Every
   other slug check keeps `PROJECT_SLUG_PATTERN`, so legacy digit slugs still work. A slug already
   in use is `409` with the message `That project slug is already in use`; a concurrent create
   caught by the unique index on `projects.slug` gets the same response.
2. **Jira key.** `jira.projectKeys` stays an array (no storage change) of at most one key matching
   `^[A-Z][A-Z0-9_]+$`. An AI-Adopted project may have none and may add one later. An AI-Native
   project needs exactly one, checked on create and on **every** update against the project as it
   will be stored; a failure is `400` with
   `AI-Native projects require exactly one Jira project key`. Once a project has a key it is fixed:
   an update whose `jira.projectKeys` differs from the stored key, including `[]`, is `400` with
   `The Jira project key cannot be changed`. Sending the same key again is accepted. The first
   write is conditional on no key being stored, so two concurrent first writes cannot both win.
3. **Partial Jira updates.** Each `jira` field in an update is written by its own dotted path, and
   the update schema has no defaults. Sync-owned fields (`lastSyncedAt`, `statusMapping`,
   `detectedStatuses`) are stripped by the schema and cannot be written through the route.
4. **SonarCloud key.** Trimmed, `^[\w.:-]+$`, at most 255 characters; `''` and `null` mean no key
   and are stored as `null`. A partial unique index on `repositories.sonarProjectKey` (string and
   not empty) makes a key belong to one repository. The service checks first and maps a duplicate
   key error to `409` with the message `That SonarCloud project key is already in use`, naming no
   other repository. If existing data already holds duplicates, start-up logs a warning and
   continues without the index; the check still blocks new duplicates.
5. **Endpoint.** `PUT /api/repositories/{fullName}/sonar-key` with body `{ sonarProjectKey }` sets,
   changes or clears the key and returns the repository record. A Dashboard Admin may change any
   repository; a Project Admin only those in their own project. Unmapped or unknown repositories
   are `404` to everyone else. Changes are audited as `repository.sonar-key.set`, `.updated` or
   `.cleared`; no SonarCloud call is made. It is the only route that writes the key:
   `PUT /api/repositories/{fullName}` strips `sonarProjectKey` from its body and a re-mapped
   repository keeps its stored key.

## Consequences

- Duplicate SonarCloud links cannot be created, and admins can fix a key without remapping.
- A Jira key, once set, cannot be corrected through the API; a wrong key needs a data fix.
- The dashboard must proxy the new endpoint, handle both `409` messages, send one Jira key for
  AI-Native projects, treat a set Jira key as read-only, and stop sending `sonarProjectKey` when
  mapping a repository.
- Existing data is wiped and re-seeded, so there is no tolerance for multi-key projects or
  AI-Native projects without a key. A concurrent first-time key write that loses the race is
  refused with the same `400` as a change.

## Alternatives considered

- **Validate the Jira rule in joi with `.when`** — joi failures return the generic
  `Invalid request input`, and an update cannot see the stored type.
- **Store a single `jira.projectKey` string** — needs a migration and changes the API shape for
  the dashboard and the Jira sync.
- **Fail start-up on duplicate SonarCloud keys** — would take the service down for a data issue.

## References

- [ADR 0002](0002-project-data-model-and-scoping.md), [ADR 0003](0003-jira-cloud-integration.md),
  [ADR 0005](0005-shift-left-dora-metric-model.md)
- [MongoDB partial indexes](https://www.mongodb.com/docs/manual/core/index-partial/)
