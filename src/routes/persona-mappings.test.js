import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'

describe('#persona-mappings routes', () => {
  let server
  let collection
  let admin
  let projectAdmin
  let projectUser
  let outsider

  const url = (handle = '', slug = 'ALPH') =>
    `/api/projects/${slug}/persona-mappings${handle ? `/${handle}` : ''}`

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    const { PERSONA_MAPPINGS_COLLECTION } =
      await import('#/services/persona-mappings.js')

    server = await createServer()
    await server.initialize()
    collection = server.db.collection(PERSONA_MAPPINGS_COLLECTION)
    ;[admin, projectAdmin, projectUser, outsider] = await Promise.all(
      [ADMIN, PROJECT_ADMIN, PROJECT_USER, OUTSIDER].map(asUser)
    )
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await collection.deleteMany({})
    await server.db.collection('projects').deleteMany({})
    await server.db.collection('projects').insertMany(
      ['ALPH', 'BETA'].map((slug) => ({
        slug,
        name: slug,
        type: 'ai-adopted',
        archivedAt: null
      }))
    )
    await server.db.collection('role_mappings').deleteMany({})
    await grantAccess(server.db, 'ALPH')
  })

  const put = (handle, persona, headers, slug) =>
    server.inject({
      method: 'PUT',
      url: url(handle, slug),
      headers,
      payload: { persona }
    })

  describe('GET', () => {
    test('Should return an empty list when nothing is configured', async () => {
      const { statusCode, result } = await server.inject({
        url: url(),
        headers: projectUser
      })

      expect(statusCode).toBe(200)
      expect(result).toEqual({ mappings: [] })
    })

    test('Should return configured mappings to a project user', async () => {
      await put('octocat', 'devops', projectAdmin)

      const { result } = await server.inject({
        url: url(),
        headers: projectUser
      })

      expect(result.mappings).toHaveLength(1)
      expect(result.mappings[0]).toMatchObject({
        githubHandle: 'octocat',
        persona: 'devops',
        scope: 'project'
      })
    })

    test('Should hide the project from someone with no role on it', async () => {
      const { statusCode } = await server.inject({
        url: url(),
        headers: outsider
      })

      expect(statusCode).toBe(404)
    })

    test('Should reject a request with no signed context', async () => {
      const { statusCode } = await server.inject({ url: url() })

      expect(statusCode).toBe(401)
    })
  })

  describe('PUT', () => {
    test('Should let a project admin create a mapping', async () => {
      const { statusCode, result } = await put(
        'randhir-patel',
        'qa',
        projectAdmin
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({ githubHandle: 'randhir-patel' })
      await expect(collection.countDocuments()).resolves.toBe(1)
    })

    test('Should let a dashboard admin create a mapping', async () => {
      const { statusCode } = await put('octocat', 'qa', admin)

      expect(statusCode).toBe(200)
    })

    test('Should forbid a project user', async () => {
      const { statusCode } = await put('octocat', 'qa', projectUser)

      expect(statusCode).toBe(403)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should not let a project admin write to a project they do not administer', async () => {
      const { statusCode } = await put('octocat', 'qa', projectAdmin, 'BETA')

      expect([403, 404]).toContain(statusCode)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should reject an invalid GitHub handle', async () => {
      const { statusCode } = await put('a%5Cb', 'qa', projectAdmin)

      expect(statusCode).toBe(400)
    })

    test('Should reject an unknown persona', async () => {
      const { statusCode } = await put('octocat', 'manager', projectAdmin)

      expect(statusCode).toBe(400)
    })
  })

  describe('DELETE', () => {
    const remove = (handle, headers) =>
      server.inject({ method: 'DELETE', url: url(handle), headers })

    test('Should let a project admin remove a mapping', async () => {
      await put('octocat', 'devops', projectAdmin)

      const { statusCode } = await remove('octocat', projectAdmin)

      expect(statusCode).toBe(204)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should forbid a project user', async () => {
      await put('octocat', 'devops', projectAdmin)

      const { statusCode } = await remove('octocat', projectUser)

      expect(statusCode).toBe(403)
      await expect(collection.countDocuments()).resolves.toBe(1)
    })

    test('Should return 404 for an unknown handle', async () => {
      const { statusCode } = await remove('nobody', projectAdmin)

      expect(statusCode).toBe(404)
    })
  })
})
