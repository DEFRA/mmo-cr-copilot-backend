import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

import { config } from '#/config.js'
import { AUDIT_LOGS_COLLECTION } from '#/services/audit-logs.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { PERSONA_MAPPINGS_COLLECTION } from '#/services/persona-mappings.js'
import {
  ROLE_MAPPINGS_COLLECTION,
  ensureBootstrapAdmin
} from '#/services/role-mappings.js'
import { SURVIVAL_COLLECTION } from '#/services/survival.js'
import { renameDefaultProjectSlug } from '#/plugins/rename-default-project-slug.js'

const DEFAULT_PROJECT_SLUG = 'CRAR'

export const mongoDb = {
  plugin: {
    name: 'mongodb',
    version: '1.0.0',
    register: async function (server, options) {
      server.logger.info('Setting up MongoDb')

      const client = await MongoClient.connect(options.mongoUrl, {
        ...options.mongoOptions
      })

      const databaseName = options.databaseName
      const db = client.db(databaseName)
      const locker = new LockManager(db.collection('mongo-locks'))

      await createIndexes(db, server.logger)

      server.logger.info(`MongoDb connected to ${databaseName}`)

      server.decorate('server', 'mongoClient', client)
      server.decorate('server', 'db', db)
      server.decorate('server', 'locker', locker)
      server.decorate('request', 'db', () => db, { apply: true })
      server.decorate('request', 'locker', () => locker, { apply: true })

      server.events.on('stop', async () => {
        server.logger.info('Closing Mongo client')
        try {
          await client.close(true)
        } catch (e) {
          server.logger.error(e, 'failed to close mongo client')
        }
      })
    }
  }
}

/**
 * Collapses any append-only history left by the previous storage strategy to
 * the newest record per pull request.
 *
 * Storage now keeps a single document per (repository, prNumber), enforced by
 * a unique index. That index cannot be built while superseded duplicates are
 * still present, and index creation is awaited during start-up, so without
 * this the service would fail to boot against an existing database. It is a
 * no-op once the data is already collapsed.
 */
async function collapsePayloadHistory(db, logger) {
  const collection = db.collection(PAYLOADS_COLLECTION)

  const duplicated = await collection
    .aggregate([
      { $sort: { repository: 1, prNumber: 1, calculatedAt: -1 } },
      {
        $group: {
          _id: { repository: '$repository', prNumber: '$prNumber' },
          ids: { $push: '$_id' }
        }
      },
      { $match: { 'ids.1': { $exists: true } } }
    ])
    .toArray()

  // Newest first, so everything after the first entry is superseded.
  const superseded = duplicated.flatMap((group) => group.ids.slice(1))

  if (superseded.length > 0) {
    await collection.deleteMany({ _id: { $in: superseded } })
    logger?.info(
      `Collapsed analytics history: removed ${superseded.length} superseded record(s) across ${duplicated.length} pull request(s)`
    )
  }
}

async function createIndexes(db, logger) {
  await db.collection('mongo-locks').createIndex({ id: 1 })

  await collapsePayloadHistory(db, logger)

  // One record per pull request. The unique constraint is what makes ingest
  // idempotent: a retried delivery cannot append a second copy.
  await db
    .collection(PAYLOADS_COLLECTION)
    .createIndex({ repository: 1, prNumber: 1 }, { unique: true })
  // Serves the newest-first ordering the dashboard rollup uses.
  await db.collection(PAYLOADS_COLLECTION).createIndex({ calculatedAt: -1 })
  // Time-based queries on when payloads arrived.
  await db.collection(PAYLOADS_COLLECTION).createIndex({ receivedAt: -1 })
  // _id is already the lower-cased handle; this supports lookups by display casing.
  await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .createIndex({ githubHandle: 1 })
  // Serves the audit trail's newest-first ordering and its date-range filter.
  await db.collection(AUDIT_LOGS_COLLECTION).createIndex({ occurredAt: -1 })
  await db
    .collection(AUDIT_LOGS_COLLECTION)
    .createIndex({ projectSlug: 1, occurredAt: -1 })

  await migrateRoleMappingKey(db, logger)
  // Group names are matched exactly as the token emits them (case-sensitive).
  await db
    .collection(ROLE_MAPPINGS_COLLECTION)
    .createIndex({ groupName: 1, projectSlug: 1 }, { unique: true })
  await db.collection(ROLE_MAPPINGS_COLLECTION).createIndex({ role: 1 })

  await db.collection('projects').createIndex({ slug: 1 }, { unique: true })
  await db
    .collection('repositories')
    .createIndex({ fullName: 1 }, { unique: true })
  await db.collection('repositories').createIndex({ projectSlug: 1 })
  await createSonarKeyIndex(db, logger)
  await db
    .collection(PAYLOADS_COLLECTION)
    .createIndex({ projectSlug: 1, calculatedAt: -1 })

  await db
    .collection('sonar-snapshots')
    .createIndex({ repository: 1, asOf: 1 }, { unique: true })
  await db
    .collection('sonar-pr-snapshots')
    .createIndex({ repository: 1, prNumber: 1 }, { unique: true })

  // One survival record per pull request and window; ingest upserts on this key.
  await db
    .collection(SURVIVAL_COLLECTION)
    .createIndex(
      { repository: 1, prNumber: 1, windowDays: 1 },
      { unique: true }
    )
  // Serves the project churn query: window, project and merge date range.
  await db
    .collection(SURVIVAL_COLLECTION)
    .createIndex({ projectSlug: 1, windowDays: 1, mergedAt: -1 })

  await db.collection('jira-issues').createIndex({ key: 1 }, { unique: true })
  await db
    .collection('jira-sprint-scope')
    .createIndex({ sprintId: 1 }, { unique: true })
  await db
    .collection('jira-issues')
    .createIndex({ projectSlug: 1, resolved: -1 })
  await db
    .collection('pr-jira-links')
    .createIndex(
      { projectSlug: 1, jiraKey: 1, repository: 1, prNumber: 1 },
      { unique: true }
    )

  await migrateDefaultProject(db, logger)
  await renameDefaultProjectSlug(db, logger)
  await removeProjectGroupFields(db, logger)
  await ensureBootstrapAdmin(db, {
    groupName: config.get('auth.bootstrapAdminGroup'),
    logger
  })
}

