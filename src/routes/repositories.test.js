import { Collection } from 'mongodb'

import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'

describe('#repositories routes', () => {
  let server
  let db
  let admin
  let projectAdmin
  let projectUser
  let outsider

  beforeAll(async () => {
    process.env.INGEST_TOKEN = 'test-ingest-token'
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
    ;[admin, projectAdmin, projectUser, outsider] = await Promise.all(
      [ADMIN, PROJECT_ADMIN, PROJECT_USER, OUTSIDER].map(asUser)
    )
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.INGEST_TOKEN
  })

  beforeEach(async () => {
    for (const name of ['projects', 'repositories', 'payloads', 'audit-logs']) {
      await db.collection(name).deleteMany({})
    }
    await db.collection('projects').insertMany([
      {
        slug: 'MINE',
        name: 'Mine',
        type: 'ai-adopted',
        archivedAt: null
      },
      {
        slug: 'THRS',
        name: 'Theirs',
        type: 'ai-adopted',
        archivedAt: null
      }
    ])
    await db.collection('role_mappings').deleteMany({})
    await grantAccess(db, 'MINE')
    await db.collection('repositories').insertMany([
      { fullName: 'DEFRA/mine', projectSlug: 'MINE' },
      { fullName: 'DEFRA/theirs', projectSlug: 'THRS' }
    ])
    await db
      .collection('payloads')
      .insertOne({ repository: 'DEFRA/loose', prNumber: 1, projectSlug: null })
  })

  const put = (fullName, headers, body = { projectSlug: 'MINE' }) =>
    server.inject({
      method: 'PUT',
      url: `/api/repositories/${encodeURIComponent(fullName)}`,
      headers,
      payload: body
    })

  const del = (fullName, headers) =>
    server.inject({
      method: 'DELETE',
      url: `/api/repositories/${encodeURIComponent(fullName)}`,
      headers
    })

  describe('GET /api/ingest/repositories/{fullName}', () => {
    const lookup = (fullName, headers) =>
      server.inject({
        url: `/api/ingest/repositories/${encodeURIComponent(fullName)}`,
        headers
      })
    const ingest = { 'x-ingest-token': 'test-ingest-token' }

    test('Should report a mapped repository with the ingest token', async () => {
      const { statusCode, result } = await lookup('DEFRA/mine', ingest)

      expect(statusCode).toBe(200)
      expect(result).toEqual({ fullName: 'DEFRA/mine', mapped: true })
    })

    test('Should report an unmapped repository', async () => {
      const { result } = await lookup('DEFRA/unknown', ingest)

      expect(result).toEqual({ fullName: 'DEFRA/unknown', mapped: false })
    })

    test('Should refuse a missing ingest token and a user token', async () => {
      const none = await lookup('DEFRA/mine', {})
      const user = await lookup('DEFRA/mine', admin)

      expect(none.statusCode).toBe(401)
      expect(user.statusCode).toBe(401)
    })
  })

  describe('GET /api/repositories', () => {
    test('Should list every repository to a dashboard admin', async () => {
      const { result } = await server.inject({
        url: '/api/repositories',
        headers: admin
      })

      expect(result.repositories.map((r) => r.fullName)).toEqual([
        'DEFRA/mine',
        'DEFRA/theirs'
      ])
    })

    test('Should list only repositories in projects the caller can read', async () => {
      const { result } = await server.inject({
        url: '/api/repositories',
        headers: projectUser
      })
      const none = await server.inject({
        url: '/api/repositories',
        headers: outsider
      })

      expect(result.repositories.map((r) => r.fullName)).toEqual(['DEFRA/mine'])
      expect(none.result.repositories).toEqual([])
    })
  })

  describe('GET /api/repositories/unassigned', () => {
    test('Should list unassigned repositories to project admins and dashboard admins', async () => {
      const asProjectAdmin = await server.inject({
        url: '/api/repositories/unassigned',
        headers: projectAdmin
      })
      const asAdmin = await server.inject({
        url: '/api/repositories/unassigned',
        headers: admin
      })

      expect(asProjectAdmin.result.repositories).toEqual(['DEFRA/loose'])
      expect(asAdmin.statusCode).toBe(200)
    })

    test('Should refuse project users', async () => {
      const { statusCode } = await server.inject({
        url: '/api/repositories/unassigned',
        headers: projectUser
      })

      expect(statusCode).toBe(403)
    })
  })

  describe('PUT /api/repositories/{fullName}', () => {
    test('Should let a project admin map an unassigned repository to their project', async () => {
      const { statusCode, result } = await put('DEFRA/loose', projectAdmin, {
        projectSlug: 'MINE'
      })

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        fullName: 'DEFRA/loose',
        projectSlug: 'MINE'
      })
      const payload = await db
        .collection('payloads')
        .findOne({ repository: 'DEFRA/loose' })
      expect(payload.projectSlug).toBe('MINE')
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'repository.mapped' })
      expect(audit).toMatchObject({
        projectSlug: 'MINE',
        entityId: 'DEFRA/loose',
        actor: { oid: PROJECT_ADMIN.oid }
      })
    })

    test.each([
      ['a valid key', 'DEFRA_mine'],
      ['an invalid key', 'has space'],
      ['a key in use elsewhere', 'DEFRA_shared']
    ])('Should ignore %s sent with a mapping', async (_, sonarProjectKey) => {
      await db
        .collection('repositories')
        .updateOne(
          { fullName: 'DEFRA/theirs' },
          { $set: { sonarProjectKey: 'DEFRA_shared' } }
        )

      const { statusCode, result } = await put('DEFRA/mine', projectAdmin, {
        projectSlug: 'MINE',
        sonarProjectKey
      })

      expect(statusCode).toBe(200)
      expect(result.sonarProjectKey).toBeUndefined()
      const stored = await db
        .collection('repositories')
        .findOne({ fullName: 'DEFRA/mine' })
      expect(stored.sonarProjectKey).toBeUndefined()
    })

    test('Should not let a project admin map into a project they do not administer', async () => {
      const { statusCode } = await put('DEFRA/loose', projectAdmin, {
        projectSlug: 'THRS'
      })

      expect(statusCode).toBe(404)
    })

    test('Should not let a project admin move a repository between projects', async () => {
      const { statusCode, result } = await put('DEFRA/theirs', projectAdmin)

      expect(statusCode).toBe(403)
      expect(result.message).toMatch(/dashboard admin/)
      const stored = await db
        .collection('repositories')
        .findOne({ fullName: 'DEFRA/theirs' })
      expect(stored.projectSlug).toBe('THRS')
    })

    test('Should let a dashboard admin move a repository between projects', async () => {
      const { statusCode } = await put('DEFRA/theirs', admin)

      expect(statusCode).toBe(200)
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'repository.remapped' })
      expect(audit.before.projectSlug).toBe('THRS')
      expect(audit.after.projectSlug).toBe('MINE')
    })

    test('Should forbid a project user', async () => {
      const { statusCode } = await put('DEFRA/loose', projectUser)

      expect(statusCode).toBe(403)
    })

    test('Should reject a missing project', async () => {
      const { statusCode } = await put('DEFRA/loose', admin, {
        projectSlug: 'NOPE'
      })

      expect(statusCode).toBe(400)
    })

    test('Should keep the Sonar key when a repository is moved to another project', async () => {
      await db
        .collection('repositories')
        .updateOne(
          { fullName: 'DEFRA/theirs' },
          { $set: { sonarProjectKey: 'DEFRA_theirs' } }
        )

      const { statusCode, result } = await put('DEFRA/theirs', admin, {
        projectSlug: 'MINE',
        sonarProjectKey: null
      })

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        projectSlug: 'MINE',
        sonarProjectKey: 'DEFRA_theirs'
      })
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'repository.remapped' })
      expect(audit.after.sonarProjectKey).toBe('DEFRA_theirs')
    })
  })

  describe('PUT /api/repositories/{fullName}/sonar-key', () => {
    const setKey = (fullName, headers, sonarProjectKey) =>
      server.inject({
        method: 'PUT',
        url: `/api/repositories/${encodeURIComponent(fullName)}/sonar-key`,
        headers,
        payload: { sonarProjectKey }
      })
    const stored = (fullName) =>
      db.collection('repositories').findOne({ fullName })
    const auditActions = async () =>
      (
        await db
          .collection('audit-logs')
          .find({ action: /^repository\.sonar-key/ })
          .sort({ occurredAt: 1 })
          .toArray()
      ).map((event) => event.action)

    beforeEach(async () => {
      await db
        .collection('repositories')
        .insertOne({ fullName: 'DEFRA/orphan', projectSlug: null })
    })

    test('Should let a project admin set a key on their own repository', async () => {
      const { statusCode, result } = await setKey(
        'DEFRA/mine',
        projectAdmin,
        'DEFRA_mine'
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        fullName: 'DEFRA/mine',
        projectSlug: 'MINE',
        sonarProjectKey: 'DEFRA_mine'
      })
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'repository.sonar-key.set' })
      expect(audit).toMatchObject({
        entity: 'repository-mapping',
        entityId: 'DEFRA/mine',
        projectSlug: 'MINE',
        before: { projectSlug: 'MINE', sonarProjectKey: null },
        after: { projectSlug: 'MINE', sonarProjectKey: 'DEFRA_mine' },
        actor: { oid: PROJECT_ADMIN.oid }
      })
    })

    test('Should audit set, updated and cleared, and skip an unchanged key', async () => {
      await setKey('DEFRA/mine', admin, 'A')
      await setKey('DEFRA/mine', admin, 'B')
      await setKey('DEFRA/mine', admin, 'B')
      const cleared = await setKey('DEFRA/mine', admin, null)

      expect(cleared.statusCode).toBe(200)
      expect((await stored('DEFRA/mine')).sonarProjectKey).toBeNull()
      expect(await auditActions()).toEqual([
        'repository.sonar-key.set',
        'repository.sonar-key.updated',
        'repository.sonar-key.cleared'
      ])
    })

    test('Should clear the key when sent an empty string', async () => {
      await setKey('DEFRA/mine', admin, 'A')

      const { result } = await setKey('DEFRA/mine', admin, '')

      expect(result.sonarProjectKey).toBeNull()
    })

    test('Should let a dashboard admin set a key on any repository', async () => {
      const theirs = await setKey('DEFRA/theirs', admin, 'DEFRA_theirs')
      const orphan = await setKey('DEFRA/orphan', admin, 'DEFRA_orphan')

      expect(theirs.statusCode).toBe(200)
      expect(orphan.statusCode).toBe(200)
      expect((await stored('DEFRA/orphan')).sonarProjectKey).toBe(
        'DEFRA_orphan'
      )
    })

    test.each([
      ['a project admin of another project', () => projectAdmin, 404],
      ['a project user', () => projectUser, 403],
      ['an outsider', () => outsider, 404]
    ])(
      'Should refuse %s on a project repository',
      async (_, headers, status) => {
        const repository = status === 403 ? 'DEFRA/mine' : 'DEFRA/theirs'

        const { statusCode } = await setKey(repository, headers(), 'NOPE')

        expect(statusCode).toBe(status)
        expect((await stored(repository)).sonarProjectKey).toBeUndefined()
      }
    )

    test('Should hide a repository without a project from everyone but dashboard admins', async () => {
      const asProjectAdmin = await setKey('DEFRA/orphan', projectAdmin, 'K')
      const asOutsider = await setKey('DEFRA/orphan', outsider, 'K')

      expect(asProjectAdmin.statusCode).toBe(404)
      expect(asOutsider.statusCode).toBe(404)
    })

    test('Should return 404 for an unknown repository', async () => {
      const asAdmin = await setKey('DEFRA/unknown', admin, 'K')
      const asProjectAdmin = await setKey('DEFRA/unknown', projectAdmin, 'K')

      expect(asAdmin.statusCode).toBe(404)
      expect(asProjectAdmin.statusCode).toBe(404)
      await expect(
        db.collection('repositories').countDocuments({
          fullName: 'DEFRA/unknown'
        })
      ).resolves.toBe(0)
    })

    test('Should return 404 when the repository is removed during the request', async () => {
      vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockResolvedValueOnce(
        null
      )

      const { statusCode } = await setKey('DEFRA/mine', admin, 'K')

      vi.restoreAllMocks()
      expect(statusCode).toBe(404)
      expect(await auditActions()).toEqual([])
    })

    test('Should reject a request without a token', async () => {
      const { statusCode } = await setKey('DEFRA/mine', {}, 'K')

      expect(statusCode).toBe(401)
    })

    test('Should return 409 for a key linked to another repository', async () => {
      await setKey('DEFRA/theirs', admin, 'DEFRA_shared')

      const { statusCode, result } = await setKey(
        'DEFRA/mine',
        projectAdmin,
        'DEFRA_shared'
      )

      expect(statusCode).toBe(409)
      expect(result).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'That SonarCloud project key is already in use'
      })
      expect((await stored('DEFRA/mine')).sonarProjectKey).toBeUndefined()
    })

    test.each([
      ['a missing key', {}],
      ['an invalid key', { sonarProjectKey: 'has space' }],
      ['a non-string key', { sonarProjectKey: 42 }]
    ])('Should reject %s', async (_, payload) => {
      const { statusCode, result } = await server.inject({
        method: 'PUT',
        url: '/api/repositories/DEFRA%2Fmine/sonar-key',
        headers: admin,
        payload
      })

      expect(statusCode).toBe(400)
      expect(result.message).toBe('Invalid request input')
    })

    test('Should not call any external service', async () => {
      fetchMock.resetMocks()

      await setKey('DEFRA/mine', admin, 'DEFRA_mine')

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /api/repositories/{fullName}', () => {
    test('Should let a project admin remove a repository from their project', async () => {
      const { statusCode } = await del('DEFRA/mine', projectAdmin)

      expect(statusCode).toBe(204)
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'repository.unmapped' })
      expect(audit).toMatchObject({ projectSlug: 'MINE' })
    })

    test('Should not let a project admin remove another project’s repository', async () => {
      const { statusCode } = await del('DEFRA/theirs', projectAdmin)

      expect(statusCode).toBe(404)
      await expect(
        db
          .collection('repositories')
          .countDocuments({ fullName: 'DEFRA/theirs' })
      ).resolves.toBe(1)
    })

    test('Should forbid a project user', async () => {
      const { statusCode } = await del('DEFRA/mine', projectUser)

      expect(statusCode).toBe(403)
    })

    test('Should let a dashboard admin remove any repository', async () => {
      const { statusCode } = await del('DEFRA/theirs', admin)

      expect(statusCode).toBe(204)
    })

    test('Should return 404 for an unmapped repository', async () => {
      const { statusCode } = await del('DEFRA/loose', admin)

      expect(statusCode).toBe(404)
    })
  })
})
