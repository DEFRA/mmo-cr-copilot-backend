# 0002. Project data model and data scoping

- **Status:** Accepted
- **Date:** 2026-10-15
- **Note:** Authorisation by project group arrays is superseded by [ADR 0008](0008-role-mappings-and-authorize-endpoint.md).

## Context

Today the service has no concept of a project. Every payload is stored against its repository,
SonarCloud keys come from the `SONAR_PROJECT_MAP` environment JSON, persona mappings are global, and
`GET /api/payloads` returns the latest payload for every pull request so the browser can compute
everything.

The dashboard is moving to many projects feeding one service. Each project has a type
(**AI-adopted** or **AI-native**), is onboarded by a dashboard admin, and is visible only to the
Entra ID groups assigned to it. A 6-month backfill per AI-adopted project will multiply the stored
volume, so returning every payload to the browser will not scale.

**Decided:** a repository belongs to exactly one project.

## Decision

**Accepted (confirmed in E2).**

- Adopted a `projects` collection: `slug` (unique index), `name`, `type` (`ai-adopted` | `ai-native`),
  `adoptionStartDate` (AI-adopted only, splits baseline from adopted PRs), `sprintCalendar` (fixed
  cadence or Jira board), `jira` (project keys and story points field), `adminGroupIds[]` (project
  admin groups), `entraGroupIds[]` (project user groups), timestamps and `archivedAt`.
- Adopted a `repositories` collection: `fullName` (unique index — enforces the one-repo-per-project
  rule), `projectSlug` (indexed), `sonarProjectKey`, `mappedAt`, `mappedBy`. It replaces
  `SONAR_PROJECT_MAP`, which is retained as a seed.
- Payloads gain a denormalised `projectSlug`, stamped at ingest, with a compound index on
  `{ projectSlug: 1, calculatedAt: -1 }`.
- Payloads from a repository not yet mapped to a project are stored with `projectSlug: null`
  (**unassigned**) and discovered via `GET /api/repositories/unassigned` for admin onboarding,
  rather than rejected. Nothing is lost while onboarding.
- Reads are **project-scoped and time-windowed**, for example
  `/api/projects/{slug}/payloads?from=&to=` and `/api/projects/{slug}/sprints`.
- Existing data is migrated idempotently: creates the default project (`mmo-catch-recording`),
  seeds repository mappings from `sonar.projectMap` and existing payloads, and back-stamps
  existing payloads with `projectSlug: 'mmo-catch-recording'`.

## Three-tier role resolution and access model

The backend resolves the caller's role on every request from the signed user context forwarded by
the dashboard (dashboard ADR 0002), in `src/common/helpers/project-access.js`. Only Entra `oid`,
`roles` and `groups` are used; no email or user list is stored.

| Role            | Granted by                                             | Resolves when                          |
| :-------------- | :----------------------------------------------------- | :------------------------------------- |
| Dashboard Admin | Entra app role `Dashboard.Admin`                       | `roles` contains `Dashboard.Admin`     |
| Project Admin   | Membership of a group in the project's `adminGroupIds` | A caller group matches `adminGroupIds` |
| Project User    | Membership of a group in the project's `entraGroupIds` | A caller group matches `entraGroupIds` |

- Roles are ranked Project User < Project Admin < Dashboard Admin; the highest match wins and each
  route declares the minimum role it needs.
- **Deny by default.** A caller with no matching role gets no access. A project with no groups
  configured is reachable by dashboard admins only; groups are never inferred.
- A caller with no role on a project receives the same `404` as a missing project, so slugs cannot be
  probed. A caller with a role that is too low receives `403`. Denials are logged without payload
  content.
- Repository-level data resolves through the repository's project; an unmapped repository is
  dashboard-admin only.

## Consequences

- No read can return another project's data; this is tested.
- The dashboard's proxy allow-list and every view change to project-scoped routes.
- Re-mapping a repository to a different project must re-stamp its payloads, or reads will miss them.
- Append-only history is preserved; the migration only adds `projectId`.

## Alternatives considered

- **Many projects per repository** — makes `projectId` ambiguous at ingest and doubles counts.
- **Scope by repository list on every request** — leaks project membership logic into the dashboard
  and cannot be enforced here.
- **Reject payloads from unmapped repositories** — loses data while a project is being onboarded.

## Open points

- Cardinality wording: the dashboard's metric definitions currently say each project has exactly one
  repository, while this ADR allows a project to hold several. Confirm which is intended.
- Persona mappings per project (recommended) or global.
- Retention for payloads, pending the data protection (DPIA) outcome.
- Whether re-mapping a repository is allowed after payloads have been stamped, and how history is
  handled.
- ~~How the backend enforces project scope from the dashboard's signed request context (dashboard
  ADR 0002).~~ **Resolved:** enforced by `project-access.js` on every request from the signed user
  context (see the role model above).

## References

- MongoDB indexes — https://www.mongodb.com/docs/manual/indexes/
- MongoDB unique indexes — https://www.mongodb.com/docs/manual/core/index-unique/
- DORA — software delivery metrics (avoid disparate comparisons) —
  https://dora.dev/guides/dora-metrics/
