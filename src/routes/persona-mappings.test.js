describe('#persona-mappings routes', () => {
  let server
  let collection

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    const { PERSONA_MAPPINGS_COLLECTION } =
      await import('#/services/persona-mappings.js')

    server = await createServer()
    await server.initialize()
    collection = server.db.collection(PERSONA_MAPPINGS_COLLECTION)
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await collection.deleteMany({})
  })

  describe('GET /api/persona-mappings', () => {
    test('Should return an empty list when nothing is configured', async () => {
      const { statusCode, result } = await server.inject(
        '/api/persona-mappings'
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({ mappings: [] })
    })

    test('Should return configured mappings', async () => {
      await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/octocat',
        payload: { persona: 'devops' }
      })

      const { result } = await server.inject('/api/persona-mappings')

      expect(result.mappings).toHaveLength(1)
      expect(result.mappings[0]).toMatchObject({
        githubHandle: 'octocat',
        persona: 'devops'
      })
    })
  })

  describe('PUT /api/persona-mappings/{githubHandle}', () => {
    test('Should create a mapping', async () => {
      const { statusCode, result } = await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/randhir-patel',
        payload: { persona: 'qa' }
      })

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        githubHandle: 'randhir-patel',
        persona: 'qa'
      })
      await expect(collection.countDocuments()).resolves.toBe(1)
    })

    test('Should reject an invalid GitHub handle', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/-invalid',
        payload: { persona: 'qa' }
      })

      expect(statusCode).toBe(400)
    })

    test('Should reject an unknown persona', async () => {
      const { statusCode } = await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/octocat',
        payload: { persona: 'manager' }
      })

      expect(statusCode).toBe(400)
    })
  })

  describe('DELETE /api/persona-mappings/{githubHandle}', () => {
    test('Should remove a mapping', async () => {
      await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/octocat',
        payload: { persona: 'devops' }
      })

      const { statusCode } = await server.inject({
        method: 'DELETE',
        url: '/api/persona-mappings/octocat'
      })

      expect(statusCode).toBe(204)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should return 404 for an unknown handle', async () => {
      const { statusCode } = await server.inject({
        method: 'DELETE',
        url: '/api/persona-mappings/nobody'
      })

      expect(statusCode).toBe(404)
    })
  })
})
