describe('#persona-mappings service', () => {
  let server
  let db
  let service

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    service = await import('./persona-mappings.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(service.PERSONA_MAPPINGS_COLLECTION).deleteMany({})
  })

  describe('#upsertPersonaMapping', () => {
    test('Should create a mapping', async () => {
      const mapping = await service.upsertPersonaMapping(
        db,
        'octocat',
        'devops'
      )

      expect(mapping).toMatchObject({
        githubHandle: 'octocat',
        persona: 'devops'
      })
      expect(mapping.updatedAt).toEqual(expect.any(String))
    })

    test('Should key the stored document on the lower-cased handle', async () => {
      await service.upsertPersonaMapping(db, 'OctoCat', 'qa')

      const stored = await db
        .collection(service.PERSONA_MAPPINGS_COLLECTION)
        .findOne({})

      expect(stored._id).toBe('octocat')
      expect(stored.githubHandle).toBe('OctoCat')
    })

    test('Should replace an existing mapping rather than duplicate it', async () => {
      await service.upsertPersonaMapping(db, 'octocat', 'devops')
      await service.upsertPersonaMapping(db, 'octocat', 'qa')

      const mappings = await service.listPersonaMappings(db)

      expect(mappings).toHaveLength(1)
      expect(mappings[0].persona).toBe('qa')
    })
  })

  describe('#listPersonaMappings', () => {
    test('Should return every mapping sorted by handle', async () => {
      await service.upsertPersonaMapping(db, 'zed', 'qa')
      await service.upsertPersonaMapping(db, 'ada', 'devops')

      const mappings = await service.listPersonaMappings(db)

      expect(mappings.map((m) => m.githubHandle)).toEqual(['ada', 'zed'])
    })

    test('Should return an empty array when nothing is configured', async () => {
      await expect(service.listPersonaMappings(db)).resolves.toEqual([])
    })
  })

  describe('#deletePersonaMapping', () => {
    test('Should remove a mapping and report success', async () => {
      await service.upsertPersonaMapping(db, 'octocat', 'devops')

      await expect(service.deletePersonaMapping(db, 'octocat')).resolves.toBe(
        true
      )
      await expect(service.listPersonaMappings(db)).resolves.toEqual([])
    })

    test('Should match case-insensitively', async () => {
      await service.upsertPersonaMapping(db, 'OctoCat', 'devops')

      await expect(service.deletePersonaMapping(db, 'octocat')).resolves.toBe(
        true
      )
    })

    test('Should report false when there was nothing to delete', async () => {
      await expect(service.deletePersonaMapping(db, 'nobody')).resolves.toBe(
        false
      )
    })
  })
})
