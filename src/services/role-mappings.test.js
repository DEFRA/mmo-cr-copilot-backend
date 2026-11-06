const ADMIN_GROUP = 'AG-Admins'
const ACTOR = { oid: 'actor-1', name: 'Actor' }

describe('#role-mappings service', () => {
  let server
  let db
  let service
  let config

  const addProject = (slug, archivedAt = null) =>
    db
      .collection('projects')
      .insertOne({ slug, name: slug, type: 'ai-adopted', archivedAt })

  const create = (input) => service.createRoleMapping(db, input, ACTOR)

  beforeAll(async () => {
    ;({ config } = await import('#/config.js'))
    const { createServer } = await import('#/server.js')
    service = await import('./role-mappings.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    vi.useRealTimers()
    await db.collection('role_mappings').deleteMany({})
    await db.collection('projects').deleteMany({})
    await db.collection('audit-logs').deleteMany({})
    service.invalidateRoleCache()
    await addProject('ALPH')
    await addProject('OLDP', new Date())
  })

  describe('#resolveUserRoles', () => {
    test('Should return nothing for no groups or no mappings', async () => {
      const empty = { roles: [], projectRoles: {}, allowedProjects: [] }

      await expect(
        service.resolveUserRoles(db, { groups: [] })
      ).resolves.toEqual(empty)
      await expect(service.resolveUserRoles(db, {})).resolves.toEqual(empty)
      await expect(
        service.resolveUserRoles(db, { groups: ['AG-Unmapped'] })
      ).resolves.toEqual(empty)
    })

    test('Should resolve project-user and project-admin mappings', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })

      await expect(
        service.resolveUserRoles(db, { groups: ['AG-U'] })
      ).resolves.toEqual({
        roles: [],
        projectRoles: { ALPH: 'project-user' },
        allowedProjects: ['ALPH']
      })

      await create({
        groupName: 'AG-A',
        role: 'project-admin',
        projectSlug: 'ALPH'
      })
      const both = await service.resolveUserRoles(db, {
        groups: ['AG-U', 'AG-A']
      })
      expect(both.projectRoles).toEqual({ ALPH: 'project-admin' })
    })

    test('Should make a dashboard admin of every active project', async () => {
      await addProject('BETA')
      await create({ groupName: ADMIN_GROUP, role: 'Dashboard.Admin' })

      const result = await service.resolveUserRoles(db, {
        groups: [ADMIN_GROUP]
      })

      expect(result.roles).toEqual(['Dashboard.Admin'])
      expect(result.allowedProjects).toEqual(['ALPH', 'BETA'])
    })

    test('Should match group names exactly, case-sensitively', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })

      const result = await service.resolveUserRoles(db, { groups: ['ag-u'] })

      expect(result.projectRoles).toEqual({})
    })

    test('Should exclude archived projects', async () => {
      await db.collection('role_mappings').insertOne({
        groupName: 'AG-Old',
        role: 'project-user',
        scope: 'project',
        projectSlug: 'OLDP'
      })

      const result = await service.resolveUserRoles(db, { groups: ['AG-Old'] })

      expect(result.allowedProjects).toEqual([])
    })

    test('Should serve repeat lookups from the cache until invalidated', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })
      const spy = vi.spyOn(db, 'collection')
      const roles = { groups: ['AG-U'] }

      await service.resolveUserRoles(db, roles)
      const afterFirst = spy.mock.calls.length
      await service.resolveUserRoles(db, { groups: ['AG-U'] })
      expect(spy.mock.calls.length).toBe(afterFirst)

      service.invalidateRoleCache()
      await service.resolveUserRoles(db, roles)
      expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)
    })

    test('Should not let a caller mutate the cached value', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })
      const first = await service.resolveUserRoles(db, { groups: ['AG-U'] })
      first.roles.push('Dashboard.Admin')

      const second = await service.resolveUserRoles(db, { groups: ['AG-U'] })

      expect(second.roles).toEqual([])
    })

    test('Should expire entries after the TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })
      await service.resolveUserRoles(db, { groups: ['AG-U'] })
      await db.collection('role_mappings').deleteMany({})

      const cached = await service.resolveUserRoles(db, { groups: ['AG-U'] })
      vi.advanceTimersByTime(config.get('auth.roleCacheTtlMs') + 1)
      const expired = await service.resolveUserRoles(db, { groups: ['AG-U'] })

      expect(cached.allowedProjects).toEqual(['ALPH'])
      expect(expired.allowedProjects).toEqual([])
    })

    test('Should evict the least recently used entry at the size limit', async () => {
      const previous = config.get('auth.roleCacheMaxEntries')
      config.set('auth.roleCacheMaxEntries', 2)
      try {
        await create({
          groupName: 'AG-1',
          role: 'project-user',
          projectSlug: 'ALPH'
        })
        await service.resolveUserRoles(db, { groups: ['AG-1'] })
        await service.resolveUserRoles(db, { groups: ['AG-2'] })
        await service.resolveUserRoles(db, { groups: ['AG-3'] })
        await db.collection('role_mappings').deleteMany({})

        // AG-1 was evicted so it is re-read; AG-3 is still cached.
        const evicted = await service.resolveUserRoles(db, { groups: ['AG-1'] })

        expect(evicted.allowedProjects).toEqual([])
      } finally {
        config.set('auth.roleCacheMaxEntries', previous)
      }
    })

    test('Should invalidate the cache on create, update and delete', async () => {
      const read = () => service.resolveUserRoles(db, { groups: ['AG-U'] })
      await read()
      const created = await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })
      expect((await read()).projectRoles).toEqual({ ALPH: 'project-user' })

      await service.updateRoleMapping(
        db,
        created.id,
        { role: 'project-admin' },
        ACTOR
      )
      expect((await read()).projectRoles).toEqual({ ALPH: 'project-admin' })

      await service.deleteRoleMapping(db, created.id, ACTOR)
      expect((await read()).projectRoles).toEqual({})
    })
  })

  describe('#createRoleMapping', () => {
    test('Should store the mapping and audit it with the actor', async () => {
      const created = await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH',
        description: 'Team'
      })

      expect(created).toMatchObject({
        groupName: 'AG-U',
        role: 'project-user',
        scope: 'project',
        projectSlug: 'ALPH',
        description: 'Team'
      })
      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'role-mapping.created' })
      expect(audit).toMatchObject({
        actor: { oid: 'actor-1' },
        entityId: created.id
      })
    })

    test('Should force a global scope and no project for Dashboard.Admin', async () => {
      const created = await create({
        groupName: ADMIN_GROUP,
        role: 'Dashboard.Admin',
        projectSlug: 'ALPH'
      })

      expect(created).toMatchObject({ scope: 'global', projectSlug: null })
    })

    test('Should reject a project role with no, unknown or archived project', async () => {
      for (const projectSlug of [undefined, 'NOPE', 'OLDP']) {
        await expect(
          create({ groupName: 'AG-U', role: 'project-user', projectSlug })
        ).rejects.toMatchObject({ output: { statusCode: 400 } })
      }
    })

    test('Should reject a duplicate group and scope with 409', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })

      await expect(
        create({
          groupName: 'AG-U',
          role: 'project-admin',
          projectSlug: 'ALPH'
        })
      ).rejects.toMatchObject({ output: { statusCode: 409 } })
    })
  })

  describe('#updateRoleMapping and #deleteRoleMapping', () => {
    test('Should audit before and after on update', async () => {
      const created = await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })

      await service.updateRoleMapping(
        db,
        created.id,
        { role: 'project-admin' },
        ACTOR
      )

      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'role-mapping.updated' })
      expect(audit.before.role).toBe('project-user')
      expect(audit.after.role).toBe('project-admin')
    })

    test('Should answer 404 for an unknown or malformed id', async () => {
      await expect(
        service.updateRoleMapping(
          db,
          '64b64b64b64b64b64b64b64b',
          { description: 'x' },
          ACTOR
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
      await expect(
        service.deleteRoleMapping(db, 'nope', ACTOR)
      ).rejects.toMatchObject({ output: { statusCode: 404 } })
    })

    test('Should refuse to demote or delete the last Dashboard Admin mapping', async () => {
      const only = await create({
        groupName: ADMIN_GROUP,
        role: 'Dashboard.Admin'
      })

      await expect(
        service.updateRoleMapping(
          db,
          only.id,
          { role: 'project-user', projectSlug: 'ALPH' },
          ACTOR
        )
      ).rejects.toMatchObject({ output: { statusCode: 409 } })
      await expect(
        service.deleteRoleMapping(db, only.id, ACTOR)
      ).rejects.toMatchObject({ output: { statusCode: 409 } })
    })

    test('Should allow removing one of two Dashboard Admin mappings', async () => {
      const first = await create({
        groupName: ADMIN_GROUP,
        role: 'Dashboard.Admin'
      })
      await create({ groupName: 'AG-Admins-2', role: 'Dashboard.Admin' })

      await expect(
        service.deleteRoleMapping(db, first.id, ACTOR)
      ).resolves.toBeUndefined()
      await expect(service.countDashboardAdminMappings(db)).resolves.toBe(1)
    })

    test('Should reject a project role without a project on update', async () => {
      const admin = await create({
        groupName: ADMIN_GROUP,
        role: 'Dashboard.Admin'
      })
      await create({ groupName: 'AG-Admins-2', role: 'Dashboard.Admin' })

      await expect(
        service.updateRoleMapping(db, admin.id, { role: 'project-user' }, ACTOR)
      ).rejects.toMatchObject({ output: { statusCode: 400 } })
    })

    test('Should turn a project mapping into an admin mapping with no project', async () => {
      const mapped = await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })

      const updated = await service.updateRoleMapping(
        db,
        mapped.id,
        { role: 'Dashboard.Admin' },
        ACTOR
      )

      expect(updated).toMatchObject({ scope: 'global', projectSlug: null })
    })
  })

  describe('#deleteMappingsForProject', () => {
    test('Should remove a project’s mappings and audit once', async () => {
      await create({
        groupName: 'AG-U',
        role: 'project-user',
        projectSlug: 'ALPH'
      })
      await create({
        groupName: 'AG-A',
        role: 'project-admin',
        projectSlug: 'ALPH'
      })

      await expect(
        service.deleteMappingsForProject(db, 'ALPH', ACTOR)
      ).resolves.toBe(2)
      await expect(
        service.deleteMappingsForProject(db, 'ALPH', ACTOR)
      ).resolves.toBe(0)
    })
  })

  describe('#ensureBootstrapAdmin', () => {
    test('Should insert the first admin mapping as the system actor', async () => {
      await expect(
        service.ensureBootstrapAdmin(db, { groupName: ADMIN_GROUP })
      ).resolves.toBe(true)

      const audit = await db
        .collection('audit-logs')
        .findOne({ action: 'role-mapping.created' })
      expect(audit.actor.oid).toBe('system')
    })

    test('Should do nothing when an admin mapping already exists', async () => {
      await create({ groupName: 'AG-Existing', role: 'Dashboard.Admin' })

      await expect(
        service.ensureBootstrapAdmin(db, { groupName: ADMIN_GROUP })
      ).resolves.toBe(false)
      await expect(service.countDashboardAdminMappings(db)).resolves.toBe(1)
    })

    test('Should do nothing when no group is configured', async () => {
      await expect(
        service.ensureBootstrapAdmin(db, { groupName: '  ' })
      ).resolves.toBe(false)
      await expect(service.ensureBootstrapAdmin(db)).resolves.toBe(false)
    })
  })
})
