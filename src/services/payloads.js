import { COUNTED_CLASSIFICATIONS } from '#/schemas/payload.js'

export const PAYLOADS_COLLECTION = 'payloads'

// Mongo's duplicate-key error, raised when a concurrent writer inserted the
// record for this pull request first.
const DUPLICATE_KEY_ERROR = 11000

/** Outcomes of a manual classification change, mapped to HTTP by the route. */
export const CLASSIFICATION_UPDATE = {
  updated: 'updated',
  unchanged: 'unchanged',
  prNotFound: 'pr-not-found',
  commitNotFound: 'commit-not-found',
  prNotMerged: 'pr-not-merged'
}

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
  const {
    _id: _ignoredId,
    receivedAt: _ignoredReceivedAt,
    classificationOverrides: _ignoredOverrides,
    ...rest
  } = doc

  return {
    ...rest,
    ...mapDefined(rest, ROOT_DATE_FIELDS, toIso),
    commitBreakdown: (rest.commitBreakdown ?? []).map((commit) => ({
      ...commit,
      ...mapDefined(commit, ['committedAt'], toIso)
    }))
  }
}

const isCounted = (commit) =>
  COUNTED_CLASSIFICATIONS.includes(commit.classification)

// One decimal place, matching what the analytics producer emits.
function rate(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

function sumBy(commits, field) {
  return commits.reduce((total, commit) => total + (commit[field] ?? 0), 0)
}

/**
 * Rebuilds `summary` and `contributorBreakdown` from `commitBreakdown`.
 *
 * Needed whenever a classification is changed by hand: the producer's own
 * totals were computed before the correction, so leaving them in place would
 * put the stored document at odds with the commits it contains. Mirrors the
 * producer — `Rebase` and `Dependabot` commits are reported as set aside and
 * excluded from every total.
 */
export function recomputeTotals(commitBreakdown) {
  const counted = commitBreakdown.filter(isCounted)
  const copilot = counted.filter((c) => c.classification === 'Copilot-assisted')
  const human = counted.filter((c) => c.classification === 'Human-authored')
  const excluded = commitBreakdown.filter((c) => !isCounted(c))

  const totalCommits = counted.length
  const totalLinesTouched = sumBy(counted, 'linesTouched')
  const copilotAssistedLines = sumBy(copilot, 'linesTouched')

  const byContributor = new Map()
  for (const commit of counted) {
    const contributor = commit.author
    const entry = byContributor.get(contributor) ?? {
      contributor,
      totalCommits: 0,
      copilotAssisted: 0,
      humanAuthored: 0,
      linesAdded: 0,
      linesDeleted: 0,
      linesTouched: 0,
      netLines: 0,
      copilotAssistedLines: 0,
      humanAuthoredLines: 0
    }

    const isCopilot = commit.classification === 'Copilot-assisted'
    entry.totalCommits += 1
    entry[isCopilot ? 'copilotAssisted' : 'humanAuthored'] += 1
    entry.linesAdded += commit.linesAdded ?? 0
    entry.linesDeleted += commit.linesDeleted ?? 0
    entry.linesTouched += commit.linesTouched ?? 0
    entry.netLines += commit.netLines ?? 0
    entry[isCopilot ? 'copilotAssistedLines' : 'humanAuthoredLines'] +=
      commit.linesTouched ?? 0

    byContributor.set(contributor, entry)
  }

  return {
    summary: {
      totalCommits,
      copilotAssistedCommits: copilot.length,
      humanAuthoredCommits: human.length,
      copilotAssistedRate: rate(copilot.length, totalCommits),
      totalLinesTouched,
      copilotAssistedLines,
      humanAuthoredLines: sumBy(human, 'linesTouched'),
      copilotAssistedLineRate: rate(copilotAssistedLines, totalLinesTouched),
      excludedCommits: excluded.length,
      rebaseCommits: excluded.filter((c) => c.classification === 'Rebase')
        .length,
      dependabotCommits: excluded.filter(
        (c) => c.classification === 'Dependabot'
      ).length
    },
    contributorBreakdown: [...byContributor.values()]
  }
}

/**
 * Re-applies manual classification corrections to a freshly ingested payload.
 *
 * A correction is a deliberate operator decision recorded in the audit trail;
 * a later run of the producer would otherwise silently revert it, since the
 * producer has no knowledge that the commit was re-classified by hand.
 */
function applyClassificationOverrides(payload, overrides, logger) {
  if (overrides.length === 0) {
    return payload
  }

  const byCommit = new Map(overrides.map((o) => [o.commit, o.classification]))
  let applied = 0

  const commitBreakdown = payload.commitBreakdown.map((commit) => {
    const classification = byCommit.get(commit.commit)

    if (!classification || classification === commit.classification) {
      return commit
    }

    applied += 1
    return { ...commit, classification }
  })

  if (applied === 0) {
    return payload
  }

  logger?.info(
    `Re-applied ${applied} manual commit classification(s) to ${payload.repository}#${payload.prNumber}`
  )

  return {
    ...payload,
    commitBreakdown,
    ...recomputeTotals(commitBreakdown)
  }
}

/**
 * Persists a validated payload as the single record for its pull request.
 *
 * One document is kept per (repository, prNumber). It is replaced only when
 * the incoming `calculatedAt` is strictly newer, which makes delivery both
 * idempotent — a retried POST converges on the same state rather than
 * appending a duplicate — and order-independent, so a slow pre-merge run
 * finishing late cannot overwrite the merged snapshot.
 *
 * `sourceBranch` is populated while a PR is open but may be omitted on the
 * final merged message; when it is missing it is backfilled from the stored
 * record so the document stays complete. Manual classification corrections
 * recorded against the stored record are carried forward for the same reason.
 */
export async function savePayload(db, payload, logger) {
  const collection = db.collection(PAYLOADS_COLLECTION)
  const previous = await collection.findOne(
    { repository: payload.repository, prNumber: payload.prNumber },
    { sort: { calculatedAt: -1 } }
  )

  let record = payload

  if (!payload.sourceBranch) {
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

  const classificationOverrides = previous?.classificationOverrides ?? []
  record = applyClassificationOverrides(record, classificationOverrides, logger)

  const filter = { repository: record.repository, prNumber: record.prNumber }
  const document = {
    ...toDocument(record),
    classificationOverrides,
    receivedAt: new Date()
  }

  // At most two passes: if the insert loses a race to a concurrent writer,
  // the second pass takes the conditional-update path against the winner.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { matchedCount } = await collection.updateOne(
      { ...filter, calculatedAt: { $lt: document.calculatedAt } },
      { $set: document, $inc: { updateCount: 1 } }
    )

    if (matchedCount > 0) {
      return { record, stored: true }
    }

    try {
      await collection.insertOne({ ...document, updateCount: 1 })
      return { record, stored: true }
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY_ERROR) {
        throw error
      }
    }
  }

  logger?.info(
    `Ignored a stale analytics payload for ${record.repository}#${record.prNumber}; the stored record is already at or ahead of ${record.calculatedAt}`
  )

  return { record, stored: false }
}

