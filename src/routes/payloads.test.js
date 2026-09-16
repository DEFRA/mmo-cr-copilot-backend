import { buildPayload } from '#/test-helpers/payload-fixture.js'

const INGEST_TOKEN = 'test-ingest-token'

describe('#payloads routes', () => {
  let server
  let collection

  beforeAll(async () => {
    process.env.INGEST_TOKEN = INGEST_TOKEN

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')
    const { PAYLOADS_COLLECTION } = await import('#/services/payloads.js')

    server = await createServer()
    await server.initialize()
    collection = server.db.collection(PAYLOADS_COLLECTION)
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.INGEST_TOKEN
  })

  beforeEach(async () => {
    await collection.deleteMany({})
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
  })

  describe('GET /api/payloads', () => {
    test('Should return the latest payload per PR', async () => {
      await post(buildPayload({ buildId: 'old' }))
      await post(
        buildPayload({
          buildId: 'new',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        })
      )

      const { statusCode, result } = await server.inject('/api/payloads')

      expect(statusCode).toBe(200)
      expect(result.payloads).toHaveLength(1)
      expect(result.payloads[0].buildId).toBe('new')
    })

    test('Should return an empty list when nothing is stored', async () => {
      const { statusCode, result } = await server.inject('/api/payloads')

      expect(statusCode).toBe(200)
      expect(result).toEqual({ payloads: [] })
    })

    test('Should not require the ingest token to read', async () => {
      const { statusCode } = await server.inject('/api/payloads')

      expect(statusCode).toBe(200)
    })
  })

  describe('GET /api/payloads/{repository}/{prNumber}', () => {
    test('Should return the current record for a PR', async () => {
      await post(buildPayload({ buildId: 'first' }))
      await post(
        buildPayload({
          buildId: 'second',
          calculatedAt: '2026-01-16T10:00:00.000Z'
        })
      )

      const { statusCode, result } = await server.inject(
        '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42'
      )

      expect(statusCode).toBe(200)
      expect(result.repository).toBe('DEFRA/mmo-cr-copilot-dashboard')
      expect(result.prNumber).toBe(42)
      expect(result.payloads.map((payload) => payload.buildId)).toEqual([
        'second'
      ])
    })

    test('Should return an empty history for an unknown PR', async () => {
      const { statusCode, result } = await server.inject(
        '/api/payloads/DEFRA%2Funknown/7'
      )

      expect(statusCode).toBe(200)
      expect(result.payloads).toEqual([])
    })

    test('Should reject a non-numeric PR number', async () => {
      const { statusCode } = await server.inject(
        '/api/payloads/DEFRA%2Frepo/not-a-number'
      )

      expect(statusCode).toBe(400)
    })

    test('Should reject a PR number below one', async () => {
      const { statusCode } = await server.inject('/api/payloads/DEFRA%2Frepo/0')

      expect(statusCode).toBe(400)
    })
  })

  describe('PATCH /api/payloads/{repository}/{prNumber}/commits/{commit}', () => {
    const BASE_URL =
      '/api/payloads/DEFRA%2Fmmo-cr-copilot-dashboard/42/commits/abc1234'

    const patch = (payload, url = BASE_URL) =>
      server.inject({ method: 'PATCH', url, payload })

    test('Should re-classify a commit on a merged PR', async () => {
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
        '/api/payloads/DEFRA%2Funknown/7/commits/abc1234'
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
