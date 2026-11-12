describe('#persona-mappings service', () => {
  let server
  let db
  let service
  const P = 'alpha'

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
    test('Should create a project-scoped mapping', async () => {
      const mapping = await service.upsertPersonaMapping(
        db,
        P,
        'octocat',
        'devops'
      )

      expect(mapping).toMatchObject({
        githubHandle: 'octocat',
        persona: 'devops'
      })
      expect(mapping.updatedAt).toEqual(expect.any(String))
    })

    test('Should key the stored document on the project and lower-cased handle', async () => {
      await service.upsertPersonaMapping(db, P, 'OctoCat', 'qa')

      const stored = await db
        .collection(service.PERSONA_MAPPINGS_COLLECTION)
        .findOne({})

      expect(stored._id).toBe('alpha:octocat')
      expect(stored.projectSlug).toBe(P)
      expect(stored.githubHandle).toBe('OctoCat')
    })

    test('Should replace an existing mapping rather than duplicate it', async () => {
      await service.upsertPersonaMapping(db, P, 'octocat', 'devops')
      await service.upsertPersonaMapping(db, P, 'octocat', 'qa')

      const mappings = await service.listPersonaMappings(db, P)

      expect(mappings).toHaveLength(1)
      expect(mappings[0].persona).toBe('qa')
    })

    test('Should keep the same handle separate in two projects', async () => {
      await service.upsertPersonaMapping(db, 'alpha', 'ada', 'qa')
      await service.upsertPersonaMapping(db, 'beta', 'ada', 'devops')

      const [alpha] = await service.listPersonaMappings(db, 'alpha')
      const [beta] = await service.listPersonaMappings(db, 'beta')

      expect(alpha.persona).toBe('qa')
      expect(beta.persona).toBe('devops')
    })
  })

  describe('#listPersonaMappings', () => {
    test('Should return every mapping sorted by handle', async () => {
      await service.upsertPersonaMapping(db, P, 'zed', 'qa')
      await service.upsertPersonaMapping(db, P, 'ada', 'devops')

      const mappings = await service.listPersonaMappings(db, P)

      expect(mappings.map((m) => m.githubHandle)).toEqual(['ada', 'zed'])
    })

    test('Should return an empty array when nothing is configured', async () => {
      await expect(service.listPersonaMappings(db, P)).resolves.toEqual([])
    })

    test('Should not return another project’s mappings', async () => {
      await service.upsertPersonaMapping(db, 'beta', 'ada', 'qa')

      await expect(service.listPersonaMappings(db, P)).resolves.toEqual([])
    })

    test('Should ignore unscoped legacy rows', async () => {
      await db.collection(service.PERSONA_MAPPINGS_COLLECTION).insertMany([
        {
          _id: 'ada',
          githubHandle: 'ada',
          persona: 'qa',
          updatedAt: new Date()
        },
        {
          _id: 'bob',
          githubHandle: 'bob',
          persona: 'qa',
          updatedAt: new Date()
        }
      ])
      await service.upsertPersonaMapping(db, P, 'ada', 'devops')

      const mappings = await service.listPersonaMappings(db, P)

      expect(mappings).toEqual([
        expect.objectContaining({ githubHandle: 'ada', persona: 'devops' })
      ])
    })
  })

  describe('#deletePersonaMapping', () => {
    test('Should remove a mapping and report success', async () => {
      await service.upsertPersonaMapping(db, P, 'octocat', 'devops')

      await expect(
        service.deletePersonaMapping(db, P, 'octocat')
      ).resolves.toBe(true)
      await expect(service.listPersonaMappings(db, P)).resolves.toEqual([])
    })

    test('Should match case-insensitively', async () => {
      await service.upsertPersonaMapping(db, P, 'OctoCat', 'devops')

      await expect(
        service.deletePersonaMapping(db, P, 'octocat')
      ).resolves.toBe(true)
    })

    test('Should report false when there was nothing to delete', async () => {
      await expect(service.deletePersonaMapping(db, P, 'nobody')).resolves.toBe(
        false
      )
    })

    test('Should never delete a legacy unscoped row or another project’s row', async () => {
      await db.collection(service.PERSONA_MAPPINGS_COLLECTION).insertOne({
        _id: 'ada',
        githubHandle: 'ada',
        persona: 'qa',
        updatedAt: new Date()
      })
      await service.upsertPersonaMapping(db, 'beta', 'ada', 'devops')

      await expect(service.deletePersonaMapping(db, P, 'ada')).resolves.toBe(
        false
      )
    })
  })
})