// One SonarCloud project per repository; unset keys are outside the index. Existing
// duplicates must not stop start-up: the route pre-check still blocks new ones.
export async function createSonarKeyIndex(db, logger) {
  try {
    await db.collection('repositories').createIndex(
      { sonarProjectKey: 1 },
      {
        name: 'sonarProjectKey_unique',
        unique: true,
        partialFilterExpression: {
          sonarProjectKey: { $type: 'string', $gt: '' }
        }
      }
    )
  } catch (error) {
    if (error?.code !== 11000) throw error
    logger?.warn(
      { error: { code: error.code } },
      'Could not create unique index on repository SonarCloud keys; resolve duplicate keys'
    )
  }
}

/**
 * Role mappings were first stored with the group name in `groupId`. Rename it
 * to `groupName` and drop the old unique index before the new one is built;
 * both steps are no-ops on a database that is already migrated.
 */
export async function migrateRoleMappingKey(db, logger) {
  const collection = db.collection(ROLE_MAPPINGS_COLLECTION)
  const { modifiedCount } = await collection.updateMany(
    { groupName: { $exists: false }, groupId: { $exists: true } },
    [{ $set: { groupName: '$groupId' } }, { $unset: 'groupId' }]
  )
  try {
    await collection.dropIndex('groupId_1_projectSlug_1')
  } catch (error) {
    // 27 (IndexNotFound) and 26 (NamespaceNotFound): nothing to drop.
    if (![26, 27].includes(error?.code)) throw error
  }
  if (modifiedCount > 0) {
    logger?.info(
      `Renamed groupId to groupName on ${modifiedCount} role mapping(s)`
    )
  }
}

/** Authorisation lives only in role_mappings; drop the retired project group arrays. */
export async function removeProjectGroupFields(db, logger) {
  const { modifiedCount } = await db.collection('projects').updateMany(
    {
      $or: [
        { adminGroupIds: { $exists: true } },
        { entraGroupIds: { $exists: true } }
      ]
    },
    { $unset: { adminGroupIds: '', entraGroupIds: '' } }
  )
  if (modifiedCount > 0) {
    logger?.info(
      `Removed retired group arrays from ${modifiedCount} project(s)`
    )
  }
}

export async function migrateDefaultProject(db, logger) {
  const projectCount = await db.collection('projects').countDocuments()
  if (projectCount === 0) {
    await db.collection('projects').insertOne({
      slug: DEFAULT_PROJECT_SLUG,
      name: 'MMO Catch Recording',
      type: 'ai-native',
      adoptionStartDate: null,
      sprintCalendar: {
        cadenceDays: 14,
        anchorDate: new Date('2026-07-08T00:00:00.000Z')
      },
      jira: {
        projectKeys: ['MMOCR'],
        storyPointsField: 'customfield_10016'
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      archivedAt: null
    })

    const repos = await db
      .collection(PAYLOADS_COLLECTION)
      .distinct('repository')
    const now = new Date()
    for (const fullName of repos) {
      await db.collection('repositories').updateOne(
        { fullName },
        {
          $set: {
            fullName,
            projectSlug: DEFAULT_PROJECT_SLUG,
            mappedAt: now
          }
        },
        { upsert: true }
      )
    }

    await db
      .collection(PAYLOADS_COLLECTION)
      .updateMany(
        { projectSlug: { $in: [null, undefined] } },
        { $set: { projectSlug: DEFAULT_PROJECT_SLUG } }
      )

    logger?.info('Migrated default project and repository mappings')
  }
}