/**
 * Every stored payload, newest first — what the dashboard renders. One
 * document is kept per (repository, prNumber), so this needs no rollup.
 */
export async function findLatestPayloads(db) {
  const docs = await db
    .collection(PAYLOADS_COLLECTION)
    .find({})
    .sort({ calculatedAt: -1 })
    .toArray()

  return docs.map(toPayload)
}

/**
 * The stored payload for one PR. Returns an array because the endpoint
 * predates single-record storage and callers still expect a collection.
 */
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

/**
 * Re-classifies a single commit by hand and rebuilds the pull request's
 * totals around it.
 *
 * Only merged pull requests may be corrected. An open PR is still being
 * re-analysed on every push, so an edit there would be overwritten within
 * minutes and would describe a commit set that is still changing; once merged
 * the commit list is final and a correction is meaningful. The change is also
 * kept in `classificationOverrides` so a late-arriving producer message
 * cannot silently revert it.
 */
export async function updateCommitClassification(
  db,
  { repository, prNumber, commit, classification }
) {
  const collection = db.collection(PAYLOADS_COLLECTION)
  const doc = await collection.findOne({ repository, prNumber })

  if (!doc) {
    return { status: CLASSIFICATION_UPDATE.prNotFound }
  }

  if (!doc.prMergedAt) {
    return { status: CLASSIFICATION_UPDATE.prNotMerged }
  }

  const commits = doc.commitBreakdown ?? []
  const index = commits.findIndex((entry) => entry.commit === commit)

  if (index === -1) {
    return { status: CLASSIFICATION_UPDATE.commitNotFound }
  }

  const previousClassification = commits[index].classification

  if (previousClassification === classification) {
    return {
      status: CLASSIFICATION_UPDATE.unchanged,
      previousClassification,
      payload: toPayload(doc)
    }
  }

  const commitBreakdown = commits.map((entry, position) =>
    position === index ? { ...entry, classification } : entry
  )
  const totals = recomputeTotals(commitBreakdown)
  const classificationOverrides = [
    ...(doc.classificationOverrides ?? []).filter((o) => o.commit !== commit),
    { commit, classification, updatedAt: new Date() }
  ]

  await collection.updateOne(
    { _id: doc._id },
    { $set: { commitBreakdown, ...totals, classificationOverrides } }
  )

  return {
    status: CLASSIFICATION_UPDATE.updated,
    previousClassification,
    payload: toPayload({ ...doc, commitBreakdown, ...totals })
  }
}
