import {
  ADMIN,
  DASHBOARD_ADMIN_GROUP,
  OUTSIDER,
  PROJECT_ADMIN,
  asUser,
  grantAccess
} from '#/test-helpers/auth-headers.js'

describe('#role-mappings routes', () => {
  let server
  let db
  let admin
  let projectAdmin
  let outsider

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
    ;[admin, projectAdmin, outsider] = [ADMIN, PROJECT_ADMIN, OUTSIDER].map(
      asUser
    )
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection('role_mappings').deleteMany({})
    await db.collection('projects').deleteMany({})
    await db.collection('audit-logs').deleteMany({})
    await db.collection('projects').insertMany([
      { slug: 'ALPH', name: 'Alpha', type: 'ai-adopted', archivedAt: null },
      { slug: 'BETA', name: 'Beta', type: 'ai-adopted', archivedAt: null }
    ])
    await grantAccess(db, 'ALPH')
  })

  const call = (method, url, headers, payload) =>
    server.inject({ method, url, headers, payload })
  const post = (payload, headers = admin) =>
    call('POST', '/api/role-mappings', headers, payload)

  test('Should answer 401 with a challenge when there is no token', async () => {
    const { statusCode, headers } = await call('GET', '/api/role-mappings')

    expect(statusCode).toBe(401)
    expect(headers['www-authenticate']).toMatch(/^Bearer/)
  })

  test('Should forbid everyone but a dashboard admin, including reads', async () => {
    for (const headers of [projectAdmin, outsider]) {
      expect(
        (await call('GET', '/api/role-mappings', headers)).statusCode
      ).toBe(403)
      expect(
        (
          await post(
            { groupName: 'AG-X', role: 'project-user', projectSlug: 'ALPH' },
            headers
          )
        ).statusCode
      ).toBe(403)
    }
  })

  test('Should list mappings, optionally by project', async () => {
    const all = await call('GET', '/api/role-mappings', admin)
    const alpha = await call(
      'GET',
      '/api/role-mappings?projectSlug=ALPH',
      admin
    )
    const beta = await call('GET', '/api/role-mappings?projectSlug=BETA', admin)

    expect(all.result.roleMappings.map((m) => m.groupName)).toContain(
      DASHBOARD_ADMIN_GROUP
    )
    expect(alpha.result.roleMappings).toHaveLength(2)
    expect(beta.result.roleMappings).toEqual([])
    expect(
      (await call('GET', '/api/role-mappings?projectSlug=bad', admin))
        .statusCode
    ).toBe(400)
  })

  test('Should create a mapping with 201 and audit the actor', async () => {
    const { statusCode, result } = await post({
      groupName: '  AG-New Team  ',
      role: 'project-user',
      projectSlug: 'BETA',
      description: 'Beta readers'
    })

    expect(statusCode).toBe(201)
    expect(result.roleMapping).toMatchObject({
      groupName: 'AG-New Team',
      role: 'project-user',
      scope: 'project',
      projectSlug: 'BETA'
    })
    expect(result.roleMapping.id).toMatch(/^[a-f0-9]{24}$/)
    const audit = await db
      .collection('audit-logs')
      .findOne({ action: 'role-mapping.created' })
    expect(audit.actor.oid).toBe(ADMIN.oid)
  })

  test.each([
    [
      'an empty group name',
      { groupName: '', role: 'project-user', projectSlug: 'ALPH' }
    ],
    [
      'an unknown role',
      { groupName: 'AG-X', role: 'owner', projectSlug: 'ALPH' }
    ],
    [
      'a project role with no project',
      { groupName: 'AG-X', role: 'project-user' }
    ],
    [
      'an unknown project',
      { groupName: 'AG-X', role: 'project-user', projectSlug: 'NOPE' }
    ],
    [
      'a malformed slug',
      { groupName: 'AG-X', role: 'project-user', projectSlug: 'a' }
    ]
  ])('Should reject %s with 400', async (_, payload) => {
    expect((await post(payload)).statusCode).toBe(400)
  })

  test('Should answer 409 for a duplicate', async () => {
    const payload = {
      groupName: 'AG-Dup',
      role: 'project-user',
      projectSlug: 'BETA'
    }
    await post(payload)

    expect((await post(payload)).statusCode).toBe(409)
  })

  test('Should update a mapping and audit before and after', async () => {
    const { result } = await post({
      groupName: 'AG-U',
      role: 'project-user',
      projectSlug: 'BETA'
    })

    const patched = await call(
      'PATCH',
      `/api/role-mappings/${result.roleMapping.id}`,
      admin,
      {
        role: 'project-admin'
      }
    )

    expect(patched.statusCode).toBe(200)
    expect(patched.result.roleMapping.role).toBe('project-admin')
    const audit = await db
      .collection('audit-logs')
      .findOne({ action: 'role-mapping.updated' })
    expect(audit).toMatchObject({
      before: { role: 'project-user' },
      after: { role: 'project-admin' }
    })
  })

  test('Should reject an empty or group-changing PATCH and a bad id', async () => {
    const { result } = await post({
      groupName: 'AG-U',
      role: 'project-user',
      projectSlug: 'BETA'
    })
    const url = `/api/role-mappings/${result.roleMapping.id}`

    expect((await call('PATCH', url, admin, {})).statusCode).toBe(400)
    expect(
      (await call('PATCH', url, admin, { groupName: 'AG-Other' })).statusCode
    ).toBe(400)
    expect(
      (
        await call('PATCH', '/api/role-mappings/xyz', admin, {
          role: 'project-user'
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await call(
          'PATCH',
          '/api/role-mappings/64b64b64b64b64b64b64b64b',
          admin,
          { description: 'x' }
        )
      ).statusCode
    ).toBe(404)
  })

  test('Should delete with 204 and refuse to delete the last admin mapping', async () => {
    const { result } = await post({
      groupName: 'AG-U',
      role: 'project-user',
      projectSlug: 'BETA'
    })
    const adminMapping = await db
      .collection('role_mappings')
      .findOne({ role: 'Dashboard.Admin' })

    const removed = await call(
      'DELETE',
      `/api/role-mappings/${result.roleMapping.id}`,
      admin
    )
    const last = await call(
      'DELETE',
      `/api/role-mappings/${adminMapping._id}`,
      admin
    )
    const demote = await call(
      'PATCH',
      `/api/role-mappings/${adminMapping._id}`,
      admin,
      {
        role: 'project-user',
        projectSlug: 'ALPH'
      }
    )

    expect(removed.statusCode).toBe(204)
    expect(last.statusCode).toBe(409)
    expect(demote.statusCode).toBe(409)
  })

  test('Should apply a new mapping on that group member’s next request', async () => {
    const beforeMapping = await call('GET', '/api/projects/BETA', projectAdmin)
    await post({
      groupName: 'AG-Test-Project-Admin',
      role: 'project-admin',
      projectSlug: 'BETA'
    })
    const afterMapping = await call('GET', '/api/projects/BETA', projectAdmin)

    expect(beforeMapping.statusCode).toBe(404)
    expect(afterMapping.statusCode).toBe(200)
  })
})
