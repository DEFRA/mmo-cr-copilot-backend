---
description: 'Vitest conventions for this service: file placement, naming, in-memory MongoDB, server injection, fetch mocking, and what a test should assert. Use when writing or changing any test.'
applyTo: 'src/**/*.test.js'
---

# Testing Rules

## Placement and naming

- A test lives beside the code it covers: `src/services/payloads.js` →
  `src/services/payloads.test.js`.
- Top-level `describe` names the unit with a `#` prefix: `describe('#savePayload', ...)`.
- Test names read as a sentence about behaviour: `test('Should backfill a missing sourceBranch from
the previous message', ...)`.
- Nest a `describe` per scenario when a unit behaves differently by context
  (`describe('When no token is configured', ...)`).

## Assert behaviour, not implementation

```js
// WRONG — asserts how it works
expect(collection.insertOne).toHaveBeenCalled()

// CORRECT — asserts what the caller observes
await expect(collection.countDocuments()).resolves.toBe(1)
```

Reach for the real thing where it is cheap: `vitest-mongodb` gives a real in-memory MongoDB, and
`server.inject()` exercises the real routing, validation, and error-handling stack.

## Server tests

```js
beforeAll(async () => {
  // Dynamic import needed due to config being updated by vitest-mongodb
  const { createServer } = await import('#/server.js')
  server = await createServer()
  await server.initialize()
})
```

Use `server.initialize()` rather than `start()` — it wires routes without binding a port. Always stop
the server in `afterAll`. Clear collections in `beforeEach`, not `afterEach`, so a failing test
leaves its data available for inspection.

## Configuration in tests

convict reads the environment once at import. To exercise a different configuration:

- Set `process.env.X` in `beforeAll` **before** the dynamic `import()` of the module under test, or
- `vi.spyOn(config, 'get')` with an implementation that delegates to a reference to the original
  captured **at module scope**, before any spy exists. Capturing it inside `beforeEach` re-wraps the
  previous spy and recurses.

## Fetch

`.vite/setup-files.js` installs `vitest-fetch-mock` globally. Route responses by URL when a unit
makes several calls concurrently:

```js
fetchMock.mockResponse((request) =>
  request.url.includes('project_status') ? statusResponse : measuresResponse
)
```

`request.url` inside the callback is absolute — match with `includes`, not `startsWith`.

Beware in-memory caches: a client that caches by URL will not re-request between tests in the same
file. Disable the TTL for tests that need a fresh upstream response.

## Coverage

`npm test` runs with coverage and both the PR and publish workflows depend on it. Cover the failure
paths — validation rejection, authentication failure, an unreachable third party, and missing
optional configuration — not just the happy path.
