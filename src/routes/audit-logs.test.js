import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'
import { buildPayload } from '#/test-helpers/payload-fixture.js'

describe('#audit-logs routes', () => {
  let server
  let db
  let AUDIT_LOGS_COLLECTION
  let admin
  let projectAdmin
  let projectUser
  let outsider

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ AUDIT_LOGS_COLLECTION } = await import('#/services/audit-logs.js'))
    server = await createServer()
    await server.initialize()
    db = server.db
    ;[admin, projectAdmin, projectUser, outsider] = await Promise.all(
      [ADMIN, PROJECT_ADMIN, PROJECT_USER, OUTSIDER].map(asUser)
    )
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(AUDIT_LOGS_COLLECTION).deleteMany({})
    await db.collection('payloads').deleteMany({})
    await db.collection('persona-mappings').deleteMany({})
    await db.collection('repositories').deleteMany({})
    await db.collection('projects').deleteMany({})
    await db.collection('projects').insertMany(
      ['ALPH', 'BETA'].map((slug) => ({
        slug,
        name: slug,
        type: 'ai-adopted',
        archivedAt: null
      }))
    )
    await db.collection('role_mappings').deleteMany({})
    await grantAccess(db, 'ALPH')
    await grantAccess(db, 'BETA')
  })

  const mapPersona = (persona, handle = 'octocat', slug = 'ALPH') =>
    server.inject({
      method: 'PUT',
      url: `/api/projects/${slug}/persona-mappings/${handle}`,
      headers: projectAdmin,
      payload: { persona }
    })

  const projectLog = (query = '', headers = projectUser, slug = 'ALPH') =>
    server.inject({
      url: `/api/projects/${slug}/audit-logs${query}`,
      headers
    })

  test('Should return an empty first page when nothing is audited', async () => {
    const { statusCode, result } = await projectLog()

    expect(statusCode).toBe(200)
    expect(result).toMatchObject({ entries: [], total: 0, page: 1 })
  })

  test('Should record a persona mapping being assigned and then changed, with the actor and project', async () => {
    await mapPersona('devops')
    await mapPersona('qa')

    const { result } = await projectLog()

    expect(result.total).toBe(2)
    expect(result.entries[0]).toMatchObject({
      action: 'persona-mapping.upserted',
      entityId: 'octocat',
      projectSlug: 'ALPH',
      before: { persona: 'devops' },
      after: { persona: 'qa' },
      actor: { oid: PROJECT_ADMIN.oid, name: PROJECT_ADMIN.name }
    })
    expect(result.entries[1]).toMatchObject({ before: null })
  })

  test('Should record a persona mapping being removed', async () => {
    await mapPersona('qa')
    await server.inject({
      method: 'DELETE',
      url: '/api/projects/ALPH/persona-mappings/octocat',
      headers: projectAdmin
    })

    const { result } = await projectLog()

    expect(result.entries[0]).toMatchObject({
      action: 'persona-mapping.deleted',
      entityId: 'octocat',
      before: { persona: 'qa' },
      after: null
    })
  })

  test('Should not audit a delete that matched nothing', async () => {
    await server.inject({
      method: 'DELETE',
      url: '/api/projects/ALPH/persona-mappings/nobody',
      headers: projectAdmin
    })

    const { result } = await projectLog()

    expect(result.total).toBe(0)
  })

  test('Should record a commit re-classification against the repository’s project', async () => {
    await db.collection('repositories').insertOne({
      fullName: 'DEFRA/mmo-cr-copilot-dashboard',
      projectSlug: 'ALPH'
    })
    await db.collection('payloads').insertOne({
      ...buildPayload(),
      prMergedAt: new Date('2026-01-15T10:15:00.000Z')
    })

    await server.inject({
      method: 'PATCH',
      url: '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42/commits/abc1234',
      headers: projectAdmin,
      payload: { classification: 'Human-authored' }
    })

    const { result } = await projectLog()

    expect(result.entries[0]).toMatchObject({
      action: 'commit-classification.updated',
      entity: 'commit-classification',
      entityId: 'DEFRA/mmo-cr-copilot-dashboard#42@abc1234',
      projectSlug: 'ALPH',
      before: { classification: 'Copilot-assisted' },
      after: { classification: 'Human-authored' }
    })
  })

  test('Should page the trail and report the total', async () => {
    for (const persona of ['developer', 'devops', 'qa']) {
      await mapPersona(persona)
    }

    const { result } = await projectLog('?page=2&pageSize=2')

    expect(result).toMatchObject({ page: 2, pageSize: 2, total: 3 })
    expect(result.entries).toHaveLength(1)
  })

  test('Should keep one project’s trail out of another’s', async () => {
    await mapPersona('qa', 'octocat', 'ALPH')

    const { result } = await projectLog('', admin, 'BETA')

    expect(result.total).toBe(0)
  })

  test('Should hide a project’s trail from someone with no role on it', async () => {
    const { statusCode } = await projectLog('', outsider)

    expect(statusCode).toBe(404)
  })

  test('Should show the whole trail to a dashboard admin only', async () => {
    await mapPersona('qa')

    const asAdmin = await server.inject({
      url: '/api/audit-logs',
      headers: admin
    })
    const asProjectAdmin = await server.inject({
      url: '/api/audit-logs',
      headers: projectAdmin
    })

    expect(asAdmin.result.total).toBe(1)
    expect(asProjectAdmin.statusCode).toBe(403)
  })

  test('Should reject a window whose end is not after its start', async () => {
    const { statusCode } = await projectLog(
      '?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'
    )

    expect(statusCode).toBe(400)
  })

  test('Should reject a page size beyond the cap', async () => {
    const { statusCode } = await projectLog('?pageSize=5000')

    expect(statusCode).toBe(400)
  })
})
