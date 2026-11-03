import {
  grantAccess,
  ADMIN,
  OUTSIDER,
  PROJECT_USER,
  asUser
} from '#/test-helpers/auth-headers.js'

const PROJECT_MAP = JSON.stringify({ 'DEFRA/repo-one': 'DEFRA_repo-one' })

const measuresResponse = JSON.stringify({
  component: {
    key: 'DEFRA_repo-one',
    measures: [{ metric: 'coverage', value: '90' }]
  }
})
const statusResponse = JSON.stringify({ projectStatus: { status: 'OK' } })

function mockSonarOk() {
  fetchMock.mockResponse((request) =>
    request.url.includes('project_status') ? statusResponse : measuresResponse
  )
}

describe('#sonar routes', () => {
  let server
  let admin
  const get = (url) => server.inject({ url, headers: admin })

  beforeAll(async () => {
    process.env.SONAR_PROJECT_MAP = PROJECT_MAP
    // Disable the response cache so each test exercises its own mocked upstream.
    process.env.SONAR_CACHE_TTL_MS = '0'

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
    admin = await asUser(ADMIN)
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.SONAR_PROJECT_MAP
    delete process.env.SONAR_CACHE_TTL_MS
  })

  beforeEach(async () => {
    await server.db.collection('sonar-snapshots')?.deleteMany({})
    await server.db.collection('sonar-pr-snapshots')?.deleteMany({})
  })

  describe('GET /api/sonar/overview', () => {
    test('Should return one entry per linked repository', async () => {
      mockSonarOk()

      const { statusCode, result } = await get('/api/sonar/overview')

      expect(statusCode).toBe(200)
      expect(result).toEqual([
        {
          repository: 'DEFRA/repo-one',
          projectKey: 'DEFRA_repo-one',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-one',
          qualityGate: 'passed',
          measures: { coverage: 90, bugs: null, vulnerabilities: null }
        }
      ])
    })

    test('Should accept valid asOf query', async () => {
      mockSonarOk()

      const { statusCode, result } = await get(
        '/api/sonar/overview?asOf=2026-03-01T00:00:00.000Z'
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual([
        expect.objectContaining({
          repository: 'DEFRA/repo-one',
          projectKey: 'DEFRA_repo-one',
          asOf: '2026-03-01T00:00:00.000Z'
        })
      ])
    })

    test('Should reject invalid asOf date', async () => {
      const { statusCode } = await get('/api/sonar/overview?asOf=invalid-date')

      expect(statusCode).toBe(400)
    })
  })

  describe('GET /api/sonar/repo', () => {
    test('Should return metrics for a linked repository', async () => {
      mockSonarOk()

      const { statusCode, result } = await get(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        configured: true,
        repository: 'DEFRA/repo-one',
        qualityGate: 'passed'
      })
    })

    test('Should accept valid asOf and return cached snapshot from db if present', async () => {
      const asOf = new Date('2026-01-15T00:00:00.000Z')
      await server.db.collection('sonar-snapshots').insertOne({
        repository: 'DEFRA/repo-one',
        projectKey: 'DEFRA_repo-one',
        asOf,
        qualityGate: 'passed',
        ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
        measures: { coverage: 95 },
        capturedAt: new Date()
      })

      fetchMock.mockClear()
      const { statusCode, result } = await get(
        `/api/sonar/repo?repository=DEFRA%2Frepo-one&asOf=${asOf.toISOString()}`
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        configured: true,
        repository: 'DEFRA/repo-one',
        qualityGate: 'passed',
        measures: { coverage: 95 }
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    test('Should reject invalid asOf date', async () => {
      const { statusCode } = await get(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one&asOf=invalid-date'
      )

      expect(statusCode).toBe(400)
    })

    test('Should report an unmapped repository as not linked', async () => {
      const { statusCode, result } = await get(
        '/api/sonar/repo?repository=DEFRA%2Fother'
      )

      expect(statusCode).toBe(200)
      expect(result).toEqual({
        configured: true,
        linked: false,
        repository: 'DEFRA/other'
      })
    })

    test('Should reject a request without a repository', async () => {
      const { statusCode } = await get('/api/sonar/repo')

      expect(statusCode).toBe(400)
    })

    test('Should return a bad gateway when SonarCloud fails', async () => {
      fetchMock.mockResponse('boom', { status: 500 })

      const { statusCode } = await get(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(502)
    })
  })

  describe('GET /api/sonar/pr', () => {
    test('Should return new-code metrics for a PR and snapshot to db', async () => {
      mockSonarOk()

      const { statusCode, result } = await get(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=7'
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        analyzed: true,
        prNumber: 7,
        firstScanQualityGate: 'passed'
      })

      const snapshot = await server.db
        .collection('sonar-pr-snapshots')
        .findOne({ repository: 'DEFRA/repo-one', prNumber: 7 })
      expect(snapshot).not.toBeNull()
      expect(snapshot.firstScanQualityGate).toBe('passed')

      // Subsequent call should return cached snapshot without calling SonarCloud
      fetchMock.mockClear()
      const cached = await get(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=7'
      )
      expect(cached.statusCode).toBe(200)
      expect(cached.result).toMatchObject({
        analyzed: true,
        prNumber: 7,
        firstScanQualityGate: 'passed'
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    test('Should reject a missing PR number', async () => {
      const { statusCode } = await get(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(400)
    })

    test('Should reject a non-numeric PR number', async () => {
      const { statusCode } = await get(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=abc'
      )

      expect(statusCode).toBe(400)
    })

    test('Should return a bad gateway when SonarCloud fails', async () => {
      fetchMock.mockResponse('boom', { status: 500 })

      const { statusCode } = await get(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=7'
      )

      expect(statusCode).toBe(502)
    })
  })

  describe('Role scoping', () => {
    let projectUser
    let outsider

    beforeAll(async () => {
      ;[projectUser, outsider] = await Promise.all(
        [PROJECT_USER, OUTSIDER].map(asUser)
      )
    })

    beforeEach(async () => {
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
      await server.db
        .collection('repositories')
        .insertOne({ fullName: 'DEFRA/repo-one', projectSlug: 'ALPH' })
    })

    const inject = (url, headers) => server.inject({ url, headers })

    test('Should let a project user read their repository', async () => {
      mockSonarOk()

      const { statusCode } = await inject(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one',
        projectUser
      )

      expect(statusCode).toBe(200)
    })

    test('Should hide a repository from someone with no role on its project', async () => {
      const { statusCode } = await inject(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one',
        outsider
      )

      expect(statusCode).toBe(404)
    })

    test('Should keep an unmapped repository to dashboard admins', async () => {
      await server.db.collection('repositories').deleteMany({})

      const { statusCode } = await inject(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one',
        projectUser
      )

      expect(statusCode).toBe(404)
    })

    test('Should filter the overview to repositories the caller can read', async () => {
      mockSonarOk()

      const visible = await inject('/api/sonar/overview', projectUser)
      const hidden = await inject('/api/sonar/overview', outsider)

      expect(visible.result.map((r) => r.repository)).toEqual([
        'DEFRA/repo-one'
      ])
      expect(hidden.result).toEqual([])
    })

    test('Should reject a request with no signed context', async () => {
      const { statusCode } = await server.inject('/api/sonar/overview')

      expect(statusCode).toBe(401)
    })
  })
})
