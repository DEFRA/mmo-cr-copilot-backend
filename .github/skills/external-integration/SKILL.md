---
name: external-integration
description: 'Add, change, or debug an outbound integration with a third-party API (SonarCloud and anything like it) — proxy-aware requests, optional configuration, graceful degradation, caching, timeouts, and keeping credentials server-side. Use when calling an external service from the backend. Do NOT use for the analytics payload contract — use the analytics-ingest skill.'
---

# Skill: Outbound Third-Party Integration

Follow `.github/instructions/cdp-node.instructions.md`, `security.instructions.md`, and
`testing.instructions.md`. `src/services/sonar.js` is the reference implementation — mirror its
shape.

## 0. Non-negotiables

- **The credential never leaves the server.** The browser talks to the dashboard, the dashboard talks
  to this service, this service holds the token. If asked to send a token to the browser, stop and
  implement the proxy pattern instead.
- **The integration is optional.** The service must start, pass its health check, and serve every
  other route when the integration is unconfigured or the third party is down.
- **Egress goes through the CDP proxy.** Internet-bound calls need `createProxyDispatcher()`.

## 1. Add configuration

A section in `src/config.js` with a base URL, the credential (`sensitive: true`), a request timeout,
and a cache TTL. Decide what "configured" means — for SonarCloud it is the presence of a project map,
because the token itself is only needed for private projects.

## 2. Build the client as a factory

```js
export function createSonarClient(options = {}) {
  const { baseUrl = config.get('...'), logger = createLogger(), dispatcher = createProxyDispatcher() } = options
  ...
}
```

Defaults come from config; every dependency is overridable. This is what makes the client testable
without touching the environment.

## 3. Make the requests safe

- Always `signal: AbortSignal.timeout(requestTimeoutMs)`.
- Attach the dispatcher only when one exists, so tests and local development are unaffected.
- Build the URL from the configured base plus a path this code owns. Never accept a caller URL.
- Cache by full URL with a TTL — third-party rate limits are real.

## 4. Map every failure to a defined outcome

Decide, per status, what the dashboard should show:

| Upstream           | Result                                      | Why                                      |
| :----------------- | :------------------------------------------ | :--------------------------------------- |
| Not configured     | `{ configured: false }`                     | Feature off — hide the panel             |
| Unknown entity     | `{ configured: true, linked: false }`       | Nothing to show — hide the panel         |
| `404`              | "not analysed" result, or treat as unlinked | Absence of data is not an error          |
| `401` with a token | Retry once anonymously, then degrade        | A stale token must not break public data |
| Other non-2xx      | Throw; the route returns `502`              | A genuine upstream fault                 |

Never let a third-party failure produce a `500`.

## 5. Expose it

Register a plugin in `src/plugins` that constructs the client once and decorates the server and
request. Do any diagnostic validation (for example checking a token) on the `start` event, never
during `register` — registration must not depend on the third party being reachable.

Add thin routes that return the client's already-shaped result. Routes must not reshape or reinterpret
it.

## 6. Test

With `vitest-fetch-mock`, cover:

- Configured and unconfigured.
- A successful response, and the shape the dashboard receives.
- `404`, `401`-then-anonymous-retry, and `500`.
- The cache serving a repeat call, and refetching after the TTL.
- The dispatcher attached when a proxy is configured and absent when it is not.
- Timeout and network failure degrading rather than crashing.

Disable the cache TTL in route tests that need distinct upstream responses — a shared client caches
across tests in a file.

## Definition of Done

The service starts unconfigured; every failure mode has a test; no credential appears in a log, a
response, or the repository; every outbound call has a timeout and goes through the proxy; and the
new configuration is documented in `README.md`.
