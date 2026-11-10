import {
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser,
  grantAccess
} from '#/test-helpers/auth-headers.js'
import { PAYLOADS_COLLECTION } from '#/services/payloads.js'
import { PROJECTS_COLLECTION } from '#/services/projects.js'

describe('#projects routes', () => {
  let server
  let db
  let adminHeaders
  let viewerHeaders
  let projectAdminHeaders
  let projectUserHeaders
  let outsiderHeaders

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  beforeAll(async () => {
    ;[adminHeaders, projectAdminHeaders, projectUserHeaders, outsiderHeaders] =
      await Promise.all(
        [ADMIN, PROJECT_ADMIN, PROJECT_USER, OUTSIDER].map(asUser)
      )
    viewerHeaders = outsiderHeaders
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(PROJECTS_COLLECTION).deleteMany({})
    await db.collection(PAYLOADS_COLLECTION).deleteMany({})
    await db.collection('role_mappings').deleteMany({})
    await grantAccess(db)
  })

  describe('Complexity model', () => {
    const model = {
      lineCap: 200,
      fileCap: 20,
      moduleCap: 4,
      weights: { lines: 0.6, files: 0.3, modules: 0.1 },
      hardCapLines: 800,
      hardCapFiles: 60
    }

    beforeEach(async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'CXM',
        name: 'CX',
        type: 'ai-adopted',
        archivedAt: null
      })
    })

    test('Should return the ADR defaults until a model is set', async () => {
      const { statusCode, result } = await server.inject({
        url: '/api/projects/CXM/complexity-model',
        headers: adminHeaders
      })
      expect(statusCode).toBe(200)
      expect(result).toMatchObject({ lineCap: 400, version: 1 })
    })

    test('Should increment the version and audit each admin change', async () => {
      const put = () =>
        server.inject({
          method: 'PUT',
          url: '/api/projects/CXM/complexity-model',
          headers: adminHeaders,
          payload: { ...model, version: 99 }
        })

      expect((await put()).result.version).toBe(2)
      expect((await put()).result.version).toBe(3)
      const events = await db
        .collection('audit-logs')
        .find({ action: 'complexity-model.updated', entityId: 'CXM' })
        .toArray()
      expect(events).toHaveLength(2)
    })

    test('Should reject weights that do not sum to 1 and non-admins', async () => {
      const bad = await server.inject({
        method: 'PUT',
        url: '/api/projects/CXM/complexity-model',
        headers: adminHeaders,
        payload: { ...model, weights: { lines: 0.5, files: 0.5, modules: 0.5 } }
      })
      const viewer = await server.inject({
        method: 'PUT',
        url: '/api/projects/CXM/complexity-model',
        headers: viewerHeaders,
        payload: model
      })

      expect(bad.statusCode).toBe(400)
      expect(viewer.statusCode).toBe(403)
    })

    test('Should recompute stored payloads with the project model', async () => {
      await db.collection(PAYLOADS_COLLECTION).insertMany([
        {
          repository: 'DEFRA/a',
          prNumber: 1,
          projectSlug: 'CXM',
          files: { linesTouched: 500, changed: 3, modulesTouched: 1 },
          complexity: { score: 100, band: 'XL', version: 1 }
        },
        { repository: 'DEFRA/a', prNumber: 2, projectSlug: 'CXM' }
      ])
      await server.inject({
        method: 'PUT',
        url: '/api/projects/CXM/complexity-model',
        headers: adminHeaders,
        payload: model
      })

      const denied = await server.inject({
        method: 'POST',
        url: '/api/admin/complexity/recompute',
        headers: viewerHeaders
      })
      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: '/api/admin/complexity/recompute',
        headers: adminHeaders
      })

      expect(denied.statusCode).toBe(403)
      expect(statusCode).toBe(200)
      expect(result).toEqual({ updated: 1 })
      const doc = await db
        .collection(PAYLOADS_COLLECTION)
        .findOne({ prNumber: 1 })
      expect(doc.complexity.version).toBe(2)
      expect(doc.complexity.score).toBeLessThan(100)
    })
  })

  describe('GET /api/projects', () => {
    test('Should return active projects', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'MMOP',
          name: 'MMO Project',
          type: 'ai-adopted'
        }
      })

      const { statusCode, result } = await server.inject({
        url: '/api/projects',
        headers: adminHeaders
      })
      expect(statusCode).toBe(200)
      expect(result.projects).toHaveLength(1)
      expect(result.projects[0].slug).toBe('MMOP')
    })
  })

  describe('POST /api/projects', () => {
    const validPayload = {
      slug: 'SMPL',
      name: 'Sample Project',
      type: 'ai-native',
      jira: { projectKeys: ['SMPL'] }
    }

    test('Should reject request when user is not admin', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: viewerHeaders,
        payload: validPayload
      })
      expect(statusCode).toBe(403)
    })

    test('Should reject request when user context is missing', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        payload: validPayload
      })
      expect(statusCode).toBe(401)
    })

    test('Should reject a project admin creating a project', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: projectAdminHeaders,
        payload: validPayload
      })
      expect(statusCode).toBe(403)
    })

    test('Should reject invalid payload', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: { slug: 'invalid slug with spaces', name: 'Bad' }
      })
      expect(statusCode).toBe(400)
    })

    test('Should create project when admin', async () => {
      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: validPayload
      })

      expect(statusCode).toBe(201)
      expect(result.slug).toBe('SMPL')
      expect(result.createdAt).toBeDefined()
    })

    test('Should reject when project already exists', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: validPayload
      })

      const { statusCode, result } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: validPayload
      })
      expect(statusCode).toBe(409)
      expect(result).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'That project slug is already in use'
      })
    })

    const create = (payload) =>
      server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: { name: 'New', type: 'ai-adopted', ...payload }
      })

    test.each(['ABC', 'ABCD'])(
      'Should accept the letters-only slug %s',
      async (slug) => {
        expect((await create({ slug })).statusCode).toBe(201)
      }
    )

    test.each(['AB1', 'CR01', 'AB', 'ABCDE', 'abc', 'A-BC'])(
      'Should reject the slug %s for a new project',
      async (slug) => {
        const { statusCode, result } = await create({ slug })

        expect(statusCode).toBe(400)
        expect(result.message).toBe('Invalid request input')
      }
    )

    test('Should create an AI-Adopted project without a Jira key', async () => {
      const { statusCode, result } = await create({ slug: 'ADPT' })

      expect(statusCode).toBe(201)
      expect(result.jira.projectKeys).toEqual([])
    })

    test('Should create an AI-Adopted project with one Jira key', async () => {
      const { statusCode, result } = await create({
        slug: 'ADPK',
        jira: { projectKeys: ['MMO_CR'] }
      })

      expect(statusCode).toBe(201)
      expect(result.jira.projectKeys).toEqual(['MMO_CR'])
    })

    test.each([
      ['no jira block', {}],
      ['an empty key list', { jira: { projectKeys: [] } }]
    ])('Should reject an AI-Native project with %s', async (_, extra) => {
      const { statusCode, result } = await create({
        slug: 'NATV',
        type: 'ai-native',
        ...extra
      })

      expect(statusCode).toBe(400)
      expect(result.message).toBe(
        'AI-Native projects require exactly one Jira project key'
      )
      await expect(
        db.collection(PROJECTS_COLLECTION).countDocuments({ slug: 'NATV' })
      ).resolves.toBe(0)
    })

    test.each([
      ['two keys', ['ONE', 'TWO']],
      ['a lower-case key', ['mmo']],
      ['a key starting with a digit', ['1MMO']]
    ])('Should reject %s', async (_, projectKeys) => {
      const { statusCode, result } = await create({
        slug: 'KEYS',
        type: 'ai-native',
        jira: { projectKeys }
      })

      expect(statusCode).toBe(400)
      expect(result.message).toBe('Invalid request input')
    })
  })

  describe('GET /api/projects/{slug}', () => {
    test('Should return project details', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'GETT',
          name: 'Get Test',
          type: 'ai-adopted'
        }
      })

      const { statusCode, result } = await server.inject({
        url: '/api/projects/GETT',
        headers: adminHeaders
      })
      expect(statusCode).toBe(200)
      expect(result.slug).toBe('GETT')
    })

    test('Should return 404 for missing project', async () => {
      const { statusCode } = await server.inject({
        url: '/api/projects/MISS',
        headers: adminHeaders
      })
      expect(statusCode).toBe(404)
    })

    test('Should return 400 for invalid slug format', async () => {
      const { statusCode } = await server.inject({
        url: '/api/projects/Invalid_Slug!',
        headers: adminHeaders
      })
      expect(statusCode).toBe(400)
    })
  })

  describe('PUT /api/projects/{slug}', () => {
    beforeEach(async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'PUTT',
          name: 'Put Test',
          type: 'ai-native',
          jira: { projectKeys: ['PUTT'] }
        }
      })
    })

    test('Should reject non-admin users', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/projects/PUTT',
        headers: viewerHeaders,
        payload: { name: 'Changed' }
      })
      expect(statusCode).toBe(403)
    })

    test('Should reject forbidden slug updates', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/projects/PUTT',
        headers: adminHeaders,
        payload: { slug: 'NEWS', name: 'Changed' }
      })
      expect(statusCode).toBe(400)
    })

    test('Should update project when admin', async () => {
      const { statusCode, result } = await server.inject({
        method: 'PUT',
        url: '/api/projects/PUTT',
        headers: adminHeaders,
        payload: { name: 'Updated Put Test' }
      })

      expect(statusCode).toBe(200)
      expect(result.name).toBe('Updated Put Test')
    })

    test('Should return 404 for missing project', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/projects/NONE',
        headers: adminHeaders,
        payload: { name: 'Missing' }
      })
      expect(statusCode).toBe(404)
    })

    const update = (slug, payload) =>
      server.inject({
        method: 'PUT',
        url: `/api/projects/${slug}`,
        headers: adminHeaders,
        payload
      })
    const nativeKeyMessage =
      'AI-Native projects require exactly one Jira project key'
    const fixedKeyMessage = 'The Jira project key cannot be changed'
    const storedKeys = async (slug) =>
      (await db.collection(PROJECTS_COLLECTION).findOne({ slug })).jira
        .projectKeys

    test('Should still read and rename a project with a digit slug', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'CR01',
        name: 'Legacy',
        type: 'ai-native',
        jira: { projectKeys: ['CRO'] },
        archivedAt: null
      })
      const read = await server.inject({
        url: '/api/projects/CR01',
        headers: adminHeaders
      })
      const renamed = await update('CR01', { name: 'Renamed' })

      expect(read.statusCode).toBe(200)
      expect(renamed.statusCode).toBe(200)
      expect(renamed.result.name).toBe('Renamed')
    })

    test('Should allow a name-only update of an AI-Native project with its key', async () => {
      const { statusCode, result } = await update('PUTT', { name: 'Renamed' })

      expect(statusCode).toBe(200)
      expect(result.jira.projectKeys).toEqual(['PUTT'])
    })

    test('Should check the AI-Native key rule on every update', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'NOKY',
        name: 'No key',
        type: 'ai-native',
        jira: { projectKeys: [] },
        archivedAt: null
      })

      const { statusCode, result } = await update('NOKY', { name: 'Renamed' })

      expect(statusCode).toBe(400)
      expect(result.message).toBe(nativeKeyMessage)
    })

    test.each([
      ['changing', ['OTHR']],
      ['clearing', []]
    ])('Should reject %s a set Jira key', async (_, projectKeys) => {
      const { statusCode, result } = await update('PUTT', {
        jira: { projectKeys }
      })

      expect(statusCode).toBe(400)
      expect(result).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: fixedKeyMessage
      })
      expect(await storedKeys('PUTT')).toEqual(['PUTT'])
    })

    test('Should accept the same Jira key again', async () => {
      const { statusCode, result } = await update('PUTT', {
        name: 'Same key',
        jira: { projectKeys: ['PUTT'] }
      })

      expect(statusCode).toBe(200)
      expect(result.jira.projectKeys).toEqual(['PUTT'])
    })

    test('Should reject a second Jira key on update', async () => {
      const { statusCode } = await update('PUTT', {
        jira: { projectKeys: ['PUTT', 'MORE'] }
      })

      expect(statusCode).toBe(400)
    })

    describe('When an AI-Adopted project becomes AI-Native', () => {
      beforeEach(async () => {
        await server.inject({
          method: 'POST',
          url: '/api/projects',
          headers: adminHeaders,
          payload: { slug: 'ADPT', name: 'Adopted', type: 'ai-adopted' }
        })
      })

      test('Should reject the change without a Jira key', async () => {
        const { statusCode, result } = await update('ADPT', {
          type: 'ai-native'
        })

        expect(statusCode).toBe(400)
        expect(result.message).toBe(nativeKeyMessage)
      })

      test('Should accept the change with one Jira key in the same request', async () => {
        const { statusCode, result } = await update('ADPT', {
          type: 'ai-native',
          jira: { projectKeys: ['ADPT'] }
        })

        expect(statusCode).toBe(200)
        expect(result).toMatchObject({
          type: 'ai-native',
          jira: { projectKeys: ['ADPT'] }
        })
      })

      test('Should add a Jira key once to a project without one', async () => {
        const added = await update('ADPT', { jira: { projectKeys: ['ADPT'] } })
        const changed = await update('ADPT', {
          jira: { projectKeys: ['NEWK'] }
        })

        expect(added.statusCode).toBe(200)
        expect(added.result).toMatchObject({
          type: 'ai-adopted',
          jira: { projectKeys: ['ADPT'] }
        })
        expect(changed.statusCode).toBe(400)
        expect(changed.result.message).toBe(fixedKeyMessage)
        expect(await storedKeys('ADPT')).toEqual(['ADPT'])
      })

      test('Should accept the change using the key already stored', async () => {
        await update('ADPT', { jira: { projectKeys: ['ADPT'] } })

        const { statusCode, result } = await update('ADPT', {
          type: 'ai-native'
        })

        expect(statusCode).toBe(200)
        expect(result.type).toBe('ai-native')
      })

      test('Should go back to AI-Adopted only with its key kept', async () => {
        await update('ADPT', {
          type: 'ai-native',
          jira: { projectKeys: ['ADPT'] }
        })
        const dropped = await update('ADPT', {
          type: 'ai-adopted',
          jira: { projectKeys: [] }
        })
        const kept = await update('ADPT', { type: 'ai-adopted' })

        expect(dropped.statusCode).toBe(400)
        expect(dropped.result.message).toBe(fixedKeyMessage)
        expect(kept.statusCode).toBe(200)
        expect(kept.result).toMatchObject({
          type: 'ai-adopted',
          jira: { projectKeys: ['ADPT'] }
        })
      })
    })

    test('Should change only the Jira fields sent and never sync-owned fields', async () => {
      const lastSyncedAt = new Date('2026-10-01T09:00:00.000Z')
      await db.collection(PROJECTS_COLLECTION).updateOne(
        { slug: 'PUTT' },
        {
          $set: {
            'jira.lastSyncedAt': lastSyncedAt,
            'jira.statusMapping': { Done: 'done' },
            'jira.detectedStatuses': ['Done']
          }
        }
      )

      const { statusCode } = await update('PUTT', {
        jira: {
          boardId: 7,
          statusMapping: { Done: 'waiting' },
          detectedStatuses: [],
          lastSyncedAt: '2020-01-01T00:00:00.000Z'
        }
      })

      expect(statusCode).toBe(200)
      const stored = await db
        .collection(PROJECTS_COLLECTION)
        .findOne({ slug: 'PUTT' })
      expect(stored.jira).toEqual({
        projectKeys: ['PUTT'],
        boardId: 7,
        lastSyncedAt,
        statusMapping: { Done: 'done' },
        detectedStatuses: ['Done']
      })
    })
  })

  describe('POST /api/projects/{slug}/jira/sync', () => {
    test('Should no longer offer a Jira sync route', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects/SYNC/jira/sync',
        headers: adminHeaders
      })

      expect(statusCode).toBe(404)
    })
  })

  describe('DELETE /api/projects/{slug}', () => {
    test('Should reject non-admin users', async () => {
      const { statusCode } = await server.inject({
        method: 'DELETE',
        url: '/api/projects/DELT',
        headers: viewerHeaders
      })
      expect(statusCode).toBe(403)
    })

    test('Should delete project when admin', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'DELT',
          name: 'Del Test',
          type: 'ai-native',
          jira: { projectKeys: ['DELT'] }
        }
      })

      const { statusCode } = await server.inject({
        method: 'DELETE',
        url: '/api/projects/DELT',
        headers: adminHeaders
      })
      expect(statusCode).toBe(204)

      const getRes = await server.inject({
        url: '/api/projects/DELT',
        headers: adminHeaders
      })
      expect(getRes.statusCode).toBe(404)
    })

    test('Should return 404 when deleting missing project', async () => {
      const { statusCode } = await server.inject({
        method: 'DELETE',
        url: '/api/projects/MISS',
        headers: adminHeaders
      })
      expect(statusCode).toBe(404)
    })
  })

  describe('GET /api/projects/{slug}/payloads', () => {
    test('Should return 404 for non-existent project', async () => {
      const { statusCode } = await server.inject({
        url: '/api/projects/UNKN/payloads',
        headers: adminHeaders
      })
      expect(statusCode).toBe(404)
    })

    test('Should return payloads for project with optional date filter', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'PAYL',
          name: 'Payload Project',
          type: 'ai-adopted'
        }
      })

      await db.collection(PAYLOADS_COLLECTION).insertOne({
        repository: 'DEFRA/test-repo',
        prNumber: 1,
        projectSlug: 'PAYL',
        calculatedAt: new Date('2026-01-10T00:00:00.000Z'),
        commitBreakdown: []
      })

      const { statusCode, result } = await server.inject({
        url: '/api/projects/PAYL/payloads?from=2026-01-01T00:00:00.000Z',
        headers: adminHeaders
      })
      expect(statusCode).toBe(200)
      expect(result.payloads).toHaveLength(1)
      expect(result.payloads[0].repository).toBe('DEFRA/test-repo')
    })
  })

  describe('GET /api/projects/{slug}/sprints', () => {
    test('Should return 404 for non-existent project', async () => {
      const { statusCode } = await server.inject({
        url: '/api/projects/UNKN/sprints',
        headers: adminHeaders
      })
      expect(statusCode).toBe(404)
    })

    test('Should return sprints for valid project', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'SPRT',
          name: 'Sprint Project',
          type: 'ai-native',
          jira: { projectKeys: ['SPRT'] }
        }
      })

      const { statusCode, result } = await server.inject({
        url: '/api/projects/SPRT/sprints?count=3',
        headers: adminHeaders
      })
      expect(statusCode).toBe(200)
      expect(result.sprints).toHaveLength(3)
    })
  })

  describe('Role mapping authorization enforcement', () => {
    beforeEach(async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'RSTR',
          name: 'Restricted Project',
          type: 'ai-adopted'
        }
      })
      await grantAccess(db, 'RSTR')
    })

    const read = (path, headers) =>
      server.inject({ url: `/api/projects/RSTR/${path}`, headers })

    test('Dashboard admin is allowed access regardless of project mappings', async () => {
      expect((await read('payloads', adminHeaders)).statusCode).toBe(200)
      expect((await read('sprints', adminHeaders)).statusCode).toBe(200)
    })

    test.each([
      ['project user', () => projectUserHeaders],
      ['project admin', () => projectAdminHeaders]
    ])('A %s is allowed to read', async (_, headers) => {
      expect((await read('payloads', headers())).statusCode).toBe(200)
      expect((await read('sprints', headers())).statusCode).toBe(200)
    })

    test('User without a mapping gets the same answer as a missing project', async () => {
      const payloadRes = await read('payloads', outsiderHeaders)
      const missingRes = await server.inject({
        url: '/api/projects/NSUP/payloads',
        headers: outsiderHeaders
      })
      expect(payloadRes.statusCode).toBe(404)
      expect(missingRes.statusCode).toBe(404)
      expect(payloadRes.result.message).toBe("Project 'RSTR' not found")
      expect(missingRes.result.message).toBe("Project 'NSUP' not found")
      expect((await read('sprints', outsiderHeaders)).statusCode).toBe(404)
    })

    test('Caller without a token cannot read a restricted project', async () => {
      const res = await server.inject('/api/projects/RSTR/payloads')

      expect(res.statusCode).toBe(401)
    })

    test('A project with no mappings is denied to everyone but dashboard admins', async () => {
      await db.collection(PROJECTS_COLLECTION).insertOne({
        slug: 'UNGR',
        name: 'Ungrouped',
        type: 'ai-adopted',
        archivedAt: null
      })
      const read = (headers) =>
        server.inject({ url: '/api/projects/UNGR/payloads', headers })

      expect((await read(projectUserHeaders)).statusCode).toBe(404)
      expect((await read(projectAdminHeaders)).statusCode).toBe(404)
      expect((await read(adminHeaders)).statusCode).toBe(200)
    })

    test('A project user mapping never confers admin rights', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/projects/RSTR/complexity-model',
        headers: projectUserHeaders,
        payload: {
          lineCap: 200,
          fileCap: 20,
          moduleCap: 4,
          weights: { lines: 0.6, files: 0.3, modules: 0.1 },
          hardCapLines: 800,
          hardCapFiles: 60
        }
      })

      expect(statusCode).toBe(403)
    })
  })

  describe('Project roles', () => {
    beforeEach(async () => {
      await db.collection('audit-logs').deleteMany({})
      await db.collection(PROJECTS_COLLECTION).insertMany([
        { slug: 'MINE', name: 'Mine', type: 'ai-adopted', archivedAt: null },
        { slug: 'THRS', name: 'Theirs', type: 'ai-adopted', archivedAt: null }
      ])
      await grantAccess(db, 'MINE')
    })

    const list = (headers) => server.inject({ url: '/api/projects', headers })

    test('Should list every project to a dashboard admin with the dashboard-admin role', async () => {
      const { result } = await list(adminHeaders)

      expect(result.projects.map((p) => [p.slug, p.role]).sort()).toEqual([
        ['MINE', 'dashboard-admin'],
        ['THRS', 'dashboard-admin']
      ])
    })

    test('Should list only the projects a caller holds a role on', async () => {
      const asAdmin = await list(projectAdminHeaders)
      const asUser = await list(projectUserHeaders)
      const asOutsider = await list(outsiderHeaders)

      expect(asAdmin.result.projects).toMatchObject([
        { slug: 'MINE', role: 'project-admin' }
      ])
      expect(asUser.result.projects).toMatchObject([
        { slug: 'MINE', role: 'project-user' }
      ])
      expect(asOutsider.result.projects).toEqual([])
    })

    test('Should never expose group fields', async () => {
      const { result } = await list(projectAdminHeaders)

      expect(result.projects[0]).not.toHaveProperty('adminGroupIds')
      expect(result.projects[0]).not.toHaveProperty('entraGroupIds')
    })

    test('Should reject a list request with no token', async () => {
      const { statusCode } = await server.inject('/api/projects')

      expect(statusCode).toBe(401)
    })

    test('Should answer a single project with the caller’s role', async () => {
      const { statusCode, result } = await server.inject({
        url: '/api/projects/MINE',
        headers: projectAdminHeaders
      })
      const hidden = await server.inject({
        url: '/api/projects/THRS',
        headers: projectAdminHeaders
      })

      expect(statusCode).toBe(200)
      expect(result.role).toBe('project-admin')
      expect(hidden.statusCode).toBe(404)
    })

    test('Should strip the retired group fields when creating a project', async () => {
      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'FRSH',
          name: 'Fresh',
          type: 'ai-native',
          jira: { projectKeys: ['FRSH'] },
          entraGroupIds: ['g']
        }
      })

      expect(statusCode).toBe(201)
      const stored = await db
        .collection(PROJECTS_COLLECTION)
        .findOne({ slug: 'FRSH' })
      expect(stored).not.toHaveProperty('entraGroupIds')
    })

    test('Should drop a project’s role mappings when it is deleted', async () => {
      await server.inject({
        method: 'DELETE',
        url: '/api/projects/MINE',
        headers: adminHeaders
      })

      await expect(
        db.collection('role_mappings').countDocuments({ projectSlug: 'MINE' })
      ).resolves.toBe(0)
    })
  })

  describe('PR Jira links', () => {
    const url = '/api/projects/LINK/pr-links/DEFRA%2Frepo/42'

    beforeEach(async () => {
      await db.collection('pr-jira-links').deleteMany({})
      await db.collection('audit-logs').deleteMany({})
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'LINK',
          name: 'Link',
          type: 'ai-adopted'
        }
      })
      await grantAccess(db, 'LINK')
      await db.collection('pr-jira-links').insertOne({
        projectSlug: 'LINK',
        repository: 'DEFRA/repo',
        prNumber: 42,
        jiraKey: 'MMO-1'
      })
    })

    test('Should replace the manual links and keep payload links', async () => {
      const put = (jiraKeys) =>
        server.inject({
          method: 'PUT',
          url,
          headers: adminHeaders,
          payload: { jiraKeys }
        })

      await put(['MMO-2', 'MMO-3'])
      const { statusCode, result } = await put(['MMO-3'])

      expect(statusCode).toBe(200)
      expect(result.links).toEqual([
        { jiraKey: 'MMO-1', source: 'payload' },
        { jiraKey: 'MMO-3', source: 'manual' }
      ])
      const audit = await db
        .collection('audit-logs')
        .find({ action: 'pr-jira-links.updated' })
        .sort({ occurredAt: 1 })
        .toArray()
      expect(audit).toHaveLength(2)
      expect(audit[1]).toMatchObject({
        entityId: 'DEFRA/repo#42',
        before: ['MMO-2', 'MMO-3'],
        after: ['MMO-3'],
        actor: { oid: 'admin-1', name: 'Admin User' }
      })
    })

    test('Should list the links for a pull request', async () => {
      const { result } = await server.inject({
        url,
        headers: projectUserHeaders
      })

      expect(result.links).toEqual([{ jiraKey: 'MMO-1', source: 'payload' }])
    })

    test.each([
      ['a malformed key', ['mmo-1']],
      ['too many keys', Array.from({ length: 21 }, (_, i) => `MMO-${i + 1}`)],
      ['duplicate keys', ['MMO-1', 'MMO-1']]
    ])('Should reject %s', async (_, jiraKeys) => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url,
        headers: adminHeaders,
        payload: { jiraKeys }
      })

      expect(statusCode).toBe(400)
    })

    test('Should let a project admin change links and forbid a project user', async () => {
      const put = (headers) =>
        server.inject({
          method: 'PUT',
          url,
          headers,
          payload: { jiraKeys: ['MMO-2'] }
        })

      expect((await put(projectUserHeaders)).statusCode).toBe(403)
      expect((await put(projectAdminHeaders)).statusCode).toBe(200)
    })
  })

  describe('Computed metric routes', () => {
    test.each(['leverage-v2', 'churn', 'ai-native-leverage'])(
      'Should hide %s for a restricted project from non-members',
      async (route) => {
        await server.inject({
          method: 'POST',
          url: '/api/projects',
          headers: adminHeaders,
          payload: {
            slug: 'SECR',
            name: 'Secret',
            type: 'ai-native',
            jira: { projectKeys: ['SECR'] }
          }
        })

        const denied = await server.inject({
          url: `/api/projects/SECR/${route}`,
          headers: viewerHeaders
        })
        const missing = await server.inject({
          url: `/api/projects/NOPR/${route}`,
          headers: adminHeaders
        })

        expect(denied.statusCode).toBe(404)
        expect(missing.statusCode).toBe(404)
      }
    )

    test('Should serve 21-day AI code churn from survival records', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/projects',
        headers: adminHeaders,
        payload: {
          slug: 'CHRN',
          name: 'Churny',
          type: 'ai-native',
          jira: { projectKeys: ['CHRN'] }
        }
      })
      await db.collection('ai_survival').deleteMany({})
      await db.collection('ai_survival').insertMany(
        [1, 2].map((prNumber) => ({
          repository: 'DEFRA/churny',
          prNumber,
          windowDays: 21,
          projectSlug: 'CHRN',
          mergedAt: new Date('2026-05-01T00:00:00Z'),
          aiLinesMerged: 100,
          aiLinesSurviving: 60,
          humanLinesMerged: 10,
          humanLinesSurviving: 10,
          byOrigin: {
            aiAgent: { merged: 100, surviving: 60 },
            aiCompletion: { merged: 0, surviving: 0 },
            aiChat: { merged: 0, surviving: 0 }
          }
        }))
      )

      const { statusCode, result } = await server.inject({
        url: '/api/projects/CHRN/churn?from=2026-04-01T00:00:00Z&to=2026-06-01T00:00:00Z',
        headers: adminHeaders
      })
      const empty = await server.inject({
        url: '/api/projects/CHRN/churn?windowDays=7',
        headers: adminHeaders
      })

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        available: true,
        prCount: 2,
        churnRatePercent: 40,
        penaltyApplied: true,
        effectiveMultiplier: 0.6
      })
      expect(empty.result).toMatchObject({ available: false, windowDays: 7 })
    })
  })
})
