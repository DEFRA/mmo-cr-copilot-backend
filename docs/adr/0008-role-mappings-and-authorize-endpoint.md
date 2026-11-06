# 0008. Entra token validation, role mappings and the authorize endpoint

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The dashboard BFF signs users in with Microsoft Entra ID and calls this service on their behalf. Until
now the service trusted an HMAC-signed `x-cdp-user-context` header built by the BFF, and project
access came from group arrays stored on each project. That made the BFF a single point of trust, left
two sources of truth for authorisation, and carried no proof of who the user was.

Entra emits group **display names** in the `groups` claim for this application (a tenant setting). The
product owner decided to key mappings on those names rather than object IDs.

## Decision

**Every route requires a validated Entra access token.** A Hapi scheme (`entra-bearer`, strategy
`entra`) is the default auth, so a new route is protected unless it explicitly opts out. The token is
validated in full on every request; nothing is cached about the token itself.

| Check           | Rule                                                                               |
| :-------------- | :--------------------------------------------------------------------------------- |
| Algorithm       | RS256 only (`none` and HS256 rejected); keys from the tenant's JWKS                |
| Issuer          | `https://login.microsoftonline.com/{tenant}/v2.0` for the configured tenant only   |
| Audience        | The backend client ID (not the App ID URI)                                         |
| `ver`, `tid`    | `2.0`; equal to the configured tenant                                              |
| `scp`           | Contains `access_as_user`                                                          |
| `azp`, `azpacr` | `azp` in `AUTH_ALLOWED_CLIENT_IDS`; `azpacr` is `1` or `2` (a confidential client) |
| `exp`, `nbf`    | Required, with 60 seconds of clock tolerance                                       |
| `oid`           | Required and a GUID                                                                |
| Group overage   | `hasgroups` or `_claim_names.groups` present: `403`, logged as `group-overage`     |

**Responses.** No token or an invalid one is `401` with a `WWW-Authenticate: Bearer` challenge
(`invalid_request` for a non-Bearer scheme, `invalid_token` for a bad token). A valid token that is not
allowed is `403`: a missing scope adds `insufficient_scope`, an overage and a user with no role mapping
are plain `403`. A project the caller cannot see stays `404`, the same as a missing project.

**Routes with `auth: false`**: `GET /health`, `POST /api/payloads`, `POST /api/survival` (these two are
guarded by `x-ingest-token`) and `GET /api/ingest/repositories/{fullName}` (also `x-ingest-token`; the
BFF asks whether a repository is mapped, because GitHub Actions ingest has no user). A test lists
`server.table()` and fails if any other route disables auth.

**Role mappings.** The `role_mappings` collection maps a group **name**, exactly as the token emits it
and compared case-sensitively, to a role: `Dashboard.Admin` (global), or `project-admin` /
`project-user` on one project. `{groupName, projectSlug}` is unique. Dashboard Admin is decided only by a
stored mapping; a `roles` claim in the token is ignored. Roles resolve per request through a cache of
60 seconds and 500 entries, cleared on every mapping or project change.

**Endpoints.** `POST /api/auth/authorize` (sign-in: `403` if the caller has no role) and
`GET /api/auth/me` (always `200` for a valid token) return
`{ user: { oid, tid, name, email, roles, projectRoles, allowedProjects } }` and never the groups.
`/api/role-mappings` (`GET`, `POST`, `PATCH /{id}`, `DELETE /{id}`) is Dashboard Admin only, including
reads, and every write is audited with the actor's `oid`.

**Lockout protection and bootstrap.** The last `Dashboard.Admin` mapping cannot be deleted or
demoted (`409`), serialised with a lock. On start, if no admin mapping exists, one is created for
`AUTH_BOOTSTRAP_ADMIN_GROUP` (default `AG-Users-CopilotAnalytics-Dashboard-Admin`), audited as actor
`system`. Recovery from a mistaken group name is to fix the Entra group membership, or insert a mapping
directly in MongoDB and restart.

**No legacy path.** The HMAC user context, `AUTH_CONTEXT_SECRET` and the project `adminGroupIds` /
`entraGroupIds` arrays are removed with no compatibility flag. Start-up drops the arrays from stored
projects and renames the earlier `groupId` field of role mappings to `groupName`.

**Fail closed.** `AUTH_DEV_BYPASS` (accepts `dev-mock` tokens) is refused unless the environment is
`local` or the process is a test run. A deployed environment will not start without the tenant, backend
client ID and allowed client IDs. `Authorization`, `Cookie` and `x-ingest-token` are redacted from
logs everywhere.

## Consequences

- One source of truth for authorisation, changed at runtime by a Dashboard Admin without a deploy.
- The BFF can no longer assert identity; a leaked BFF secret does not let someone impersonate users.
- **Accepted risk: display names as keys.** Group display names are mutable and not unique in Entra, so
  renaming a group or creating a look-alike group could grant or remove access. The owner accepted this
  to avoid managing object IDs. Mitigations: exact case-sensitive matching, every mapping change is
  audited with the actor, the admin screen warns that names are trusted, and the group-creation right
  in the tenant should be restricted. Moving to object IDs later is a data migration of
  `role_mappings.groupName` plus a token setting change.
- Every request costs one signature check and, on a cache miss, one role lookup.
- Users in more groups than Entra puts in a token (overage) are refused, not resolved through Graph.

## Alternatives considered

- **Group object IDs as keys** — stable and unique, but the owner chose names for operability.
- **Entra app roles instead of groups** — assignment is managed in Entra only, so the dashboard could
  not manage access itself.
- **Keep the HMAC header alongside tokens** — leaves the BFF as a trust anchor and doubles the
  surface; rejected, no compatibility mode.
- **Resolve overage through Microsoft Graph** — adds a dependency and a permission; deferred.

## References

- [Microsoft identity platform access tokens](https://learn.microsoft.com/entra/identity-platform/access-tokens)
- [Validate tokens](https://learn.microsoft.com/entra/identity-platform/access-tokens#validate-tokens)
- [Configure group claims](https://learn.microsoft.com/entra/identity-platform/optional-claims#configure-groups-optional-claims)
- [ADR 0002](0002-project-data-model-and-scoping.md), superseded in part: project groups moved to role mappings
- [DEFRA software development standards](https://defra.github.io/software-development-standards/)
