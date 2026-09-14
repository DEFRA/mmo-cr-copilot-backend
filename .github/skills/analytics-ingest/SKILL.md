---
name: analytics-ingest
description: 'Extend or change the Copilot analytics ingest path — the payload contract, its validation, how it is persisted, and how it is queried back out. Use when adding a field to the payload, changing validation rules, adding a query endpoint, changing the storage shape, or adding an index. Do NOT use for third-party integrations such as SonarCloud — use the external-integration skill.'
---

# Skill: Extend the Analytics Ingest Path

The payload contract is shared by three repositories: the GitHub Actions workflow that emits it,
`mmo-cr-copilot-dashboard` which forwards it, and this service which validates, stores, and serves
it. Changing it is a contract change — treat it as one.

Follow `.github/instructions/hapi-api.instructions.md`, `mongodb.instructions.md`,
`security.instructions.md`, and `testing.instructions.md`.

## 1. Understand the current contract

Read in this order:

1. `src/schemas/payload.js` — the joi schema, the single source of truth for the contract.
2. `src/services/payloads.js` — storage shape, date conversion, the `sourceBranch` backfill.
3. `src/routes/payloads.js` — the ingest and query endpoints.
4. `src/plugins/mongodb.js` — the indexes that serve the queries.

## 2. Decide whether the change is backwards compatible

Every change must tolerate old messages that are already stored and old workflows still emitting the
previous shape.

- **Adding a field** → make it optional. Required fields break in-flight producers.
- **Removing a field** → stop reading it first, remove it from the schema in a later change.
- **Renaming a field** → accept both for a transition period; never a hard switch.
- **Changing a type** → add a new field instead.

If the field can be absent in the final merged message but present earlier, follow the
`sourceBranch` precedent and backfill it from the previous message for that pull request.

## 3. Update the schema

Optional values must tolerate an absent key, an explicit `null`, and an empty string — producers emit
all three:

```js
const optionalIsoDateTime = isoDateTime.empty(Joi.valid('', null)).optional()
```

Bound every string (`max()`) and array (`max()`). The schema sets `stripUnknown`, so a field the
contract does not name is dropped rather than rejected — that is what lets an old producer keep
working. Never replace it with `unknown(true)`, which would write whatever the producer sends
straight into Mongo.

## 4. Update storage

- Add new date fields to `ROOT_DATE_FIELDS` so they round-trip as BSON dates.
- Keep the mapping explicit — never spread a raw payload into a document without shaping it.
- Add an index for any new query pattern in `createIndexes()`, with a comment naming the query.

## 5. Update the query endpoints

Decide whether the new data belongs in `GET /api/payloads` (latest per pull request) or
`GET /api/payloads/{repository}/{prNumber}` (full history). Adding a field to the stored document
surfaces it automatically — confirm the dashboard actually needs it before adding it.

## 6. Test

Cover, at minimum:

- A payload with the new field populated.
- A payload with it absent, `null`, and `""`.
- Rejection when it is present but invalid.
- A stored document from **before** the change still reading back correctly.
- The route-level status code for each of those.

## 7. Propagate

- Document any new environment variable in `README.md`.
- If the contract changed, raise the matching change in the dashboard repository and in the workflow
  that produces the payload. Note it in the pull request description.

## Definition of Done

`npm test`, `npm run lint`, and `npm run format:check` pass; old and new payload shapes are both
covered by tests; every new query has an index; and the contract change is recorded for the producer
and consumer repositories.
