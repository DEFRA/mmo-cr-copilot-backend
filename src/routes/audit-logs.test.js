import { buildPayload } from '#/test-helpers/payload-fixture.js'

describe('#audit-logs routes', () => {
  let server
  let db
  let AUDIT_LOGS_COLLECTION

  beforeAll(async () => {
    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    ;({ AUDIT_LOGS_COLLECTION } = await import('#/services/audit-logs.js'))
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    await db.collection(AUDIT_LOGS_COLLECTION).deleteMany({})
    await db.collection('payloads').deleteMany({})
    await db.collection('persona-mappings').deleteMany({})
  })

  test('Should return an empty first page when nothing is audited', async () => {
    const { statusCode, result } = await server.inject('/api/audit-logs')

    expect(statusCode).toBe(200)
    expect(result).toMatchObject({ entries: [], total: 0, page: 1 })
  })

  test('Should record a persona mapping being assigned and then changed', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/persona-mappings/octocat',
      payload: { persona: 'devops' }
    })
    await server.inject({
      method: 'PUT',
      url: '/api/persona-mappings/octocat',
      payload: { persona: 'qa' }
    })

    const { result } = await server.inject('/api/audit-logs')

    expect(result.total).toBe(2)
    expect(result.entries[0]).toMatchObject({
      action: 'persona-mapping.upserted',
      entityId: 'octocat',
      before: { persona: 'devops' },
      after: { persona: 'qa' },
      actor: 'dashboard'
    })
    expect(result.entries[1]).toMatchObject({ before: null })
  })

  test('Should record a persona mapping being removed', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/persona-mappings/octocat',
      payload: { persona: 'qa' }
    })
    await server.inject({
      method: 'DELETE',
      url: '/api/persona-mappings/octocat'
    })

    const { result } = await server.inject('/api/audit-logs')

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
      url: '/api/persona-mappings/nobody'
    })

    const { result } = await server.inject('/api/audit-logs')

    expect(result.total).toBe(0)
  })

  test('Should record a commit re-classification', async () => {
    await db.collection('payloads').insertOne({
      ...buildPayload(),
      prMergedAt: new Date('2026-01-15T10:15:00.000Z')
    })

    await server.inject({
      method: 'PATCH',
      url: '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42/commits/abc1234',
      payload: { classification: 'Human-authored' }
    })

    const { result } = await server.inject('/api/audit-logs')

    expect(result.entries[0]).toMatchObject({
      action: 'commit-classification.updated',
      entity: 'commit-classification',
      entityId: 'DEFRA/mmo-cr-copilot-dashboard#42@abc1234',
      before: { classification: 'Copilot-assisted' },
      after: { classification: 'Human-authored' }
    })
  })

  test('Should page the trail and report the total', async () => {
    for (const persona of ['developer', 'devops', 'qa']) {
      await server.inject({
        method: 'PUT',
        url: '/api/persona-mappings/octocat',
        payload: { persona }
      })
    }

    const { result } = await server.inject('/api/audit-logs?page=2&pageSize=2')

    expect(result).toMatchObject({ page: 2, pageSize: 2, total: 3 })
    expect(result.entries).toHaveLength(1)
  })

  test('Should reject a window whose end is not after its start', async () => {
    const { statusCode } = await server.inject(
      '/api/audit-logs?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z'
    )

    expect(statusCode).toBe(400)
  })

  test('Should reject a page size beyond the cap', async () => {
    const { statusCode } = await server.inject('/api/audit-logs?pageSize=5000')

    expect(statusCode).toBe(400)
  })
})
