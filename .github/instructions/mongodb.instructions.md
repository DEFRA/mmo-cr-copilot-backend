---
description: 'MongoDB data-access rules using the native driver: collection access, index creation, BSON date handling, aggregation, and keeping storage concerns out of routes. Use when reading or writing MongoDB, adding an index, or changing a stored document shape.'
applyTo: 'src/{services,plugins}/**/*.js'
---

# MongoDB Rules

## No ODM

The native `mongodb` driver only. The `mongoDb` plugin owns the connection and decorates `server.db`
and `request.db`. Services take `db` as their first argument so they are trivially testable:

```js
// CORRECT
export async function findLatestPayloads(db) { ... }

// WRONG — hides the dependency, cannot be tested in isolation
import { db } from '../plugins/mongodb.js'
```

Routes never touch a collection directly; they call a service.

## Dates

Store timestamps as **BSON dates**, not ISO strings — only then can Mongo sort and range-query them.
Convert on the way in and back to ISO strings on the way out, so the API contract stays string-based:

```js
const toDate = (value) => (value ? new Date(value) : undefined)
const toIso = (value) => (value instanceof Date ? value.toISOString() : value)
```

Omit an optional date entirely rather than storing `null` or `undefined`.

## Shaping documents

Strip storage internals (`_id`, `receivedAt`) before returning a document to a caller. The API
response shape is a deliberate contract, not a database dump.

## Indexes

Every query pattern needs a supporting index, created in `createIndexes()` in
`src/plugins/mongodb.js` so it exists before the service takes traffic:

```js
// Serves both the per-PR history query and the "latest per repo+PR" rollup.
await db
  .collection(PAYLOADS_COLLECTION)
  .createIndex({ repository: 1, prNumber: 1, calculatedAt: -1 })
```

Order compound index keys equality → sort → range. Add a comment naming the query the index serves.

## Aggregation

`$sort` before `$group` when using `$first` to pick a "latest per key" document — the group takes the
first document in the pipeline's current order, which is undefined without an explicit sort.

## Writes

- Analytics payloads are **append-only**: history per pull request is retained, never overwritten.
- Duplicate ingestion must be harmless. Do not assume exactly-once delivery.
- Never build a query from unvalidated input. joi has already rejected or stripped unknown keys at the
  route, so
  never bypass that by passing a raw body into a query document.
