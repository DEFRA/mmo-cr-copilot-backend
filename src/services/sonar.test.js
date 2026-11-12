import { createSonarClient, PR_METRIC_KEYS } from './sonar.js'

const REPOSITORIES = [
  { fullName: 'DEFRA/repo-one', sonarProjectKey: 'DEFRA_repo-one' },
  { fullName: 'DEFRA/repo-two', sonarProjectKey: 'DEFRA_repo-two' },
  { fullName: 'DEFRA/no-key', sonarProjectKey: null }
]

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

function createMockDb(repositories = REPOSITORIES) {
  const collections = new Map()
  const db = {
    collection: (name) => {
      if (!collections.has(name)) {
        const docs =
          name === 'repositories' ? repositories.map((r) => ({ ...r })) : []
        collections.set(name, {
          docs,
          find: vi.fn(() => ({
            sort: () => ({
              toArray: async () =>
                docs
                  .filter((d) => d.sonarProjectKey)
                  .sort((a, b) => a.fullName.localeCompare(b.fullName))
            })
          })),
          findOne: vi.fn(async (query) => {
            return (
              docs.find((d) =>
                Object.entries(query).every(([k, v]) => {
                  if (v instanceof Date) {
                    return d[k]?.getTime() === v.getTime()
                  }
                  return d[k] === v
                })
              ) ?? null
            )
          }),
          updateOne: vi.fn(async (filter, update, options) => {
            const doc = update.$set ?? update
            const existingIdx = docs.findIndex((d) =>
              Object.entries(filter).every(([k, v]) => {
                if (v instanceof Date) {
                  return d[k]?.getTime() === v.getTime()
                }
                return d[k] === v
              })
            )
            if (existingIdx >= 0) {
              docs[existingIdx] = { ...docs[existingIdx], ...doc }
            } else if (options?.upsert) {
              docs.push({ ...doc })
            }
            return { acknowledged: true }
          }),
          insertOne: vi.fn(async (doc) => {
            docs.push({ ...doc })
            return { acknowledged: true, insertedId: 'mock-id' }
          })
        })
      }
      return collections.get(name)
    }
  }
  return db
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

// Wraps the client so each call reads the mapped repositories from a mock db.
const client = ({ db: defaultDb = createMockDb(), ...options } = {}) => {
  const sonar = createSonarClient({
    baseUrl: 'https://sonarcloud.io',
    token: '',
    requestTimeoutMs: 1000,
    cacheTtlMs: 60000,
    dispatcher: undefined,
    logger: createLoggerStub(),
    ...options
  })
  const withDb = (opts = {}) => ({ db: defaultDb, ...opts })

  return {
    ...sonar,
    getRepoMetrics: (repository, opts) =>
      sonar.getRepoMetrics(repository, withDb(opts)),
    getPrMetrics: (repository, prNumber, opts) =>
      sonar.getPrMetrics(repository, prNumber, withDb(opts)),
    getOverview: (opts) => sonar.getOverview(withDb(opts))
  }
}

describe('#createSonarClient', () => {
  describe('Configuration', () => {
    test('Should include required PR metric keys for delivery and sprint tracking', () => {
      expect(PR_METRIC_KEYS).toContain('alert_status')
      expect(PR_METRIC_KEYS).toContain('new_sqale_debt_ratio')
      expect(PR_METRIC_KEYS).toContain('new_software_quality_blocker_issues')
      expect(PR_METRIC_KEYS).toContain('new_software_quality_high_issues')
    })

    test('Should report a repository without a project key as not linked', async () => {
      await expect(client().getRepoMetrics('DEFRA/no-key')).resolves.toEqual({
        configured: true,
        linked: false,
        repository: 'DEFRA/no-key'
      })
    })

    test('Should not treat a query operator as a repository name', async () => {
      await expect(
        client().getRepoMetrics({ $ne: 'x' })
      ).resolves.toMatchObject({ linked: false })
    })

    test('Should report no repositories when none are linked', async () => {
      await expect(
        client({ db: createMockDb([]) }).getOverview()
      ).resolves.toEqual([])
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

    test('Should return cached snapshot when asOf and db are provided and snapshot exists', async () => {
      const db = createMockDb()
      const asOf = new Date('2026-02-01T00:00:00.000Z')
      await db.collection('sonar-snapshots').insertOne({
        repository: 'DEFRA/repo-one',
        projectKey: 'DEFRA_repo-one',
        asOf,
        qualityGate: 'passed',
        ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
        measures: { coverage: 92 },
        capturedAt: new Date()
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one', {
        asOf,
        db
      })

      expect(result).toMatchObject({
        configured: true,
        repository: 'DEFRA/repo-one',
        qualityGate: 'passed',
        measures: { coverage: 92 }
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    test('Should read the last analysis before a past cut-off and store it', async () => {
      const db = createMockDb()
      const asOf = new Date('2026-07-21T23:59:59.000Z')

      mockSonar({
        '/api/project_analyses/search': (request) => {
          expect(request.url).toContain('to=2026-07-21T23%3A59%3A59%2B0000')
          return JSON.stringify({
            analyses: [{ key: 'AX1', date: '2026-07-20T10:15:00+0000' }]
          })
        },
        '/api/measures/search_history': () =>
          JSON.stringify({
            measures: [
              {
                metric: 'coverage',
                history: [{ date: '2026-07-20T10:15:00+0000', value: '85' }]
              },
              {
                metric: 'reliability_rating',
                history: [{ date: '2026-07-20T10:15:00+0000', value: '1' }]
              }
            ]
          }),
        '/api/qualitygates/project_status': (request) => {
          expect(request.url).toContain('analysisId=AX1')
          return statusResponse('OK')
        }
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one', {
        asOf,
        db
      })

      expect(result).toMatchObject({
        qualityGate: 'passed',
        asOf: '2026-07-21T23:59:59.000Z',
        analysisDate: '2026-07-20T10:15:00.000Z',
        ratings: { reliability: 'A' },
        measures: { coverage: 85 }
      })
      const stored = await db.collection('sonar-snapshots').findOne({
        repository: 'DEFRA/repo-one',
        asOf
      })
      expect(stored.analysisDate).toBe('2026-07-20T10:15:00.000Z')
      expect(stored.measures.coverage).toBe(85)
    })

    test('Should report no analysis before the cut-off', async () => {
      mockSonar({
        '/api/project_analyses/search': () => JSON.stringify({ analyses: [] })
      })

      const result = await client().getRepoMetrics('DEFRA/repo-one', {
        asOf: new Date('2020-01-01T00:00:00.000Z')
      })

      expect(result).toMatchObject({
        configured: true,
        analysisDate: null,
        qualityGate: 'none',
        measures: {}
      })
    })

    test('Should fetch and not store snapshot when asOf is in the future', async () => {
      const db = createMockDb()
      const asOf = new Date(Date.now() + 86400000)

      mockSonar({
        '/api/measures/component': () => measuresResponse([]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      await client().getRepoMetrics('DEFRA/repo-one', { asOf, db })

      const stored = await db.collection('sonar-snapshots').findOne({
        repository: 'DEFRA/repo-one',
        asOf
      })
      expect(stored).toBeNull()
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

    test('Should return cached PR snapshot from db without fetching', async () => {
      const db = createMockDb()
      await db.collection('sonar-pr-snapshots').insertOne({
        repository: 'DEFRA/repo-one',
        prNumber: 42,
        analyzed: true,
        qualityGate: 'passed',
        firstScanQualityGate: 'passed',
        ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
        measures: { new_coverage: 99 }
      })

      const result = await client().getPrMetrics('DEFRA/repo-one', 42, { db })

      expect(result).toMatchObject({
        configured: true,
        analyzed: true,
        prNumber: 42,
        firstScanQualityGate: 'passed',
        measures: { new_coverage: 99 }
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    test('Should snapshot analyzed PR into sonar-pr-snapshots with firstScanQualityGate', async () => {
      const db = createMockDb()
      mockSonar({
        '/api/measures/component': () =>
          measuresResponse([{ metric: 'new_coverage', value: '91' }]),
        '/api/qualitygates/project_status': () => statusResponse('OK')
      })

      const result = await client().getPrMetrics('DEFRA/repo-one', 15, { db })

      expect(result.firstScanQualityGate).toBe('passed')
      const stored = await db.collection('sonar-pr-snapshots').findOne({
        repository: 'DEFRA/repo-one',
        prNumber: 15
      })
      expect(stored).not.toBeNull()
      expect(stored.firstScanQualityGate).toBe('passed')
      expect(stored.analyzed).toBe(true)
    })

    test('Should not snapshot unanalysed PR into db', async () => {
      const db = createMockDb()
      fetchMock.mockResponse('missing', { status: 404 })

      const result = await client().getPrMetrics('DEFRA/repo-one', 16, { db })

      expect(result.analyzed).toBe(false)
      const stored = await db.collection('sonar-pr-snapshots').findOne({
        repository: 'DEFRA/repo-one',
        prNumber: 16
      })
      expect(stored).toBeNull()
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
          qualityGate: 'passed',
          measures: { coverage: null, bugs: null, vulnerabilities: null }
        },
        {
          repository: 'DEFRA/repo-two',
          projectKey: 'DEFRA_repo-two',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-two',
          qualityGate: 'passed',
          measures: { coverage: null, bugs: null, vulnerabilities: null }
        }
      ])
    })

    test('Should pass asOf and db to repo metrics lookup', async () => {
      const db = createMockDb()
      const asOf = new Date('2026-02-01T00:00:00.000Z')
      await db.collection('sonar-snapshots').insertOne({
        repository: 'DEFRA/repo-one',
        projectKey: 'DEFRA_repo-one',
        asOf,
        qualityGate: 'passed',
        ratings: { reliability: 'A', security: 'A', maintainability: 'A' },
        measures: { coverage: 90 },
        capturedAt: new Date()
      })
      await db.collection('sonar-snapshots').insertOne({
        repository: 'DEFRA/repo-two',
        projectKey: 'DEFRA_repo-two',
        asOf,
        qualityGate: 'warning',
        ratings: { reliability: 'B', security: 'A', maintainability: 'A' },
        measures: { coverage: 80 },
        capturedAt: new Date()
      })

      const result = await client().getOverview({ asOf, db })

      expect(result).toEqual([
        {
          repository: 'DEFRA/repo-one',
          projectKey: 'DEFRA_repo-one',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-one',
          qualityGate: 'passed',
          measures: { coverage: 90, bugs: null, vulnerabilities: null },
          asOf: '2026-02-01T00:00:00.000Z',
          analysisDate: null
        },
        {
          repository: 'DEFRA/repo-two',
          projectKey: 'DEFRA_repo-two',
          url: 'https://sonarcloud.io/project/overview?id=DEFRA_repo-two',
          qualityGate: 'warning',
          measures: { coverage: 80, bugs: null, vulnerabilities: null },
          asOf: '2026-02-01T00:00:00.000Z',
          analysisDate: null
        }
      ])
      expect(fetchMock).not.toHaveBeenCalled()
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
