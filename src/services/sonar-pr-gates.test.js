describe('#ensurePrQualityGates', () => {
  let server
  let db
  let ensurePrQualityGates
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  beforeAll(async () => {
    // Dynamic imports: config must be read after vitest-mongodb sets MONGO_URI
    ;({ ensurePrQualityGates } = await import('./sonar-pr-gates.js'))
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await db.collection('sonar-pr-snapshots').deleteMany({})
    await db.collection('repositories').deleteMany({})
    await db.collection('repositories').insertMany([
      { fullName: 'DEFRA/r', projectSlug: 'FES', sonarProjectKey: 'DEFRA_r' },
      { fullName: 'DEFRA/u', projectSlug: 'FES' }
    ])
  })

  const sonar = (impl = async () => ({ analyzed: true })) => ({
    getPrMetrics: vi.fn(impl)
  })

  test('Should fetch only linked PRs with no snapshot', async () => {
    await db
      .collection('sonar-pr-snapshots')
      .insertOne({ repository: 'DEFRA/r', prNumber: 1 })
    const client = sonar()

    const result = await ensurePrQualityGates({
      db,
      sonar: client,
      logger,
      prs: [
        { repository: 'DEFRA/r', prNumber: 1 },
        { repository: 'DEFRA/r', prNumber: 2 },
        { repository: 'DEFRA/u', prNumber: 3 }
      ]
    })

    expect(client.getPrMetrics).toHaveBeenCalledTimes(1)
    expect(client.getPrMetrics).toHaveBeenCalledWith('DEFRA/r', 2, { db })
    expect(result).toEqual({ stale: false })
  })

  test('Should report stale when a gate fails', async () => {
    const client = sonar(async () => {
      throw new Error('Sonar down')
    })

    const result = await ensurePrQualityGates({
      db,
      sonar: client,
      logger,
      prs: [{ repository: 'DEFRA/r', prNumber: 2 }]
    })

    expect(result).toEqual({ stale: true })
    expect(logger.warn).toHaveBeenCalled()
  })

  test('Should report stale beyond the cap', async () => {
    const client = sonar()

    const result = await ensurePrQualityGates({
      db,
      sonar: client,
      logger,
      maxPrs: 1,
      prs: [
        { repository: 'DEFRA/r', prNumber: 2 },
        { repository: 'DEFRA/r', prNumber: 3 }
      ]
    })

    expect(client.getPrMetrics).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ stale: true })
  })

  test('Should report stale after the budget', async () => {
    const client = sonar(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 200))
    )

    const result = await ensurePrQualityGates({
      db,
      sonar: client,
      logger,
      budgetMs: 20,
      prs: [{ repository: 'DEFRA/r', prNumber: 2 }]
    })

    expect(result).toEqual({ stale: true })
  })

  test('Should do nothing without a Sonar client', async () => {
    const result = await ensurePrQualityGates({
      db,
      sonar: undefined,
      logger,
      prs: [{ repository: 'DEFRA/r', prNumber: 2 }]
    })

    expect(result).toEqual({ stale: false })
  })
})
