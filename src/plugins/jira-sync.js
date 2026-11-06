import { config } from '#/config.js'
import { acquireLock } from '#/common/helpers/mongo-lock.js'
import { JIRA_ISSUES_COLLECTION, createJiraClient } from '#/services/jira.js'
import { syncOneProject } from '#/services/jira-project-sync.js'
import { PROJECTS_COLLECTION } from '#/services/projects.js'

const LOCK_RESOURCE = 'jira-sync'

/**
 * One incremental sync of every active project with Jira keys. A Mongo lock
 * keeps two instances from syncing at once; `lastSyncedAt` is only moved on
 * after a project's sync succeeds.
 */
export async function runJiraSync({ db, locker, client, logger }) {
  const lock = await acquireLock(locker, LOCK_RESOURCE)
  if (!lock) {
    logger.info('Jira sync skipped: another instance holds the lock')
    return { skipped: true }
  }

  try {
    const projects = await db
      .collection(PROJECTS_COLLECTION)
      .find({
        archivedAt: null,
        'jira.projectKeys.0': { $exists: true }
      })
      .toArray()

    let synced = 0
    for (const project of projects) {
      try {
        const result = await syncOneProject({ db, client, project, logger })
        synced += result?.synced ?? 0
      } catch (err) {
        logger.error({ err }, `Jira sync failed for project ${project.slug}`)
      }
    }
    return { synced, projects: projects.length }
  } finally {
    await lock.free()
  }
}

/** Fetches Jira issues for keys seen in a payload that are not stored yet. */
export async function fetchUnknownJiraIssues({
  db,
  client,
  projectSlug,
  jiraKeys,
  logger
}) {
  if (!projectSlug || !client.isConfigured() || !jiraKeys?.length) return
  const known = await db
    .collection(JIRA_ISSUES_COLLECTION)
    .distinct('key', { key: { $in: jiraKeys } })
  const unknown = jiraKeys.filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  try {
    await client.syncIssuesByKey(db, projectSlug, unknown)
  } catch (err) {
    logger.warn({ err }, 'Could not fetch Jira issues first seen at ingest')
  }
}

export const jiraSync = {
  plugin: {
    name: 'jira-sync',
    version: '1.0.0',
    dependencies: ['mongodb'],
    register(server) {
      const client = createJiraClient({ logger: server.logger })
      const minutes = config.get('jira.syncIntervalMinutes')
      server.decorate('server', 'jira', client)

      if (!client.isConfigured() || minutes <= 0) {
        server.logger.info('Scheduled Jira sync is off')
        return
      }

      let timer = null
      server.events.on('start', () => {
        timer = setInterval(
          () => {
            runJiraSync({
              db: server.db,
              locker: server.locker,
              client,
              logger: server.logger
            }).catch((err) => server.logger.error({ err }, 'Jira sync failed'))
          },
          minutes * 60 * 1000
        )
      })
      server.events.on('stop', () => {
        clearInterval(timer)
        timer = null
      })
    }
  }
}
