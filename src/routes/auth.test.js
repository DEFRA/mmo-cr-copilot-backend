import {
  ADMIN,
  OUTSIDER,
  PROJECT_USER,
  asUser,
  devToken,
  grantAccess
} from '#/test-helpers/auth-headers.js'

describe('#auth routes', () => {
  let server
  let db

  beforeAll(async () => {
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection('role_mappings').deleteMany({})
    await db.collection('projects').deleteMany({})
    await db.collection('projects').insertMany([
      { slug: 'ALPH', name: 'Alpha', type: 'ai-adopted', archivedAt: null },
      { slug: 'BETA', name: 'Beta', type: 'ai-native', archivedAt: null },
      { slug: 'OLDP', name: 'Old', type: 'ai-native', archivedAt: new Date() }
    ])
    await grantAccess(db, 'ALPH')
  })

  const authorize = (headers) =>
    server.inject({ method: 'POST', url: '/api/auth/authorize', headers })
  const me = (headers) => server.inject({ url: '/api/auth/me', headers })

  test('Should answer 401 without a token or with an invalid one', async () => {
    expect((await authorize()).statusCode).toBe(401)
    expect(
      (await authorize({ authorization: 'Bearer nonsense' })).statusCode
    ).toBe(401)
    expect((await me()).statusCode).toBe(401)
  })

  test('Should answer 403 when the group overage claim is present', async () => {
    const headers = {
      authorization: `Bearer ${devToken({ oid: 'u1', hasgroups: true })}`
    }

    expect((await authorize(headers)).statusCode).toBe(403)
  })

  test('Should answer 403 when no role mapping applies', async () => {
    expect((await authorize(asUser(OUTSIDER))).statusCode).toBe(403)
  })

  test('Should return the project user’s roles without the groups', async () => {
    const { statusCode, result } = await authorize(asUser(PROJECT_USER))

    expect(statusCode).toBe(200)
    expect(result).toEqual({
      user: {
        oid: PROJECT_USER.oid,
        tid: 'dev-tenant',
        name: 'Project User',
        email: undefined,
        roles: [],
        projectRoles: { ALPH: 'project-user' },
        allowedProjects: ['ALPH']
      }
    })
    expect(JSON.stringify(result)).not.toContain('groups')
  })

  test('Should give a dashboard admin every non-archived project', async () => {
    const { statusCode, result } = await authorize(asUser(ADMIN))

    expect(statusCode).toBe(200)
    expect(result.user.roles).toEqual(['Dashboard.Admin'])
    expect(result.user.allowedProjects).toEqual(['ALPH', 'BETA'])
  })

  test('Should return /api/auth/me with 200 even when the caller has no roles', async () => {
    const { statusCode, result } = await me(asUser(OUTSIDER))

    expect(statusCode).toBe(200)
    expect(result.user).toMatchObject({
      oid: OUTSIDER.oid,
      roles: [],
      projectRoles: {},
      allowedProjects: []
    })
  })
})
