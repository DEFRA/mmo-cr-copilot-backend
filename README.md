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

| Endpoint                                     | Description                                              |
| :------------------------------------------- | :------------------------------------------------------- |
| `GET: /health`                               | Platform health check                                    |
| `POST: /api/payloads`                        | Ingest one analytics payload (requires `x-ingest-token`) |
| `GET: /api/payloads`                         | Latest payload per repository and pull request           |
| `GET: /api/payloads/{repository}/{prNumber}` | Full payload history for one pull request, newest first  |
| `GET: /api/sonar/overview`                   | Quality gate status for every linked repository          |
| `GET: /api/sonar/repo?repository=`           | Main branch quality metrics for one repository           |
| `GET: /api/sonar/pr?repository=&prNumber=`   | New code quality metrics for one pull request            |

`{repository}` is URL encoded because it contains a `/`, for example
`/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42`.

Payloads are appended rather than replaced, so the full history of a pull request is retained and
`GET /api/payloads` returns only the most recent entry per `(repository, prNumber)` pair.
`sourceBranch` is populated while a pull request is open but omitted on the final merged message; when
it is missing it is backfilled from the previous message for the same pull request.

## Configuration

All configuration is read from environment variables via convict (`src/config.js`). In CDP
environments these are injected from AWS Secrets Manager and Parameter Store through the CDP Portal —
never commit secrets.

| Variable            | Required | Description                                                                                                                                  |
| :------------------ | :------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URI`         | Yes      | MongoDB connection string                                                                                                                    |
| `MONGO_DATABASE`    | No       | Database name, defaults to `mmo-cr-copilot-backend`                                                                                          |
| `INGEST_TOKEN`      | Yes      | Shared secret the dashboard presents on `POST /api/payloads`. When empty the check is skipped, which is intended for local development only. |
| `SONAR_PROJECT_MAP` | No       | JSON map of `"<git repository>": "<SonarCloud project key>"`. Without it the SonarCloud panels are hidden.                                   |
| `SONAR_TOKEN`       | No       | SonarCloud user token. Only needed for private projects; public projects are read anonymously.                                               |
| `SONAR_BASE_URL`    | No       | Override for SonarQube Server, defaults to `https://sonarcloud.io`                                                                           |
| `HTTP_PROXY`        | No       | CDP outbound proxy. Set in deployed environments so SonarCloud calls can leave the platform.                                                 |

The SonarCloud integration degrades gracefully at every level: no project map means the feature
reports itself as not configured, a repository missing from the map is reported as not linked, and a
404 from SonarCloud is reported as not analysed. In each case the dashboard hides the affected panel
rather than showing an error.

## Development helpers

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

A local environment with:

- Floci for AWS services (S3, SQS, SNS etc)
- Redis
- MongoDB
- This service.
- A commented out frontend example.

```bash
docker compose up --build -d
```

Mock AWS resources can be created when Floci starts up by editing the scripts in `./compose/floci/start.d/`.
MongoDB records can also be created when Mongo starts by editing the scripts in `./compose/mongo/`.

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
