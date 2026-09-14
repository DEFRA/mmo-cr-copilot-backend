---
description: 'Hapi 21 route, plugin, validation and error-handling conventions for a JSON API. Use when adding or changing a route, a Hapi plugin, request validation, or an error response.'
applyTo: 'src/{routes,plugins}/**/*.js'
---

# Hapi API Rules

## Route shape

Routes are plain objects exported from `src/routes`, registered by `src/plugins/router.js`. Keep the
handler thin: validate with joi, delegate to a service, shape the response.

```js
export const payloads = [
  {
    method: 'POST',
    path: '/api/payloads',
    options: {
      pre: [{ method: requireIngestToken }],
      validate: { payload: analyticsPayloadSchema }
    },
    handler: async (request, h) => {
      const record = await savePayload(
        request.db,
        request.payload,
        request.logger
      )
      return h.response({ status: 'stored' }).code(201)
    }
  }
]
```

## Validation

- Declare `validate.payload`, `validate.params`, and `validate.query` for every route that takes
  input. A route with no schema accepts anything.
- joi rejects unknown keys by default — keep it that way for `params` and `query`, it is the cheapest
  injection defence. The analytics payload is the one exception: it sets `stripUnknown` so a producer
  on an older or newer field set still ingests, while only the agreed contract is stored.
- `failAction` (registered globally) logs and rethrows, so validation failures return `400` with no
  internal detail leaked.
- Handlers must not re-check what a schema already guarantees.

## Authentication

Guard a route with a `pre` handler rather than inline checks, so the guard is reusable and runs
before the handler allocates anything:

```js
options: {
  pre: [{ method: requireIngestToken }]
}
```

## Responses and errors

- Success: `h.response(body).code(statusCode)`. Return plain JSON-serialisable objects.
- Client error: throw a `@hapi/boom` error — `Boom.unauthorized()`, `Boom.badRequest()`.
- Third-party failure: `Boom.badGateway()`. Never surface an upstream stack trace or body.
- Log the cause, return a generic message:

```js
request.logger.error({ err: error }, 'Failed to fetch SonarCloud metrics')
return Boom.badGateway('Failed to fetch SonarCloud metrics')
```

- Never put an exception message straight into a response body.

## Plugins

A plugin that provides a dependency decorates both the server and the request, so services can be
reached from either:

```js
server.decorate('server', 'sonar', client)
server.decorate('request', 'sonar', () => client, { apply: true })
```

Register plugins in `src/server.js` in dependency order. A plugin for an optional integration must
register successfully even when the integration is unconfigured.

## Path parameters

A repository name contains `/`, so it is URL-encoded in a path segment
(`/api/payloads/DEFRA%2Frepo/42`). Hapi decodes path parameters — do **not** call
`decodeURIComponent` again. When a value is re-sent upstream, re-encode it explicitly.

Prefer a query parameter over a path segment for values containing `/` when a proxy sits in front of
the service.
