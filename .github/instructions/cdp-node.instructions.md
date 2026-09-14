---
description: 'Core Delivery Platform conventions for a Node.js service: convict configuration, pino/ECS logging, request tracing, health checks, secrets, and outbound egress through the platform proxy. Use when adding configuration, logging, plugins, startup code, or any outbound HTTP call.'
applyTo: 'src/**/*.js'
---

# CDP Node.js Service Rules

## Configuration — convict only

Every configurable value lives in `src/config.js` with a `doc`, a `format`, a default, and an `env`
key. Secrets are marked `sensitive: true`.

```js
// WRONG — bypasses validation, undocumented, untestable
const token = process.env.INGEST_TOKEN

// CORRECT
const token = config.get('ingest.token')
```

`config.validate({ allowed: 'strict' })` runs at import, so an unknown or malformed value fails fast
at startup rather than at the first request.

Read config **inside** the function that needs it, not at module scope, unless the value is genuinely
immutable for the process lifetime (e.g. a route's `maxBytes`). Module-scope reads cannot be stubbed
in tests.

## Secrets

- Injected as environment variables from AWS Secrets Manager / Parameter Store by the CDP Portal.
- Never committed. No `.env` in git; `--env-file-if-exists=.env` is for local development only.
- Never logged, never returned in a response, never included in an error message.
- Compare secrets in constant time (`node:crypto` `timingSafeEqual`), never with `===`.

## Logging — pino, ECS format

Use the request or server logger so trace correlation is preserved:

```js
// WRONG
console.log('stored payload', payload)

// CORRECT
request.logger.info(`Stored analytics payload for ${repository}#${prNumber}`)
request.logger.error({ err: error }, 'Backend request failed')
```

- An error goes in the `err` property of the merge object, not in the message.
- Never log request bodies, tokens, connection strings, or personal data.
- `/health` is excluded from request logging by `loggerOptions.ignorePaths` — keep it that way.

## Tracing

`@defra/hapi-tracing` propagates the `x-cdp-request-id` header and the logger mixin attaches it to
every line. Do not construct your own correlation id.

## Health check

`GET /health` must stay cheap, unauthenticated, and free of downstream calls — the platform uses it
for container health. Do not add database or third-party checks to it.

## Outbound egress

Platform egress to the internet is only permitted through the Squid proxy.

```js
// CORRECT — third-party host
const dispatcher = createProxyDispatcher()
await fetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) })
```

Internal platform services (resolved through CloudMap service discovery) are called **directly** —
routing them through the proxy will fail.

Always set a timeout: `signal: AbortSignal.timeout(config.get('...requestTimeoutMs'))`.

## Startup and shutdown

- `hapi-pulse` handles graceful shutdown; register cleanup with `server.events.on('stop', ...)`.
- Never call `process.exit()` from application code.
- Optional integrations must not block startup. Log that the feature is disabled and carry on.

## Module layout

| Location        | Contains                                                 |
| :-------------- | :------------------------------------------------------- |
| `src/config.js` | convict schema — the only place `process.env` is read    |
| `src/plugins/`  | Hapi plugins that decorate the server or register routes |
| `src/routes/`   | Route definitions and handlers, thin                     |
| `src/services/` | Business logic and data access, no Hapi types            |
| `src/schemas/`  | joi schemas for external contracts                       |
| `src/common/`   | Cross-cutting helpers                                    |

Import with the `#/` alias (`#/services/payloads.js`), never with `../../..`.
