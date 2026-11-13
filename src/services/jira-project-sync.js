import { MINUTE_MS } from '#/common/helpers/time.js'
import { JIRA_ISSUES_COLLECTION } from '#/services/jira.js'
import { captureSprintScope } from '#/services/jira-lazy-fetch.js'
import { detectProjectStatuses } from '#/services/jira-workflow.js'
import { PROJECTS_COLLECTION } from '#/services/projects.js'

const OVERLAP_MINUTES = 15
// Jira compares `updated` at minute precision in the user's time zone, so each run overlaps the last.
const OVERLAP_MS = OVERLAP_MINUTES * MINUTE_MS

export { captureSprintScope }

// The incremental sync start, or null for a full sync.
async function syncStart(db, project, full) {
  const lastSyncedAt = project.jira?.lastSyncedAt
  if (full || !lastSyncedAt) {
    return null
  }
  const hasIssues = await db
    .collection(JIRA_ISSUES_COLLECTION)
    .findOne({ projectSlug: project.slug }, { projection: { _id: 1 } })
  return hasIssues
    ? new Date(new Date(lastSyncedAt).getTime() - OVERLAP_MS)
    : null
}

/**
 * Syncs one project's issues, sprint scope and detected statuses, then moves
 * `lastSyncedAt` on. Incremental from the last sync unless `full` is set or
 * nothing is stored for the project yet.
 */
export async function syncOneProject({
  db,
  client,
  project,
  logger,
  full = false
}) {
  const startedAt = new Date()
  const jira = project.jira ?? {}
  const updatedSince = await syncStart(db, project, full)
  const result = await client.syncProjectIssues(
    db,
    project.slug,
    jira.projectKeys,
    jira.storyPointsField,
    updatedSince ? { updatedSince } : {}
  )
  if (result?.configured === false || !jira.projectKeys?.length) {
    return result
  }

  if (jira.boardId) {
    await captureSprintScope({ db, client, project })
  }
  // A failed or empty status fetch keeps the previously detected statuses.
  const detected = await detectProjectStatuses(client, project, logger)
  if (detected?.length === 0) {
    logger.warn(`Jira returned no statuses for project ${project.slug}`)
  }
  await db.collection(PROJECTS_COLLECTION).updateOne(
    { slug: project.slug },
    {
      $set: {
        'jira.lastSyncedAt': startedAt,
        ...(detected?.length ? { 'jira.detectedStatuses': detected } : {})
      }
    }
  )
  return result
}
