export const PAYLOADS_COLLECTION = 'payloads'

// Payload keys holding an ISO-8601 date-time. Stored as BSON dates so Mongo can
// sort and range-query them, converted back to ISO strings on the way out.
const ROOT_DATE_FIELDS = [
  'calculatedAt',
  'prCreatedAt',
  'firstCommitAt',
  'lastCommitAt',
  'prMergedAt'
]

function toDate(value) {
  return value ? new Date(value) : undefined
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value
}

function mapDefined(source, fields, transform) {
  const out = {}
  for (const field of fields) {
    const value = transform(source[field])
    if (value !== undefined) {
      out[field] = value
    }
  }
  return out
}

function toDocument(payload) {
  return {
    ...payload,
    ...mapDefined(payload, ROOT_DATE_FIELDS, toDate),
    commitBreakdown: payload.commitBreakdown.map((commit) => ({
      ...commit,
      ...mapDefined(commit, ['committedAt'], toDate)
    }))
  }
}

function toPayload(doc) {
  const { _id: _ignoredId, receivedAt: _ignoredReceivedAt, ...rest } = doc

  return {
    ...rest,
    ...mapDefined(rest, ROOT_DATE_FIELDS, toIso),
    commitBreakdown: (rest.commitBreakdown ?? []).map((commit) => ({
      ...commit,
      ...mapDefined(commit, ['committedAt'], toIso)
    }))
  }
}

/**
 * Persists a validated payload. Every message is appended — history per PR is
 * kept rather than overwritten, so trends can be replayed.
 *
 * `sourceBranch` is populated while a PR is open but omitted on the final
 * merged/closed message; when it is missing it is backfilled from the most
 * recent stored message for the same PR so the record stays complete.
 */
export async function savePayload(db, payload, logger) {
  let record = payload

  if (!payload.sourceBranch) {
    const previous = await findLatestPayloadForPr(
      db,
      payload.repository,
      payload.prNumber
    )

    if (previous?.sourceBranch) {
      record = { ...payload, sourceBranch: previous.sourceBranch }
      logger?.info(
        `sourceBranch omitted for ${payload.repository}#${payload.prNumber}; backfilled '${previous.sourceBranch}' from the previous message`
      )
    } else {
      logger?.warn(
        `sourceBranch omitted for ${payload.repository}#${payload.prNumber} and no previous message was found`
      )
    }
  }

  await db
    .collection(PAYLOADS_COLLECTION)
    .insertOne({ ...toDocument(record), receivedAt: new Date() })

  return record
}

/**
 * The latest payload for every unique (repository, prNumber) pair — what the
 * dashboard renders.
 */
export async function findLatestPayloads(db) {
  const docs = await db
    .collection(PAYLOADS_COLLECTION)
    .aggregate([
      { $sort: { repository: 1, prNumber: 1, calculatedAt: -1 } },
      {
        $group: {
          _id: { repository: '$repository', prNumber: '$prNumber' },
          doc: { $first: '$$ROOT' }
        }
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { calculatedAt: -1 } }
    ])
    .toArray()

  return docs.map(toPayload)
}

/** Every stored payload for one PR, newest first. */
export async function findPayloadHistory(db, repository, prNumber) {
  const docs = await db
    .collection(PAYLOADS_COLLECTION)
    .find({ repository, prNumber })
    .sort({ calculatedAt: -1 })
    .toArray()

  return docs.map(toPayload)
}

/** The most recent stored payload for one PR, or null when never seen. */
export async function findLatestPayloadForPr(db, repository, prNumber) {
  const doc = await db
    .collection(PAYLOADS_COLLECTION)
    .findOne({ repository, prNumber }, { sort: { calculatedAt: -1 } })

  return doc ? toPayload(doc) : null
}
