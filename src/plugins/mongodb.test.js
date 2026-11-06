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
      expect(server.db.databaseName).toBe('mmo-cr-copilot-backend-test')
    })

    test('MongoDb should have expected namespace', () => {
      expect(server.db.namespace).toBe('mmo-cr-copilot-backend-test')
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

  describe('Repository SonarCloud key index', () => {
    let db
    let migrations
    const repositories = () => db.collection('repositories')
    // Seeding duplicates needs the index gone; it may already be missing.
    const dropSonarIndex = () =>
      repositories()
        .dropIndex('sonarProjectKey_unique')
        .catch(() => {})

    beforeAll(async () => {
      const { createServer } = await import('#/server.js')
      migrations = await import('./mongodb.js')

      server = await createServer()
      await server.initialize()
      db = server.db
    })

    beforeEach(async () => {
      await repositories().deleteMany({})
    })

    afterAll(async () => {
      await repositories().deleteMany({})
      await migrations.createSonarKeyIndex(db)
      await server.stop({ timeout: 1000 })
    })

    test('Should reject a second repository with the same key', async () => {
      await repositories().insertOne({
        fullName: 'DEFRA/a',
        sonarProjectKey: 'K'
      })

      await expect(
        repositories().insertOne({ fullName: 'DEFRA/b', sonarProjectKey: 'K' })
      ).rejects.toThrow(/duplicate key/i)
    })

    test('Should allow any number of repositories with no key', async () => {
      await repositories().insertMany([
        { fullName: 'DEFRA/a' },
        { fullName: 'DEFRA/b', sonarProjectKey: null },
        { fullName: 'DEFRA/c', sonarProjectKey: null },
        { fullName: 'DEFRA/d', sonarProjectKey: '' },
        { fullName: 'DEFRA/e', sonarProjectKey: '' }
      ])

      await expect(repositories().countDocuments()).resolves.toBe(5)
    })

    test('Should warn and carry on when existing keys are duplicated', async () => {
      await dropSonarIndex()
      await repositories().insertMany([
        { fullName: 'DEFRA/a', sonarProjectKey: 'SECRET_DUP' },
        { fullName: 'DEFRA/b', sonarProjectKey: 'SECRET_DUP' }
      ])
      const logger = { warn: vi.fn() }

      await expect(
        migrations.createSonarKeyIndex(db, logger)
      ).resolves.toBeUndefined()

      expect(logger.warn).toHaveBeenCalledWith(
        { error: { code: 11000 } },
        'Could not create unique index on repository SonarCloud keys; resolve duplicate keys'
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET_DUP')
      const names = (await repositories().indexes()).map((index) => index.name)
      expect(names).not.toContain('sonarProjectKey_unique')
    })

    test('Should still start the server when existing keys are duplicated', async () => {
      await dropSonarIndex()
      await repositories().insertMany([
        { fullName: 'DEFRA/a', sonarProjectKey: 'DUP' },
        { fullName: 'DEFRA/b', sonarProjectKey: 'DUP' }
      ])
      const { createServer } = await import('#/server.js')
      const second = await createServer()

      await expect(second.initialize()).resolves.toBeUndefined()
      await second.stop({ timeout: 1000 })
    })

    test('Should rethrow any other index failure', async () => {
      const failing = {
        collection: () => ({
          createIndex: () => Promise.reject(new Error('not primary'))
        })
      }

      await expect(migrations.createSonarKeyIndex(failing)).rejects.toThrow(
        'not primary'
      )
    })
  })

  describe('Role mapping and project migrations', () => {
    let db
    let migrations

    beforeAll(async () => {
      const { createServer } = await import('#/server.js')
      migrations = await import('./mongodb.js')

      server = await createServer()
      await server.initialize()
      db = server.db
    })

    afterAll(async () => {
      await db.collection('role_mappings').deleteMany({})
      await db.collection('projects').deleteMany({})
      await server.stop({ timeout: 1000 })
    })

    test('Should seed the bootstrap Dashboard Admin mapping on a fresh database', async () => {
      const admin = await db
        .collection('role_mappings')
        .findOne({ role: 'Dashboard.Admin' })

      expect(admin.groupName).toBe('AG-Users-CopilotAnalytics-Dashboard-Admin')
    })

    test('Should enforce a unique group and scope', async () => {
      const mapping = {
        groupName: 'AG-Unique',
        role: 'project-user',
        scope: 'project',
        projectSlug: 'ALPH'
      }
      await db.collection('role_mappings').insertOne({ ...mapping })

      await expect(
        db.collection('role_mappings').insertOne({ ...mapping })
      ).rejects.toThrow(/duplicate key/i)
    })

    test('Should rename groupId to groupName and drop the old index, idempotently', async () => {
      const collection = db.collection('role_mappings')
      await collection.drop()
      await collection.createIndex(
        { groupId: 1, projectSlug: 1 },
        { unique: true }
      )
      await collection.insertOne({
        groupId: 'AG-Legacy',
        role: 'project-user',
        scope: 'project',
        projectSlug: 'ALPH'
      })

      await migrations.migrateRoleMappingKey(db)
      await migrations.migrateRoleMappingKey(db)

      const migrated = await collection.findOne({ groupName: 'AG-Legacy' })
      expect(migrated).not.toHaveProperty('groupId')
      const indexes = (await collection.indexes()).map((index) => index.name)
      expect(indexes).not.toContain('groupId_1_projectSlug_1')
    })

    test('Should remove the retired group arrays from projects, idempotently', async () => {
      await db.collection('projects').insertOne({
        slug: 'ALPH',
        name: 'Alpha',
        adminGroupIds: ['a'],
        entraGroupIds: ['b']
      })

      await migrations.removeProjectGroupFields(db)
      await migrations.removeProjectGroupFields(db)

      const project = await db.collection('projects').findOne({ slug: 'ALPH' })
      expect(project).not.toHaveProperty('adminGroupIds')
      expect(project).not.toHaveProperty('entraGroupIds')
    })

    test('Should create the default project as CRAR on an empty database', async () => {
      await db.collection('projects').deleteMany({})

      await migrations.migrateDefaultProject(db)

      const projects = await db.collection('projects').find().toArray()
      expect(projects.map((p) => p.slug)).toEqual(['CRAR'])
    })
  })
})
