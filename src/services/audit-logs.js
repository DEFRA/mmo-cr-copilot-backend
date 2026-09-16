import { audit } from '@defra/cdp-auditing'

export const AUDIT_LOGS_COLLECTION = 'audit-logs'

/**
 * Identity recorded against every entry. The dashboard is currently
 * unauthenticated, so there is no signed-in user to attribute a change to —
 * recording a fixed, server-side value keeps the field honest instead of
 * trusting a name supplied by the browser. Replace with the authenticated
 * principal once the dashboard has one.
 */
const SYSTEM_ACTOR = 'dashboard'

function toEntry(doc) {
  const { _id, occurredAt, ...rest } = doc

  return {
    id: _id.toString(),
    occurredAt: occurredAt.toISOString(),
    ...rest
  }
}

/**
 * Appends one immutable record of an operator-initiated change.
 *
 * Written to MongoDB so the dashboard can page through it, and emitted to the
 * platform SOC audit stream so the trail survives independently of this
 * service's database.
 *
 * Auditing must never take a request down with it: a failure here is logged
 * and swallowed, because losing the change itself is worse than losing its
 * audit entry, and the SOC stream still has the event.
 */
export async function recordAuditEvent(
  db,
  { action, entity, entityId, summary, before = null, after = null },
  logger
) {
  const event = {
    action,
    entity,
    entityId,
    summary,
    before,
    after,
    actor: SYSTEM_ACTOR,
    occurredAt: new Date()
  }

  audit(event)

  try {
    await db.collection(AUDIT_LOGS_COLLECTION).insertOne(event)
  } catch (error) {
    logger?.error(error, `Failed to persist audit entry for ${action}`)
  }
}

/**
 * One page of the audit trail, newest first, optionally narrowed to the
 * half-open window `[from, to)`.
 */
export async function findAuditLogs(
  db,
  { from, to, page = 1, pageSize = 25 } = {}
) {
  const occurredAt = {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lt: to } : {})
  }
  const filter = Object.keys(occurredAt).length > 0 ? { occurredAt } : {}

  const collection = db.collection(AUDIT_LOGS_COLLECTION)
  const total = await collection.countDocuments(filter)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // Clamp rather than return an empty page: a shrinking trail (or a stale
  // browser tab) would otherwise leave the table stuck on nothing.
  const currentPage = Math.min(page, totalPages)

  const docs = await collection
    .find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .skip((currentPage - 1) * pageSize)
    .limit(pageSize)
    .toArray()

  return {
    entries: docs.map(toEntry),
    page: currentPage,
    pageSize,
    total,
    totalPages
  }
}
