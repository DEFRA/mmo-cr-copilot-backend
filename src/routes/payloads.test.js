import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_ADMIN,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'
import { buildPayload, buildPayloadV2 } from '#/test-helpers/payload-fixture.js'

const INGEST_TOKEN = 'test-ingest-token'

describe('#payloads routes', () => {
  let server
  let collection
  let admin
  let projectAdmin
  let projectUser
  let outsider

  beforeAll(async () => {
    process.env.INGEST_TOKEN = INGEST_TOKEN

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    const { PAYLOADS_COLLECTION } = await import('#/services/payloads.js')

    server = await createServer()
    await server.initialize()
    collection = server.db.collection(PAYLOADS_COLLECTION)
    ;[admin, projectAdmin, projectUser, outsider] = await Promise.all(
      [ADMIN, PROJECT_ADMIN, PROJECT_USER, OUTSIDER].map(asUser)
    )
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.INGEST_TOKEN
  })

  beforeEach(async () => {
    await collection.deleteMany({})
    await server.db.collection('audit-logs').deleteMany({})
    await server.db.collection('projects').deleteMany({})
    await server.db.collection('repositories').deleteMany({})
    await server.db.collection('projects').insertOne({
      slug: 'ALPH',
      name: 'Alpha',
      type: 'ai-adopted',
      archivedAt: null
    })
    await server.db.collection('role_mappings').deleteMany({})
    await grantAccess(server.db, 'ALPH')
    await server.db.collection('repositories').insertOne({
      fullName: 'DEFRA/mmo-cr-copilot-dashboard',
      projectSlug: 'ALPH'
    })
  })

  const post = (payload, headers = { 'x-ingest-token': INGEST_TOKEN }) =>
    server.inject({
      method: 'POST',
      url: '/api/payloads',
      headers,
      payload
    })

  describe('POST /api/payloads', () => {
    test('Should store a valid payload', async () => {
      const { statusCode, result } = await post(buildPayload())

      expect(statusCode).toBe(201)
      expect(result).toEqual({
        status: 'stored',
        repository: 'DEFRA/mmo-cr-copilot-dashboard',
        prNumber: 42
      })
      await expect(collection.countDocuments()).resolves.toBe(1)
    })

    test('Should reject a request without the ingest token', async () => {
      const { statusCode } = await post(buildPayload(), {})

      expect(statusCode).toBe(401)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should reject a request with the wrong ingest token', async () => {
      const { statusCode } = await post(buildPayload(), {
        'x-ingest-token': 'not-the-token'
      })

      expect(statusCode).toBe(401)
    })

    test('Should reject a payload that fails validation', async () => {
      const { statusCode } = await post(buildPayload({ prNumber: 0 }))

      expect(statusCode).toBe(400)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should strip unknown keys rather than reject the payload', async () => {
      const { statusCode } = await post(buildPayload({ injected: true }))

      expect(statusCode).toBe(201)

      const stored = await collection.findOne({})

      expect(stored).not.toHaveProperty('injected')
    })

    test('Should store a v1 payload as schemaVersion 1', async () => {
      const { statusCode } = await post(buildPayload())

      expect(statusCode).toBe(201)
      await expect(collection.findOne({})).resolves.toMatchObject({
        schemaVersion: 1
      })
    })

    test('Should store a valid v2 payload', async () => {
      const { statusCode } = await post(buildPayloadV2())

      expect(statusCode).toBe(201)
      await expect(collection.findOne({})).resolves.toMatchObject({
        schemaVersion: 2,
        jiraKeys: ['MMO-123']
      })
    })

    test('Should reject an invalid v2 payload', async () => {
      const { statusCode } = await post(buildPayloadV2({ jiraKeys: ['abc-1'] }))

      expect(statusCode).toBe(400)
      await expect(collection.countDocuments()).resolves.toBe(0)
    })

    test('Should reject an unknown schemaVersion', async () => {
      const { statusCode } = await post(buildPayloadV2({ schemaVersion: 3 }))

      expect(statusCode).toBe(400)
    })

    test('Should reject a body over the size cap', async () => {
      const { config } = await import('#/config.js')
      const oversized = JSON.stringify({
        padding: 'x'.repeat(config.get('ingest.maxPayloadBytes'))
      })

      const { statusCode } = await server.inject({
        method: 'POST',
        url: '/api/payloads',
        headers: {
          'x-ingest-token': INGEST_TOKEN,
          'content-type': 'application/json'
        },
        payload: oversized
      })

      expect(statusCode).toBe(413)
    })

    test('Should log the schema version but never the title or Jira keys', async () => {
      const { payloads: routes } = await import('./payloads.js')
      const ingest = routes.find(
        (route) => route.method === 'POST' && route.path === '/api/payloads'
      )
      const logger = { info: vi.fn(), warn: vi.fn() }
      const payload = buildPayloadV2({
        prTitle: 'SECRET-TITLE',
        jiraKeys: ['LEAK-7']
      })
      const h = { response: () => ({ code: () => undefined }) }

      await ingest.handler({ db: server.db, payload, logger }, h)

      const logged = JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls
      ])

      expect(logged).toContain('schemaVersion=2')
      expect(logged).not.toContain('SECRET-TITLE')
      expect(logged).not.toContain('LEAK-7')
    })
  })

  describe('GET /api/payloads', () => {
    test('Should no longer serve an unscoped list of every payload', async () => {
      const { statusCode } = await server.inject({
        url: '/api/payloads',
        headers: admin
      })

      expect(statusCode).toBe(404)
    })
  })

  describe('GET /api/payloads/{repository}/{prNumber}', () => {
    const history = (url, headers = projectUser) =>
      server.inject({ url, headers })

    test('Should return the current record for a PR', async () => {
      await post(buildPayload({ buildId: 'first' }))
      await post(
        buildPayload({
          buildId: 'second',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        })
      )

      const { statusCode, result } = await history(
        '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42'
      )

      expect(statusCode).toBe(200)
      expect(result.repository).toBe('DEFRA/mmo-cr-copilot-dashboard')
      expect(result.prNumber).toBe(42)
      expect(result.payloads.map((payload) => payload.buildId)).toEqual([
        'second'
      ])
    })

    test('Should return the v2 fields of a stored payload', async () => {
      const payload = buildPayloadV2()
      await post(payload)

      const { result } = await history(
        `/api/payloads/${encodeURIComponent(payload.repository)}/${payload.prNumber}`,
        admin
      )

      expect(result.payloads[0]).toMatchObject({
        schemaVersion: 2,
        source: payload.source,
        prTitle: payload.prTitle,
        jiraKeys: payload.jiraKeys,
        files: payload.files
      })
      expect(result.payloads[0].commitBreakdown[0].attribution).toEqual(
        payload.commitBreakdown[0].attribution
      )
    })

    test('Should hide a mapped repository from someone with no role on its project', async () => {
      const { statusCode } = await history(
        '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42',
        outsider
      )

      expect(statusCode).toBe(404)
    })

    test('Should keep an unmapped repository to dashboard admins', async () => {
      const asProjectUser = await history('/api/payloads/DEFRA%2Funknown/7')
      const asAdmin = await history('/api/payloads/DEFRA%2Funknown/7', admin)

      expect(asProjectUser.statusCode).toBe(404)
      expect(asAdmin.statusCode).toBe(200)
      expect(asAdmin.result.payloads).toEqual([])
    })

    test('Should reject a request with no signed context', async () => {
      const { statusCode } = await server.inject(
        '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42'
      )

      expect(statusCode).toBe(401)
    })

    test('Should reject a non-numeric PR number', async () => {
      const { statusCode } = await history(
        '/api/payloads/DEFRA%2Frepo/not-a-number'
      )

      expect(statusCode).toBe(400)
    })

    test('Should reject a PR number below one', async () => {
      const { statusCode } = await history('/api/payloads/DEFRA%2Frepo/0')

      expect(statusCode).toBe(400)
    })
  })

  describe('PATCH /api/payloads/{repository}/{prNumber}/commits/{commit}', () => {
    const BASE_URL =
      '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42/commits/abc1234'

    const patch = (payload, url = BASE_URL, headers = projectAdmin) =>
      server.inject({ method: 'PATCH', url, payload, headers })

    test('Should reject a request with missing user context', async () => {
      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        BASE_URL,
        {}
      )

      expect(statusCode).toBe(401)
    })

    test('Should forbid a project user', async () => {
      await post(buildPayload())

      const { statusCode, result } = await patch(
        { classification: 'Human-authored' },
        BASE_URL,
        projectUser
      )

      expect(statusCode).toBe(403)
      expect(result.message).toMatch(/Project admin role required/)
    })

    test('Should hide the PR from someone with no role on its project', async () => {
      await post(buildPayload())

      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        BASE_URL,
        outsider
      )

      expect(statusCode).toBe(404)
    })

    test('Should let a dashboard admin re-classify', async () => {
      await post(buildPayload())

      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        BASE_URL,
        admin
      )

      expect(statusCode).toBe(200)
    })

    test('Should re-classify as a project admin and audit the actor and project', async () => {
      await post(buildPayload())

      const { statusCode, result } = await patch({
        classification: 'Human-authored'
      })

      expect(statusCode).toBe(200)
      expect(result.status).toBe('updated')
      expect(result.payload.commitBreakdown[0].classification).toBe(
        'Human-authored'
      )
      expect(result.payload.summary.copilotAssistedCommits).toBe(0)

      const auditLog = await server.db
        .collection('audit-logs')
        .findOne({ entityId: 'DEFRA/mmo-cr-copilot-dashboard#42@abc1234' })

      expect(auditLog).toMatchObject({
        projectSlug: 'ALPH',
        actor: { oid: PROJECT_ADMIN.oid, name: PROJECT_ADMIN.name }
      })
    })

    test('Should reject a PR that is not merged', async () => {
      const payload = buildPayload()
      delete payload.prMergedAt
      await post(payload)

      const { statusCode, result } = await patch({
        classification: 'Human-authored'
      })

      expect(statusCode).toBe(409)
      expect(result.message).toMatch(/not merged/)
    })

    test('Should return 404 for an unknown PR', async () => {
      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        '/api/payloads/DEFRA%2Funknown/7/commits/abc1234',
        admin
      )

      expect(statusCode).toBe(404)
    })

    test('Should return 404 for an unknown commit', async () => {
      await post(buildPayload())

      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42/commits/ffffff0'
      )

      expect(statusCode).toBe(404)
    })

    test('Should reject an unknown classification', async () => {
      await post(buildPayload())

      const { statusCode } = await patch({ classification: 'Vibes' })

      expect(statusCode).toBe(400)
    })

    test('Should reject a commit that is not a SHA', async () => {
      const { statusCode } = await patch(
        { classification: 'Human-authored' },
        '/api/payloads/DEFRA%2Frepo/42/commits/not-a-sha'
      )

      expect(statusCode).toBe(400)
    })
  })
})
