const INGEST_TOKEN = 'test-ingest-token'
const SHA = 'a'.repeat(40)

const buildSurvival = (overrides = {}) => ({
  kind: 'ai-survival',
  schemaVersion: 1,
  repository: 'DEFRA/mmo-cr-copilot-dashboard',
  prNumber: 42,
  mergeCommitSha: SHA,
  mergedAt: '2026-05-01T09:00:00Z',
  windowDays: 21,
  measuredAt: '2026-05-22T03:17:00Z',
  measuredCommitSha: 'b'.repeat(40),
  aiLinesMerged: 100,
  aiLinesSurviving: 80,
  humanLinesMerged: 50,
  humanLinesSurviving: 45,
  byOrigin: {
    aiAgent: { merged: 60, surviving: 50 },
    aiCompletion: { merged: 30, surviving: 25 },
    aiChat: { merged: 10, surviving: 5 }
  },
  files: [],
  metadataSchemas: ['ai-attribution/2'],
  calculatedAt: '2026-05-22T03:18:00Z',
  ...overrides
})

describe('#survival route', () => {
  let server
  let collection

  beforeAll(async () => {
    process.env.INGEST_TOKEN = INGEST_TOKEN
    const { createServer } = await import('#/server.js')
    const { SURVIVAL_COLLECTION } = await import('#/services/survival.js')

    server = await createServer()
    await server.initialize()
    collection = server.db.collection(SURVIVAL_COLLECTION)
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.INGEST_TOKEN
  })

  beforeEach(async () => {
    await collection.deleteMany({})
    await server.db.collection('repositories').deleteMany({})
    await server.db.collection('repositories').insertOne({
      fullName: 'DEFRA/mmo-cr-copilot-dashboard',
      projectSlug: 'ALPH'
    })
  })

  const post = (payload, headers = { 'x-ingest-token': INGEST_TOKEN }) =>
    server.inject({ method: 'POST', url: '/api/survival', headers, payload })

  test('Should store a record with its project and BSON dates', async () => {
    const { statusCode, result } = await post(buildSurvival())

    expect(statusCode).toBe(201)
    expect(result).toEqual({
      status: 'created',
      repository: 'DEFRA/mmo-cr-copilot-dashboard',
      prNumber: 42,
      windowDays: 21
    })
    const stored = await collection.findOne({})
    expect(stored).toMatchObject({ projectSlug: 'ALPH', aiLinesSurviving: 80 })
    expect(stored.mergedAt).toEqual(new Date('2026-05-01T09:00:00Z'))
    expect(stored.measuredAt).toBeInstanceOf(Date)
  })

  test('Should store a record for an unmapped repository without a project', async () => {
    await post(buildSurvival({ repository: 'DEFRA/unmapped' }))

    expect((await collection.findOne({})).projectSlug).toBeNull()
  })

  test('Should replace the record only when the measurement is newer', async () => {
    await post(buildSurvival())

    const newer = await post(
      buildSurvival({
        measuredAt: '2026-05-23T03:17:00Z',
        aiLinesSurviving: 70
      })
    )
    const older = await post(
      buildSurvival({
        measuredAt: '2026-05-20T03:17:00Z',
        aiLinesSurviving: 10
      })
    )
    const same = await post(buildSurvival({ aiLinesSurviving: 1 }))

    expect(newer.statusCode).toBe(200)
    expect(newer.result.status).toBe('updated')
    expect(older.statusCode).toBe(200)
    expect(older.result.status).toBe('stale')
    expect(same.result.status).toBe('stale')
    await expect(collection.countDocuments()).resolves.toBe(1)
    expect((await collection.findOne({})).aiLinesSurviving).toBe(70)
  })

  test('Should keep one record per window', async () => {
    await post(buildSurvival({ windowDays: 21 }))
    await post(buildSurvival({ windowDays: 7 }))

    await expect(collection.countDocuments()).resolves.toBe(2)
  })

  test('Should reject a request without or with a wrong ingest token', async () => {
    expect((await post(buildSurvival(), {})).statusCode).toBe(401)
    expect(
      (await post(buildSurvival(), { 'x-ingest-token': 'wrong' })).statusCode
    ).toBe(401)
    await expect(collection.countDocuments()).resolves.toBe(0)
  })

  test('Should reject an invalid record with 400', async () => {
    const { statusCode } = await post(buildSurvival({ aiLinesSurviving: 999 }))

    expect(statusCode).toBe(400)
    await expect(collection.countDocuments()).resolves.toBe(0)
  })

  test('Should reject a payload over the size cap', async () => {
    const response = await post(buildSurvival({ padding: 'x'.repeat(300_000) }))

    expect(response.statusCode).toBe(413)
  })

  test('Should create the unique index that makes ingest idempotent', async () => {
    const indexes = await collection.indexes()

    expect(
      indexes.some(
        (index) =>
          index.unique &&
          JSON.stringify(index.key) ===
            JSON.stringify({ repository: 1, prNumber: 1, windowDays: 1 })
      )
    ).toBe(true)
  })
})
