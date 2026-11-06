import { detectProjectStatuses } from '#/services/jira-workflow.js'
import { PROJECTS_COLLECTION } from '#/services/projects.js'

const SPRINT_SCOPE_COLLECTION = 'jira-sprint-scope'
const DUPLICATE_KEY_ERROR = 11000
// Jira compares `updated` at minute precision in the user's time zone, so each run overlaps the last.
const OVERLAP_MS = 15 * 60 * 1000

/**
 * Records the issues in each active sprint the first time it is seen, so
 * sprint predictability compares delivery against the scope committed at start.
 */
export async function captureSprintScope({ db, client, project }) {
  const sprints = await client.getBoardSprints(project.jira.boardId)
  const scope = db.collection(SPRINT_SCOPE_COLLECTION)
  for (const sprint of sprints) {
    if (sprint.state !== 'active' || !Number.isInteger(sprint.id)) continue
    if (await scope.findOne({ sprintId: sprint.id })) continue

    const issueKeys = []
    let nextPageToken
    do {
      const page = await client.searchIssues(`sprint = ${sprint.id}`, {
        fields: ['key'],
        expand: '',
        nextPageToken
      })
      issueKeys.push(...(page.issues ?? []).map((issue) => issue.key))
      nextPageToken = page.isLast === false ? page.nextPageToken : undefined
    } while (nextPageToken)

    try {
      await scope.insertOne({
        sprintId: sprint.id,
        projectSlug: project.slug,
        name: sprint.name,
        startDate: sprint.startDate ? new Date(sprint.startDate) : null,
        endDate: sprint.endDate ? new Date(sprint.endDate) : null,
        issueKeys,
        capturedAt: new Date()
      })
    } catch (err) {
      if (err?.code !== DUPLICATE_KEY_ERROR) throw err
    }
  }
}

/**
 * Syncs one project's issues, sprint scope and detected statuses, then moves
 * `lastSyncedAt` on. Incremental from the last sync unless `full` is set.
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
  const lastSyncedAt = full ? null : jira.lastSyncedAt
  const result = await client.syncProjectIssues(
    db,
    project.slug,
    jira.projectKeys,
    jira.storyPointsField,
    lastSyncedAt
      ? {
          updatedSince: new Date(new Date(lastSyncedAt).getTime() - OVERLAP_MS)
        }
      : {}
  )
  if (result?.configured === false || !jira.projectKeys?.length) return result

  if (jira.boardId) await captureSprintScope({ db, client, project })
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
