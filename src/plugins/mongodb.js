import { MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

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

      await createIndexes(db)

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

async function createIndexes(db) {
  await db.collection('mongo-locks').createIndex({ id: 1 })

  // Serves both the per-PR history query and the "latest per repo+PR" rollup.
  await db
    .collection(PAYLOADS_COLLECTION)
    .createIndex({ repository: 1, prNumber: 1, calculatedAt: -1 })
  // Time-based queries on when payloads arrived.
  await db.collection(PAYLOADS_COLLECTION).createIndex({ receivedAt: -1 })
  // _id is already the lower-cased handle; this supports lookups by display casing.
  await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .createIndex({ githubHandle: 1 })
}
