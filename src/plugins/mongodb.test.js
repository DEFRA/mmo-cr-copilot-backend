import { Db, MongoClient } from 'mongodb'
import { LockManager } from 'mongo-locks'

import { PAYLOADS_COLLECTION } from '#/services/payloads.js'

describe('#mongoDb', () => {
  let server

  describe('Set up', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Server should have expected MongoDb decorators', () => {
      expect(server.db).toBeInstanceOf(Db)
      expect(server.mongoClient).toBeInstanceOf(MongoClient)
      expect(server.locker).toBeInstanceOf(LockManager)
    })

    test('MongoDb should have expected database name', () => {
      expect(server.db.databaseName).toBe('mmo-cr-copilot-backend')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('mmo-cr-copilot-backend')
    })
  })

  describe('Shut down', () => {
    beforeAll(async () => {
      // Dynamic import needed due to config being updated by vitest-mongodb
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
    })

    test('Should close Mongo client on server stop', async () => {
      const closeSpy = vi.spyOn(server.mongoClient, 'close')
      await server.stop({ timeout: 1000 })

      expect(closeSpy).toHaveBeenCalledWith(true)
    })
  })

  describe('Collapsing pre-existing history', () => {
    let db

    beforeAll(async () => {
      const { createServer } = await import('#/server.js')

      server = await createServer()
      await server.initialize()
      db = server.db

      // Simulate a database written by the previous append-only strategy:
      // drop the unique constraint so duplicates for one PR can be seeded.
      const payloads = db.collection(PAYLOADS_COLLECTION)
      await payloads.deleteMany({})
      await payloads.dropIndex('repository_1_prNumber_1')
      await payloads.insertMany([
        {
          repository: 'DEFRA/repo-a',
          prNumber: 1,
          buildId: 'oldest',
          calculatedAt: new Date('2026-01-14T10:00:00.000Z')
        },
        {
          repository: 'DEFRA/repo-a',
          prNumber: 1,
          buildId: 'newest',
          calculatedAt: new Date('2026-01-16T10:00:00.000Z')
        },
        {
          repository: 'DEFRA/repo-a',
          prNumber: 1,
          buildId: 'middle',
          calculatedAt: new Date('2026-01-15T10:00:00.000Z')
        },
        {
          repository: 'DEFRA/repo-b',
          prNumber: 2,
          buildId: 'only',
          calculatedAt: new Date('2026-01-15T10:00:00.000Z')
        }
      ])

      await server.stop({ timeout: 1000 })

      // Starting again runs the collapse and rebuilds the unique index.
      server = await createServer()
      await server.initialize()
      db = server.db
    })

    afterAll(async () => {
      await db.collection(PAYLOADS_COLLECTION).deleteMany({})
      await server.stop({ timeout: 1000 })
    })

    test('Should keep only the newest record for each pull request', async () => {
      const remaining = await db
        .collection(PAYLOADS_COLLECTION)
        .find({})
        .sort({ repository: 1 })
        .toArray()

      expect(remaining.map((doc) => doc.buildId)).toEqual(['newest', 'only'])
    })

    test('Should rebuild the unique index so duplicates cannot return', async () => {
      await expect(
        db.collection(PAYLOADS_COLLECTION).insertOne({
          repository: 'DEFRA/repo-a',
          prNumber: 1,
          buildId: 'duplicate',
          calculatedAt: new Date('2026-01-17T10:00:00.000Z')
        })
      ).rejects.toThrow(/duplicate key/i)
    })
  })
})
