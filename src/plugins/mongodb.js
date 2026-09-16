import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

import { AUDIT_LOGS_COLLECTION } from '#/services/audit-logs.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { PERSONA_MAPPINGS_COLLECTION } from '#/services/persona-mappings.js'

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
}
