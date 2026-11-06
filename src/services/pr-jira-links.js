export const PR_JIRA_LINKS_COLLECTION = 'pr-jira-links'

// Associates pull request with one or more Jira issue keys in many-to-many store.
export async function linkPrsToJiraIssues(
  db,
  { projectSlug, repository, prNumber, jiraKeys }
) {
  if (!db || !repository || !prNumber || !jiraKeys) {
    return []
  }

  const keys = Array.isArray(jiraKeys) ? jiraKeys : [jiraKeys]
  const prNum = Number(prNumber)
  const now = new Date()

  const operations = keys.map((jiraKey) => ({
    updateOne: {
      filter: { projectSlug, jiraKey, repository, prNumber: prNum },
      update: {
        $set: {
          projectSlug,
          jiraKey,
          repository,
          prNumber: prNum,
          linkedAt: now
        }
      },
      upsert: true
    }
  }))

  if (operations.length > 0) {
    await db.collection(PR_JIRA_LINKS_COLLECTION).bulkWrite(operations)
  }
  return keys
}

/** Jira keys linked to one pull request, with where each link came from. */
export async function findPrLinks(db, { projectSlug, repository, prNumber }) {
  const docs = await db
    .collection(PR_JIRA_LINKS_COLLECTION)
    .find({ projectSlug, repository, prNumber: Number(prNumber) })
    .sort({ jiraKey: 1 })
    .toArray()
  return docs.map((d) => ({
    jiraKey: d.jiraKey,
    source: d.source ?? 'payload'
  }))
}

/**
 * Replaces the admin-maintained links of one pull request with `jiraKeys`.
 * Links found in the payload itself are left alone. Returns the manual keys
 * before and after, for the audit trail.
 */
export async function setManualPrLinks(
  db,
  { projectSlug, repository, prNumber, jiraKeys }
) {
  const collection = db.collection(PR_JIRA_LINKS_COLLECTION)
  const prNum = Number(prNumber)
  const scope = { projectSlug, repository, prNumber: prNum }
  const before = (
    await collection.find({ ...scope, source: 'manual' }).toArray()
  )
    .map((d) => d.jiraKey)
    .sort()
  const after = [...new Set(jiraKeys)].sort()

  await collection.deleteMany({
    ...scope,
    source: 'manual',
    jiraKey: { $nin: after }
  })
  if (after.length > 0) {
    const now = new Date()
    await collection.bulkWrite(
      after.map((jiraKey) => ({
        updateOne: {
          filter: { ...scope, jiraKey },
          update: {
            $set: { ...scope, jiraKey, linkedAt: now },
            $setOnInsert: { source: 'manual' }
          },
          upsert: true
        }
      }))
    )
  }
  return { before, after }
}
