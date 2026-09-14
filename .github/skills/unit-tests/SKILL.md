---
name: unit-tests
description: 'Write and strengthen vitest tests for the MMO Copilot analytics backend: unit tests for services, joi schemas and helpers, plus Hapi server.inject route/integration tests against a real MongoDB provided by vitest-mongodb. Use when adding tests for new/changed behaviour, closing coverage gaps, or setting up a test for a new route. Enforces the tiered coverage targets and the DEFRA SonarCloud gate.'
argument-hint: "e.g. 'write tests for the persona-mappings service' or 'close the coverage gap in the sonar client error paths'"
user-invocable: false
---

# Unit & route tests (vitest)

Write fast, deterministic tests that ship **with** the code, following the
[testing instructions](../../instructions/testing.instructions.md). New or changed behaviour is not
done until it has tests and the suite is green.

## When to use

- Adding tests for a new/changed service, joi schema, plugin or helper.
- Adding a route/integration test for a new endpoint.
- Closing a coverage gap flagged by SonarCloud or the coverage report.

## What to test (by layer)

- **Services** — inputs → outputs and error paths against a real database. Assert the **stored
  document** (types, keys, sort order), not just the return value.
- **Schemas** (`src/schemas/`) — accept a complete payload, accept each optional field absent, reject
  each invalid shape with a useful message, and confirm unknown keys are **stripped** rather than
  persisted. The contract lives here; test it exhaustively.
- **Routes (integration)** — via Hapi `server.inject` against `createServer()`; assert the status
  code and the response body. Cover the auth path (missing token, wrong token, valid token) for any
  protected route.
- **Plugins and helpers** — in isolation, mocking IO where it is not the thing under test.
- **Failure paths** — validation errors, not-found, unauthorised, and upstream (third-party) failure
  mapping to a bad gateway. These are **100%**-coverage paths.
- **Optional integrations** — the not-configured path must be covered: the service reports itself as
  unconfigured and never throws at startup.

## Procedure

1. **Read** the code under test and the existing colocated `*.test.js` nearby for the established
   pattern (see `src/services/payloads.test.js` and `src/routes/payloads.test.js`).
2. **Arrange** — build the server in `beforeAll` (`server.initialize()`) and tear down in `afterAll`
   (`server.stop({ timeout: 1000 })`). Clear the collection in `beforeEach` so tests are independent.
   Build payload fixtures with the helpers in `test-helpers/` rather than hand-writing the whole
   shape. Mock outbound third-party HTTP; never hit a real network. Rely on a fixed `TZ=UTC`.
3. **Act** — call the service function directly, or `server.inject({ method, url, headers, payload })`
   for a route.
4. **Assert** — one behaviour per test; assert the status/response/stored document, not internal
   calls.
5. **Name** tests to describe behaviour (`Should reject a request with the wrong ingest token`). Keep
   tests independent and order-agnostic; no real timers or `sleep` — use fake timers.
6. **Run & verify** — `npm test` (with coverage). Confirm all pass and coverage meets the targets
   before finishing.

## Gotchas in this repo

- **Dynamic import for the server.** `vitest-mongodb` rewrites config after module load, so tests
  must `await import('#/server.js')` **inside** `beforeAll` — a top-level static import will connect
  to the wrong database.
- **Dates are BSON dates.** A service test should assert `expect(stored.calculatedAt).toBeInstanceOf(
Date)` on the way in and an ISO string on the way out.
- **Storage internals must not leak.** Assert that a returned payload has no `_id` and no
  `receivedAt`.
- **Env-based auth.** Set `process.env.INGEST_TOKEN` before the dynamic import and delete it in
  `afterAll`, so the token is in place when config is read.
- **Append-only.** A test that saves twice must assert **two** documents, not an overwrite.

## Coverage targets (must hold)

- **≥90%** global · **≥95%** core logic (services, schemas, helpers, domain rules) · **100%**
  error-handling and security-critical paths (validation, ingest auth, error mapping).
- Coverage must be **reported** and must not regress below the DEFRA
  [SonarCloud](https://sonarcloud.io/organizations/defra) baseline; the quality gate stays green.

## Anti-patterns to avoid

- Hitting a real third-party network or depending on external state.
- Time/locale flakiness — always pin `TZ` and use fake timers, never `sleep`.
- Asserting internal calls instead of observable behaviour (status, response, stored document).
- Sharing state between tests — always clear the collection in `beforeEach`.
- Putting real contributor names or any personal data into a fixture.
- Leaving the suite red or skipping a failing test "to fix later".

## Output

- The added/updated `*.test.js` colocated with the source.
- A short note of what is covered, any gaps intentionally left (with rationale), and the
  pass/coverage result from `npm test`.

## References

- [testing instructions](../../instructions/testing.instructions.md) ·
  [copilot-instructions.md](../../copilot-instructions.md)
