import { ADMIN, asUser } from '#/test-helpers/auth-headers.js'

const REPO = 'DEFRA/repo-a'
const KEY = 'DEFRA_repo-a'

describe('#sonar snapshot fallback', () => {
  let server
  let db
  let admin

  beforeAll(async () => {
    process.env.SONAR_SNAPSHOT_FALLBACK = 'true'
    delete process.env.SONAR_PROJECT_MAP
    // Dynamic import: config must be read after the env and MONGO_URI are set
    const { createServer } = await import('#/server.js')
    server = await createServer()
    await server.initialize()
    db = server.db
    admin = await asUser(ADMIN)
  })

  afterAll(async () => {
    delete process.env.SONAR_SNAPSHOT_FALLBACK
    await server.stop({ timeout: 1000 })
  })

  beforeEach(async () => {
    for (const name of [
      'repositories',
      'sonar-snapshots',
      'sonar-pr-snapshots'
    ]) {
      await db.collection(name).deleteMany({})
    }
    await db.collection('repositories').insertMany([
      {
        fullName: 'DEFRA/repo-b',
        projectSlug: 'p',
        sonarProjectKey: 'DEFRA_repo-b'
      },
      { fullName: REPO, projectSlug: 'p', sonarProjectKey: KEY },
      { fullName: 'DEFRA/no-key', projectSlug: 'p', sonarProjectKey: '' }
    ])
    await db.collection('sonar-snapshots').insertMany([
      {
        repository: REPO,
        asOf: new Date('2026-09-15T23:59:59Z'),
        analysisDate: new Date('2026-09-15T16:45:00Z'),
        qualityGate: 'passed',
        ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
        measures: { coverage: '88.0' }
      },
      {
        repository: REPO,
        asOf: new Date('2026-09-29T23:59:59Z'),
        qualityGate: 'failed',
        ratings: { reliability: 'C', security: 'A', maintainability: 'B' },
        measures: { coverage: '78.6' }
      }
    ])
  })

  const get = (url) => server.inject({ method: 'GET', url, headers: admin })

  test('Should serve the latest snapshot at or before the as-at time', async () => {
    const { statusCode, result } = await get(
      `/api/sonar/repo?repository=${encodeURIComponent(REPO)}&asOf=2026-09-20T00:00:00Z`
    )

    expect(statusCode).toBe(200)
    expect(result).toMatchObject({
      configured: true,
      repository: REPO,
      projectKey: KEY,
      asOf: '2026-09-20T00:00:00.000Z',
      analysisDate: '2026-09-15T16:45:00.000Z',
      qualityGate: 'passed',
      measures: { coverage: '88.0' }
    })
    expect(result._id).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('Should use the snapshot time when no analysis date was stored', async () => {
    const { result } = await get(
      `/api/sonar/repo?repository=${encodeURIComponent(REPO)}&asOf=2026-09-29T23:59:59Z`
    )

    expect(result).toMatchObject({
      qualityGate: 'failed',
      analysisDate: '2026-09-29T23:59:59.000Z'
    })
  })

  test('Should report no analysis before the as-at time', async () => {
    const { result } = await get(
      `/api/sonar/repo?repository=${encodeURIComponent(REPO)}&asOf=2026-09-01T00:00:00Z`
    )

    expect(result).toMatchObject({ analysisDate: null, qualityGate: 'none' })
  })

  test('Should serve the newest snapshot, without as-at, for the live period', async () => {
    const { result } = await get(
      `/api/sonar/repo?repository=${encodeURIComponent(REPO)}&asOf=2999-01-01T00:00:00Z`
    )

    expect(result.qualityGate).toBe('failed')
    expect(result.asOf).toBeUndefined()
  })

  test('Should report unlinked repositories', async () => {
    const { result } = await get('/api/sonar/repo?repository=DEFRA%2Fno-key')

    expect(result).toEqual({
      configured: true,
      linked: false,
      repository: 'DEFRA/no-key'
    })
  })

  test('Should list every linked repository in the overview, sorted', async () => {
    const { result } = await get(
      '/api/sonar/overview?asOf=2026-09-20T00:00:00Z'
    )

    expect(result.map((r) => [r.repository, r.qualityGate])).toEqual([
      [REPO, 'passed'],
      ['DEFRA/repo-b', 'none']
    ])
    expect(result[0].asOf).toBe('2026-09-20T00:00:00.000Z')
    expect(result[0].measures).toEqual({
      coverage: 88,
      bugs: null,
      vulnerabilities: null
    })
    expect(result[1].measures).toEqual({
      coverage: null,
      bugs: null,
      vulnerabilities: null
    })
  })

  test('Should serve a stored PR snapshot or report it as not analysed', async () => {
    await db.collection('sonar-pr-snapshots').insertOne({
      repository: REPO,
      prNumber: 7,
      analyzed: true,
      qualityGate: 'passed'
    })

    const found = await get(
      `/api/sonar/pr?repository=${encodeURIComponent(REPO)}&prNumber=7`
    )
    const missing = await get(
      `/api/sonar/pr?repository=${encodeURIComponent(REPO)}&prNumber=8`
    )

    expect(found.result).toMatchObject({ prNumber: 7, qualityGate: 'passed' })
    expect(found.result._id).toBeUndefined()
    expect(missing.result).toMatchObject({
      analyzed: false,
      qualityGate: 'none'
    })
  })
})
