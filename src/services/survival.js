export const SURVIVAL_COLLECTION = 'ai_survival'

// Mongo's duplicate-key error, raised when a concurrent writer inserted the
// record for this pull request and window first.
const DUPLICATE_KEY_ERROR = 11000

export const SURVIVAL_STATUS = {
  created: 'created',
  updated: 'updated',
  stale: 'stale'
}

const DATE_FIELDS = ['mergedAt', 'measuredAt', 'calculatedAt']

function toDocument(record, projectSlug) {
  const document = { ...record, projectSlug, receivedAt: new Date() }
  for (const field of DATE_FIELDS) document[field] = new Date(record[field])
  return document
}

/**
 * Idempotent upsert by (repository, prNumber, windowDays). A record only replaces
 * the stored one when its measuredAt is strictly newer, so retries and
 * out-of-order deliveries converge on the latest measurement.
 * @returns {Promise<{ status: string, projectSlug: string | null }>}
 */
export async function saveSurvival(db, record) {
  const collection = db.collection(SURVIVAL_COLLECTION)
  const repo = await db
    .collection('repositories')
    .findOne({ fullName: record.repository })
  const projectSlug = repo?.projectSlug || null

  const document = toDocument(record, projectSlug)
  const filter = {
    repository: record.repository,
    prNumber: record.prNumber,
    windowDays: record.windowDays
  }

  // At most two passes: an insert that loses a race falls through to the
  // conditional update against the winner.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { matchedCount } = await collection.updateOne(
      { ...filter, measuredAt: { $lt: document.measuredAt } },
      { $set: document }
    )
    if (matchedCount > 0) {
      return { status: SURVIVAL_STATUS.updated, projectSlug }
    }

    try {
      await collection.insertOne(document)
      return { status: SURVIVAL_STATUS.created, projectSlug }
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY_ERROR) throw error
    }
  }

  return { status: SURVIVAL_STATUS.stale, projectSlug }
}

/**
 * Survival records for a project's pull requests merged in [from, to).
 */
export async function listSurvival(db, { projectSlug, windowDays, from, to }) {
  const filter = { projectSlug, windowDays }
  if (from || to) {
    filter.mergedAt = {
      ...(from ? { $gte: new Date(from) } : {}),
      ...(to ? { $lt: new Date(to) } : {})
    }
  }
  return db.collection(SURVIVAL_COLLECTION).find(filter).toArray()
}
