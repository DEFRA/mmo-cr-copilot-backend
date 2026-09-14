---
description: 'OWASP Top 10 rules for a Node.js JSON API: input validation, authentication, injection, secrets, SSRF, error handling, and dependencies. Use when handling external input, secrets, authentication, or any outbound request.'
applyTo: 'src/**/*.js'
---

# Security Rules — OWASP Top 10 for a Node API

## Untrusted input

Anything crossing a trust boundary — request bodies, query strings, path parameters, headers, and
third-party API responses — is untrusted until validated.

- Every route declares a joi schema. joi rejects unknown keys by default; do not relax that for
  `params` or `query`. The analytics payload strips them instead, which is equally safe — the
  document written to Mongo still contains only the agreed contract.
- Never spread an unvalidated body into a database document or a query filter.
- Never interpolate user input into a URL path without encoding it.

## Authentication

- Compare secrets in constant time; `===` leaks length and content through timing.

```js
// WRONG
if (request.headers['x-ingest-token'] === expected) { ... }

// CORRECT
if (isTokenValid(request.headers['x-ingest-token'], expected)) { ... }
```

- Guard write endpoints with a `pre` handler so the check runs before any work.
- Fail closed in deployed environments. A skipped check is acceptable only when no secret is
  configured at all, and it must log a warning saying so.

## SSRF

The service makes outbound calls on behalf of a caller (SonarCloud, the frontend proxy). Never let a
caller influence the host or path:

- Build every upstream URL from a configured base plus a path this code owns.
- Interpolate only validated, encoded parameters.
- Never accept a URL as a request parameter.

## Secrets

- Read only via convict, marked `sensitive: true`.
- Never logged, never echoed in a response, never in an error message.
- A token that is a `<placeholder>` is treated as absent, not as a value.

## Error handling

- Catch, log with context, return a generic Boom error. Never return an upstream body or a stack.
- Distinguish retryable (`502` for an unreachable third party) from non-retryable (`400` for a bad
  payload) so callers behave correctly.
- Missing optional configuration is a logged warning, never an exception.

## Dependencies

- `npm run security-audit` (`--audit-level=critical`) runs in CI and must pass.
- `.npmrc` pins exact versions (`save-exact=true`) and enforces `min-release-age` — do not loosen
  either.
- Prefer a small standard-library solution to a new dependency.

## Denial of service

- Every outbound request sets `AbortSignal.timeout(...)`.
- Cache third-party responses with a TTL rather than calling per request.
- Bound the size of anything accepted from outside (`payload.maxBytes`, joi `max()` on strings and
  arrays).
