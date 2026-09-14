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

  beforeAll(async () => {
    process.env.SONAR_PROJECT_MAP = PROJECT_MAP
    // Disable the response cache so each test exercises its own mocked upstream.
    process.env.SONAR_CACHE_TTL_MS = '0'

    // Dynamic import needed due to config being updated by vitest-mongodb
    const { createServer } = await import('#/server.js')

    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop({ timeout: 1000 })
    delete process.env.SONAR_PROJECT_MAP
    delete process.env.SONAR_CACHE_TTL_MS
  })

  describe('GET /api/sonar/overview', () => {
    test('Should return one entry per linked repository', async () => {
      mockSonarOk()

      const { statusCode, result } = await server.inject('/api/sonar/overview')

      expect(statusCode).toBe(200)
      expect(result).toEqual([
        {
          repository: 'DEFRA/repo-one',
          projectKey: 'DEFRA_repo-one',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-one',
          qualityGate: 'passed'
        }
      ])
    })
  })

  describe('GET /api/sonar/repo', () => {
    test('Should return metrics for a linked repository', async () => {
      mockSonarOk()

      const { statusCode, result } = await server.inject(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({
        configured: true,
        repository: 'DEFRA/repo-one',
        qualityGate: 'passed'
      })
    })

    test('Should report an unmapped repository as not linked', async () => {
      const { statusCode, result } = await server.inject(
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
      const { statusCode } = await server.inject('/api/sonar/repo')

      expect(statusCode).toBe(400)
    })

    test('Should return a bad gateway when SonarCloud fails', async () => {
      fetchMock.mockResponse('boom', { status: 500 })

      const { statusCode } = await server.inject(
        '/api/sonar/repo?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(502)
    })
  })

  describe('GET /api/sonar/pr', () => {
    test('Should return new-code metrics for a PR', async () => {
      mockSonarOk()

      const { statusCode, result } = await server.inject(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=7'
      )

      expect(statusCode).toBe(200)
      expect(result).toMatchObject({ analyzed: true, prNumber: 7 })
    })

    test('Should reject a missing PR number', async () => {
      const { statusCode } = await server.inject(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one'
      )

      expect(statusCode).toBe(400)
    })

    test('Should reject a non-numeric PR number', async () => {
      const { statusCode } = await server.inject(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=abc'
      )

      expect(statusCode).toBe(400)
    })

    test('Should return a bad gateway when SonarCloud fails', async () => {
      fetchMock.mockResponse('boom', { status: 500 })

      const { statusCode } = await server.inject(
        '/api/sonar/pr?repository=DEFRA%2Frepo-one&prNumber=7'
      )

      expect(statusCode).toBe(502)
    })
  })
})
