import { createSonarClient } from './sonar.js'

const PROJECT_MAP = JSON.stringify({
  'DEFRA/repo-one': 'DEFRA_repo-one',
  'DEFRA/repo-two': 'DEFRA_repo-two'
})

const measuresResponse = (measures) =>
  JSON.stringify({ component: { key: 'DEFRA_repo-one', measures } })

const statusResponse = (status) => JSON.stringify({ projectStatus: { status } })

function createLoggerStub() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}

/** Routes mocked responses by URL so parallel calls resolve independently. */
function mockSonar(routes) {
  fetchMock.mockResponse((request) => {
    const match = Object.entries(routes).find(([fragment]) =>
      request.url.includes(fragment)
    )

    return match ? match[1](request) : { body: 'not mocked', status: 404 }
  })
}

const client = (options = {}) =>
  createSonarClient({
    baseUrl: 'https://sonarcloud.io',
    token: '',
    projectMap: PROJECT_MAP,
    requestTimeoutMs: 1000,
    cacheTtlMs: 60000,
    dispatcher: undefined,
    logger: createLoggerStub(),
    ...options
  })

describe('#createSonarClient', () => {
  describe('Configuration', () => {
    test('Should report not configured without a project map', () => {
      expect(client({ projectMap: '' }).isConfigured()).toBe(false)
    })

    test('Should ignore a project map that is not valid JSON', () => {
      const logger = createLoggerStub()

      expect(client({ projectMap: '{nope', logger }).isConfigured()).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('not valid JSON')
      )
    })

    test('Should ignore a project map that is not a JSON object', () => {
      const logger = createLoggerStub()

      expect(client({ projectMap: '["a"]', logger }).isConfigured()).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not a JSON object')
      )
    })

    test('Should drop entries whose project key is not a non-empty string', () => {
      const sonar = client({
        projectMap: JSON.stringify({
          'DEFRA/a': '',
          'DEFRA/b': 7,
          'DEFRA/c': 'k'
        })
      })

      expect(sonar.projectKeyFor('DEFRA/a')).toBeNull()
      expect(sonar.projectKeyFor('DEFRA/b')).toBeNull()
      expect(sonar.projectKeyFor('DEFRA/c')).toBe('k')
    })

    test('Should not resolve inherited object members as a project key', () => {
      const sonar = client({
        projectMap: JSON.stringify({ 'DEFRA/c': 'k' })
      })

      expect(sonar.projectKeyFor('constructor')).toBeNull()
      expect(sonar.projectKeyFor('toString')).toBeNull()
      expect(sonar.projectKeyFor('__proto__')).toBeNull()
    })

    test('Should report every endpoint as not configured without a map', async () => {
      const sonar = client({ projectMap: '' })

      await expect(sonar.getRepoMetrics('DEFRA/repo-one')).resolves.toEqual({
        configured: false
      })
      await expect(sonar.getPrMetrics('DEFRA/repo-one', 1)).resolves.toEqual({
        configured: false
      })
      await expect(sonar.getOverview()).resolves.toEqual({ configured: false })
    })
  })

  describe('#getRepoMetrics', () => {
    test('Should shape measures, ratings and quality gate', async () => {
      mockSonar({
        '/api/measures/component': () =>
          measuresResponse([
            { metric: 'reliability_rating', value: '1' },
            { metric: 'security_rating', value: '2' },
            { metric: 'sqale_rating', value: '3' },
            { metric: 'coverage', value: '88.5' },
            { metric: 'bugs', value: 'not-a-number' }
          ]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one')

      expect(result).toMatchObject({
        configured: true,
        repository: 'DEFRA/repo-one',
        projectKey: 'DEFRA_repo-one',
        url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-one',
        qualityGate: 'passed',
        ratings: { reliability: 'A', security: 'B', maintainability: 'C' }
      })
      expect(result.measures.coverage).toBe(88.5)
      expect(result.measures.bugs).toBeNull()
    })

    test('Should read new-code values from the period when no value is present', async () => {
      mockSonar({
        '/api/measures/component': () =>
          measuresResponse([
            { metric: 'new_coverage', period: { value: '73' } },
            { metric: 'new_bugs', periods: [{ value: '4' }] }
          ]),
        '/api/qualitygates/project_status': () => statusResponse('ERROR')
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one')

      expect(result.measures.new_coverage).toBe(73)
      expect(result.measures.new_bugs).toBe(4)
      expect(result.qualityGate).toBe('failed')
    })

    test.each([
      ['WARN', 'warning'],
      ['SOMETHING-ELSE', 'none'],
      [undefined, 'none']
    ])('Should map quality gate %s to %s', async (upstream, expected) => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse(upstream)
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one')

      expect(result.qualityGate).toBe(expected)
    })

    test('Should report a repository outside the map as not linked', async () => {
      await expect(client().getRepoMetrics('DEFRA/unmapped')).resolves.toEqual({
        configured: true,
        linked: false,
        repository: 'DEFRA/unmapped'
      })
    })

    test('Should treat a 404 as not linked', async () => {
      fetchMock.mockResponse('missing', { status: 404 })

      await expect(client().getRepoMetrics('DEFRA/repo-one')).resolves.toEqual({
        configured: true,
        linked: false,
        repository: 'DEFRA/repo-one'
      })
    })

    test('Should propagate other upstream failures', async () => {
      fetchMock.mockResponse('boom', { status: 500 })

      await expect(client().getRepoMetrics('DEFRA/repo-one')).rejects.toThrow(
        '500'
      )
    })
  })

  describe('#getPrMetrics', () => {
    test('Should return analysed new-code metrics', async () => {
      mockSonar({
        '/api/measures/component': () =>
          measuresResponse([{ metric: 'new_coverage', value: '91' }]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      const result = await client().getPrMetrics('DEFRA/repo-one', 12)

      expect(result).toMatchObject({
        configured: true,
        analyzed: true,
        prNumber: 12,
        qualityGate: 'passed',
        url: 'https://sonarcloud.io/summary/new_code?id=DEFRA_repo-one&pullRequest=12'
      })
      expect(result.measures.new_coverage).toBe(91)
    })

    test('Should report an unanalysed PR rather than failing', async () => {
      fetchMock.mockResponse('missing', { status: 404 })

      const result = await client().getPrMetrics('DEFRA/repo-one', 12)

      expect(result).toMatchObject({
        configured: true,
        analyzed: false,
        qualityGate: 'none',
        measures: {},
        ratings: { reliability: null, security: null, maintainability: null }
      })
    })

    test('Should report a repository outside the map as not linked', async () => {
      await expect(client().getPrMetrics('DEFRA/unmapped', 1)).resolves.toEqual(
        {
          configured: true,
          linked: false,
          repository: 'DEFRA/unmapped'
        }
      )
    })
  })

  describe('#getOverview', () => {
    test('Should summarise every linked repository', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      const result = await client().getOverview()

      expect(result).toEqual([
        {
          repository: 'DEFRA/repo-one',
          projectKey: 'DEFRA_repo-one',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-one',
          qualityGate: 'passed'
        },
        {
          repository: 'DEFRA/repo-two',
          projectKey: 'DEFRA_repo-two',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-two',
          qualityGate: 'passed'
        }
      ])
    })

    test('Should skip and log repositories that fail', async () => {
      fetchMock.mockResponse('boom', { status: 500 })
      const logger = createLoggerStub()

      await expect(client({ logger }).getOverview()).resolves.toEqual([])
      expect(logger.warn).toHaveBeenCalledTimes(2)
    })
  })

  describe('Authentication', () => {
    test('Should send a bearer token when one is configured', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      await client({ token: 'secret-token' }).getRepoMetrics('DEFRA/repo-one')

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        'Bearer secret-token'
      )
    })

    test('Should treat a placeholder token as absent', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      await client({ token: '<sonarcloud-user-token>' }).getRepoMetrics(
        'DEFRA/repo-one'
      )

      expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
        'Authorization'
      )
    })

    test('Should retry anonymously when the token is rejected', async () => {
      const logger = createLoggerStub()
      let attempted = false

      fetchMock.mockResponse((request) => {
        if (request.url.includes('project_status')) {
          return statusResponse('OK')
        }
        if (!attempted) {
          attempted = true
          return { body: 'unauthorised', status: 401 }
        }
        return measuresResponse([])
      })

      const result = await client({
        token: 'stale-token',
        logger
      }).getRepoMetrics('DEFRA/repo-one')

      expect(result.configured).toBe(true)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('retrying anonymously')
      )
    })
  })

  describe('#validateToken', () => {
    test('Should do nothing without a token', async () => {
      const logger = createLoggerStub()

      await client({ logger }).validateToken()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    })

    test('Should log success for a valid token', async () => {
      fetchMock.mockResponse(JSON.stringify({ valid: true }))
      const logger = createLoggerStub()

      await client({ token: 'good', logger }).validateToken()

      expect(logger.info).toHaveBeenCalledWith(
        'SONAR_TOKEN validated successfully'
      )
    })

    test('Should log an error for an invalid token', async () => {
      fetchMock.mockResponse(JSON.stringify({ valid: false }))
      const logger = createLoggerStub()

      await client({ token: 'bad', logger }).validateToken()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('not valid according to SonarCloud')
      )
    })

    test('Should warn but not throw when validation cannot be reached', async () => {
      fetchMock.mockReject(new Error('network down'))
      const logger = createLoggerStub()

      await expect(
        client({ token: 'good', logger }).validateToken()
      ).resolves.toBeUndefined()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('Could not validate SONAR_TOKEN')
      )
    })
  })

  describe('Caching', () => {
    test('Should serve repeated requests from cache', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })
      const sonar = client()

      await sonar.getRepoMetrics('DEFRA/repo-one')
      await sonar.getRepoMetrics('DEFRA/repo-one')

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('Should refetch once the cache entry expires', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })
      const sonar = client({ cacheTtlMs: 0 })

      await sonar.getRepoMetrics('DEFRA/repo-one')
      await sonar.getRepoMetrics('DEFRA/repo-one')

      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })

  describe('Outbound proxy', () => {
    test('Should attach the dispatcher when one is provided', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })
      const dispatcher = { marker: 'proxy' }

      await client({ dispatcher }).getRepoMetrics('DEFRA/repo-one')

      expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher)
    })

    test('Should omit the dispatcher when there is no proxy', async () => {
      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      await client().getRepoMetrics('DEFRA/repo-one')

      expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('dispatcher')
    })
  })
})
