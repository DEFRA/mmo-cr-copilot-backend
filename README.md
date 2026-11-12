# mmo-cr-copilot-backend

Backend for the Copilot analytics dashboard. It ingests pull request analytics payloads produced by
GitHub Actions, persists them to MongoDB, and serves them to
[mmo-cr-copilot-dashboard](https://github.com/DEFRA/mmo-cr-copilot-dashboard) together with SonarCloud
code quality metrics.

This service is not exposed publicly. All traffic arrives from the dashboard frontend, which acts as
the backend-for-frontend:

```text
GitHub Actions --POST--> mmo-cr-copilot-dashboard --POST--> mmo-cr-copilot-backend --> MongoDB
        browser <--poll-- mmo-cr-copilot-dashboard <--GET-- mmo-cr-copilot-backend <-- SonarCloud
```

- [Requirements](#requirements)
  - [Node.js](#nodejs)
- [Local development](#local-development)
  - [Setup](#setup)
  - [Development](#development)
  - [Testing](#testing)
  - [Production](#production)
  - [Npm scripts](#npm-scripts)
  - [Update dependencies](#update-dependencies)
  - [Formatting](#formatting)
    - [Windows prettier issue](#windows-prettier-issue)
- [API endpoints](#api-endpoints)
- [Configuration](#configuration)
- [Development helpers](#development-helpers)
  - [MongoDB Locks](#mongodb-locks)
  - [Proxy](#proxy)
- [Docker](#docker)
  - [Development image](#development-image)
  - [Production image](#production-image)
  - [Docker Compose](#docker-compose)
  - [Dependabot](#dependabot)
  - [SonarCloud](#sonarcloud)
- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Requirements

### Node.js

Please install [Node.js](http://nodejs.org/) `>= v24` and [npm](https://nodejs.org/) `>= v11`. You will find it
easier to use the Node Version Manager [nvm](https://github.com/creationix/nvm)

To use the correct version of Node.js for this application, via nvm:

```bash
cd mmo-cr-copilot-backend
nvm use
```

## Local development

### Setup

Install application dependencies:

```bash
npm install
```

### Git hooks

Install git hooks (optional)

```bash
npm run git:hooks
```

### Development

To run the application in `development` mode run:

```bash
npm run dev
```

### Testing

To test the application run:

```bash
npm run test
```

### Production

To mimic the application running in `production` mode locally run:

```bash
npm start
```

### Npm scripts

All available Npm scripts can be seen in [package.json](./package.json).
To view them in your command line run:

```bash
npm run
```

### Update dependencies

To update dependencies use [npm-check-updates](https://github.com/raineorshine/npm-check-updates):

> The following script is a good start. Check out all the options on
> the [npm-check-updates](https://github.com/raineorshine/npm-check-updates)

```bash
ncu --interactive --format group
```

### Formatting

#### Windows prettier issue

If you are having issues with formatting of line breaks on Windows update your global git config by running:

```bash
git config --global core.autocrlf false
```

## API endpoints

| Endpoint                                                                           | Description                                                           |
| :--------------------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| `GET: /health`                                                                     | Platform health check (no token)                                      |
| `POST: /api/auth/authorize`                                                        | Sign-in check: the caller's roles, or `403` if none                   |
| `GET: /api/auth/me`                                                                | The caller's roles and project access                                 |
| `GET/POST/PATCH/DELETE: /api/role-mappings`                                        | Manage group-to-role mappings (Dashboard Admin only)                  |
| `GET: /api/ingest/repositories/{fullName}`                                         | Is a repository mapped? (`x-ingest-token`)                            |
| `POST: /api/payloads`                                                              | Ingest one analytics payload (requires `x-ingest-token`)              |
| `POST: /api/survival`                                                              | Ingest one AI code survival record (`x-ingest-token`)                 |
| `GET: /api/projects/{slug}/churn`                                                  | 21-day AI code churn from survival records                            |
| `PUT: /api/repositories/{fullName}`                                                | Map a repository to a project (its SonarCloud key is kept)            |
| `PUT: /api/repositories/{fullName}/sonar-key`                                      | Set, change or clear one repository's SonarCloud project key          |
| `GET: /api/payloads`                                                               | Latest payload per repository and pull request                        |
| `GET: /api/payloads/{repository}/{prNumber}`                                       | Full payload history for one pull request, newest first               |
| `GET: /api/sonar/overview`                                                         | Gate, coverage, bugs, vulnerabilities per linked repo                 |
| `GET: /api/sonar/repo?repository=`                                                 | Main branch quality metrics for one repository                        |
| `GET: /api/sonar/pr?repository=&prNumber=`                                         | New code quality metrics for one pull request                         |
| `GET/PUT: /api/projects/{slug}/jira/workflow`                                      | The project's Jira workflow stages (Project or Dashboard Admin)       |
| `GET: /api/projects/{slug}/jira/statuses`                                          | Jira statuses seen, detected and live (Project or Dashboard Admin)    |
| `PUT: /api/projects/{slug}/sprint-calendar`                                        | Set the sprint length and a sprint start (Project or Dashboard Admin) |
| Every route except `GET /health`, `POST /api/payloads`, `POST /api/survival` and   |
| `GET /api/ingest/repositories/{fullName}` requires a valid Entra access token. See |
| [Authentication](#authentication).                                                 |

`{repository}` is URL encoded because it contains a `/`, for example
`/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42`. `{fullName}` is encoded the same way.

`PUT /api/repositories/{fullName}/sonar-key` takes `{ "sonarProjectKey": "DEFRA_repo" }` and returns
the repository record. `null` or `""` clears the key. Keys are trimmed, match `^[\w.:-]+$`, are at
most 255 characters and belong to one repository only: a key already in use is `409` with the message
`That SonarCloud project key is already in use` (unique index on `repositories.sonarProjectKey`). A
Dashboard Admin may set any repository's key and a Project Admin only those in their own project;
anyone else gets `403` (Project User) or `404`. Each change is audited as `repository.sonar-key.set`,
`.updated` or `.cleared`. Nothing is sent to SonarCloud when a key is saved. This is the only route
that writes the key: `PUT /api/repositories/{fullName}` ignores a `sonarProjectKey` in its body and
keeps the stored key when a repository is re-mapped. See
[ADR 0010](docs/adr/0010-project-slug-jira-key-and-sonar-mapping.md).

The Jira workflow endpoints are for a Project Admin of that project or a Dashboard Admin (`403` for a
Project User, `404` otherwise) and return `422` when the project has no Jira key. With no saved
mapping, the workflow is detected from the project's Jira statuses at each scheduled sync, or falls
back to the default status names. `PUT` takes `{ version, stages: [{ id, statuses }] }` and returns
`409` when `version` is stale. Delivery metrics and `GET /api/projects/{slug}/jira-issues` use the
effective workflow. See [ADR 0011](docs/adr/0011-jira-workflow-status-mapping.md).

`POST /api/survival` takes the `ai-survival` record produced by the scheduled survival workflow in
`mmo-cr-devops-common`: counts of AI and human lines merged and surviving after `windowDays`, with
no identities. It is idempotent per `(repository, prNumber, windowDays)` and a record only replaces
the stored one when its `measuredAt` is newer (`201` created, `200` updated or not newer). The
contract and the churn maths are in [ADR 0007](docs/adr/0007-ai-survival-and-usage.md).

Commit `attribution.usage` (source `extension` only) carries Copilot model and token counts recorded
by the VS Code attribution extension. It is stored with the payload and never aggregated per person.

Payloads are appended rather than replaced, so the full history of a pull request is retained and
`GET /api/payloads` returns only the most recent entry per `(repository, prNumber)` pair.
`sourceBranch` is populated while a pull request is open but omitted on the final merged message; when
it is missing it is backfilled from the previous message for the same pull request.

## Configuration

All configuration is read from environment variables via convict (`src/config.js`). In CDP
environments these are injected from AWS Secrets Manager and Parameter Store through the CDP Portal —
never commit secrets.

| Variable                                                | Required | Description                                                                                                                                                                                                                                                                                          |
| :------------------------------------------------------ | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`                                             | Yes      | MongoDB connection string                                                                                                                                                                                                                                                                            |
| `MONGO_DATABASE`                                        | No       | Database name, defaults to `mmo-cr-copilot-backend`                                                                                                                                                                                                                                                  |
| `INGEST_TOKEN`                                          | Yes      | Service-to-service secret the dashboard presents on `POST /api/payloads`; the same value is set on the dashboard. GitHub workflows need no secret (they use OIDC at the dashboard). When empty the check is skipped, for local development only.                                                     |
| `SONAR_TOKEN`                                           | No       | SonarCloud user token. Only needed for private projects; public projects are read anonymously. Repository-to-project keys are mapped on the dashboard.                                                                                                                                               |
| `SONAR_BASE_URL`                                        | No       | Override for SonarQube Server, defaults to `https://sonarcloud.io`                                                                                                                                                                                                                                   |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`         | No       | Jira Cloud connection, e.g. `https://eaflood.atlassian.net` with an unscoped API token. Without them, Jira-backed delivery metrics are hidden. `JIRA_EMAIL` and `JIRA_API_TOKEN` are CDP Portal secrets. A scoped token only works with `JIRA_BASE_URL=https://api.atlassian.com/ex/jira/{cloudId}`. |
| `JIRA_FRESHNESS_MINUTES`                                | No       | A stored issue that is not yet Done is fetched again when its window is viewed and it is older than this, default `15`. Issues are fetched lazily (ADR 0012); there is no scheduled sync.                                                                                                            |
| `JIRA_LAZY_FETCH_BUDGET_MS`, `JIRA_LAZY_FETCH_MAX_KEYS` | No       | How long a metrics request waits for Jira (default `5000`) and the most issues it fetches (default `300`); the fetch finishes in the background.                                                                                                                                                     |
| `SONAR_LAZY_GATE_BUDGET_MS`, `SONAR_LAZY_GATE_MAX_PRS`  | No       | How long delivery metrics wait for missing SonarCloud PR quality gates (default `2500`) and the most PRs fetched per request (default `50`).                                                                                                                                                         |
| `HTTP_PROXY`                                            | No       | CDP outbound proxy. Set in deployed environments so SonarCloud calls can leave the platform.                                                                                                                                                                                                         |
| `SONAR_SNAPSHOT_FALLBACK`                               | No       | Local development only. When SonarCloud is not configured, serve the stored Sonar snapshots instead. Startup fails in any other environment.                                                                                                                                                         |

The SonarCloud integration degrades gracefully at every level: no project map means the feature
reports itself as not configured, a repository missing from the map is reported as not linked, and a
404 from SonarCloud is reported as not analysed. In each case the dashboard hides the affected panel
rather than showing an error.

## Authentication

Every request carries `Authorization: Bearer <Entra access token>`, issued to the dashboard on behalf
of the signed-in user. The token is fully validated on every request (RS256 only, Entra v2 issuer for
the configured tenant, audience, `access_as_user` scope, `tid`, `ver` 2.0, `azp` in the allow-list with
`azpacr` 1 or 2, `exp`/`nbf` with 60 seconds of tolerance, `oid` present). A missing or invalid token
is `401` with a `WWW-Authenticate` challenge; a valid token that is not allowed is `403`, including a
token with a group overage (the groups claim was replaced by a link). Roles never come from the
token: the `groups` claim is matched exactly, and case-sensitively, against group **names** in the
`role_mappings` collection. Design and risks: [ADR 0008](docs/adr/0008-role-mappings-and-authorize-endpoint.md).

| Variable                                                | Required              | Description                                                                                                |
| :------------------------------------------------------ | :-------------------- | :--------------------------------------------------------------------------------------------------------- |
| `ENTRA_TENANT_ID`                                       | Deployed environments | Tenant GUID; the only accepted issuer tenant                                                               |
| `ENTRA_BACKEND_CLIENT_ID`                               | Deployed environments | This API's application (client) ID; the required audience                                                  |
| `AUTH_ALLOWED_CLIENT_IDS`                               | Deployed environments | Comma-separated GUIDs of the clients allowed as `azp` (the dashboard)                                      |
| `ENTRA_BACKEND_SCOPE`                                   | No                    | Required delegated scope, default `access_as_user`                                                         |
| `AUTH_BOOTSTRAP_ADMIN_GROUP`                            | No                    | Group name seeded as Dashboard Admin when none exists, default `AG-Users-CopilotAnalytics-Dashboard-Admin` |
| `AUTH_ROLE_CACHE_TTL_MS`, `AUTH_ROLE_CACHE_MAX_ENTRIES` | No                    | Role lookup cache, default 60000 ms and 500 entries; any mapping change clears it                          |
| `AUTH_DEV_BYPASS`                                       | No                    | Local development and tests only: accepts `dev-mock` tokens. Startup fails in any other environment.       |

Startup fails in a deployed environment if the tenant, backend client ID or allowed client IDs are
missing. `Authorization`, `Cookie` and `x-ingest-token` are redacted from logs in every environment.

For local development set `AUTH_DEV_BYPASS=true` and send `Authorization: Bearer dev-mock.<base64url JSON
claims>` (for example `{"oid":"u1","groups":["AG-Users-CopilotAnalytics-Dashboard-Admin"]}`). Roles are
still resolved from `role_mappings`.

## Onboard a project

Projects are created and mapped from the dashboard's admin screen, which calls this service's
project and repository routes. The full runbook (create the project, map repositories, add the
caller workflow with `id-token: write`, set Sonar and Jira keys, assign Entra groups, check that
payloads appear) is in the
[dashboard README](https://github.com/DEFRA/mmo-cr-copilot-dashboard#onboard-a-project).

What this service does in each step:

1. `POST /api/projects` stores the project; slugs are unique (index on `projects.slug`) and a
   duplicate is `409` with the message `That project slug is already in use`. A new project's slug
   is 3 or 4 upper-case letters; existing slugs with digits keep working. An AI-Native project
   needs exactly one Jira project key, checked on every `PUT /api/projects/{slug}`; an AI-Adopted
   project may add one later if it has none. A set key may be changed but not removed (`400` with
   `The Jira project key cannot be removed`); a change resets the Jira sync cursor, detected statuses
   and board, and a concurrent change is `409` (ADR 0013).
2. `PUT /api/repositories/{fullName}` maps a repository to one project (unique index on
   `repositories.fullName`) and re-stamps that repository's stored payloads with the project. Its
   SonarCloud key is set separately through `PUT /api/repositories/{fullName}/sonar-key`.
3. Ingested payloads are stamped with the project of their repository.
4. `jira.projectKeys` and each repository's `sonarProjectKey` drive the Jira sync and SonarCloud.
5. Assign Entra groups: a Dashboard Admin adds role mappings (`POST /api/role-mappings`) from the
   group names to `project-admin` or `project-user` on the project.
6. `GET /api/projects/{slug}/payloads` returns what the dashboard shows.

### Roles and access

| Role            | Granted by                                                    | Can                                                          |
| :-------------- | :------------------------------------------------------------ | :----------------------------------------------------------- |
| Dashboard Admin | A `Dashboard.Admin` role mapping for one of the user's groups | Manage every project, repository mapping and role mapping    |
| Project Admin   | A `project-admin` mapping for the project                     | Manage the project's repository mapping and persona mapping  |
| Project User    | A `project-user` mapping for the project                      | Read the project, its audit logs and commit logs (read-only) |

The role is resolved on every request by the `entra` auth strategy (`src/plugins/entra-auth.js`) and
read from `request.auth.credentials` in `src/common/helpers/project-access.js`. Access is deny by
default: a project with no mappings is reachable by dashboard admins only, and a caller with no role
on a project gets the same `404` as a missing project.

## Development helpers

### Local demo data

`npm run db:seed` loads mock payloads, Jira tickets, sprint scope, PR-to-ticket links and SonarCloud
snapshots for two projects, `FES` (AI-Adopted, Jira `MMOCR`) and `CRAR` (AI-Native, Jira `AGENT`). Project
slugs are 3 or 4 upper-case letters. The seed also writes role mappings for the
`AG-Users-CopilotAnalytics-*` group names. The Jira data covers delivered, reopened, failed and bug tickets, waiting statuses,
linked issues, an open PR on a Done ticket and unlinked PRs. Sonar snapshots are taken at the end
of each sprint, so a past period shows the quality gate as it stood then. `npm run db:clear` removes
it. Persona mappings are left alone.

`npm run dev` sets `SONAR_SNAPSHOT_FALLBACK=true`, so the seeded Sonar data appears without a
SonarCloud connection. See [ADR 0006](docs/adr/0006-local-sonar-snapshot-fallback.md).

### MongoDB Locks

If you require a write lock for Mongo you can acquire it via `server.locker` or `request.locker`:

```javascript
async function doStuff(server) {
  const lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  try {
    // do stuff
  } finally {
    await lock.free()
  }
}
```

Keep it small and atomic.

You may use **using** for the lock resource management.
Note test coverage reports do not like that syntax.

```javascript
async function doStuff(server) {
  await using lock = await server.locker.lock('unique-resource-name')

  if (!lock) {
    // Lock unavailable
    return
  }

  // do stuff

  // lock automatically released
}
```

Helper methods are also available in `/src/helpers/mongo-lock.js`.

### Proxy

We are using forward-proxy which is set up by default. Services are automatically configured with the proxy environment variables when deployed.

Node.js 24 uses these variables to route outbound HTTP(S) requests through the proxy:

NODE_USE_ENV_PROXY=1
HTTPS_PROXY=...
NO_PROXY=...

No additional proxy configuration is required in the service.

## Docker

Build:

```bash
docker build --no-cache --tag mmo-cr-copilot-backend .
```

Run:

```bash
docker run -e PORT=3001 -p 3001:3001 mmo-cr-copilot-backend
```

### Docker Compose

Runs this service on `:3001` with the only infrastructure it uses, MongoDB on `:27017`:

```bash
docker compose up --build --watch
```

`src` is mounted, so code changes reload through `node --watch`. `--watch` also rebuilds the image
when `package.json` or `package-lock.json` changes; without it, source edits still reload. Load the
demo data with `npm run db:seed`. MongoDB records
can also be created when Mongo starts by editing the scripts in `./compose/mongo/`. The service uses
no AWS resources or Redis, so Floci and Redis are left commented out in `compose.yml`.

Start this before the dashboard's own `docker compose up`.

### Dependabot

We have added an example dependabot configuration file to the repository. You can enable it by renaming
the [.github/example.dependabot.yml](.github/example.dependabot.yml) to `.github/dependabot.yml`

### SonarCloud

Instructions for setting up SonarCloud can be found in [sonar-project.properties](./sonar-project.properties)

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government license v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
