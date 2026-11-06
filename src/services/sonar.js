import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'

/**
 * SonarCloud read-only client.
 *
 * The browser must never hold the Sonar token, so every SonarCloud Web API call
 * is made here and exposed to the dashboard through the `/api/sonar/*` routes.
 * Project keys come from the `repositories` collection (set on the dashboard).
 * The client degrades gracefully by design: a repository with no key is "not
 * linked", and a 404 from SonarCloud is treated as "not analysed" rather than
 * an error. In both cases the dashboard simply hides the affected panel.
 */

// Overall (whole-branch) metrics shown on a repository's main branch.
export const BRANCH_METRIC_KEYS = [
  'alert_status',
  'reliability_rating',
  'security_rating',
  'sqale_rating',
  'coverage',
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots',
  'duplicated_lines_density',
  'ncloc'
]

// New-code metrics — the meaningful figures for a single pull request.
export const PR_METRIC_KEYS = [
  'alert_status',
  'reliability_rating',
  'security_rating',
  'sqale_rating',
  'new_coverage',
  'new_bugs',
  'new_vulnerabilities',
  'new_code_smells',
  'new_violations',
  'new_security_hotspots',
  'new_duplicated_lines_density',
  'new_lines',
  'new_sqale_debt_ratio',
  'new_software_quality_blocker_issues',
  'new_software_quality_high_issues'
]

const RATING_LETTER = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' }

const NOT_FOUND = 404
const UNAUTHORISED = 401

class SonarHttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'SonarHttpError'
    this.status = status
  }
}

function isPlaceholder(value) {
  return value.includes('<') && value.includes('>')
}

/** Repositories that have a SonarCloud project key, sorted by name. */
export function linkedRepositories(db) {
  return db
    .collection('repositories')
    .find(
      { sonarProjectKey: { $nin: [null, ''] } },
      { projection: { _id: 0, fullName: 1, sonarProjectKey: 1 } }
    )
    .sort({ fullName: 1 })
    .toArray()
}

/** The SonarCloud project key mapped to a repository, or null. */
export async function repositoryProjectKey(db, repository) {
  // `repository` is caller-supplied; String() stops a query operator object.
  const repo = await db
    .collection('repositories')
    .findOne(
      { fullName: String(repository) },
      { projection: { sonarProjectKey: 1 } }
    )
  return repo?.sonarProjectKey || null
}

function toNumber(value) {
  if (value == null) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function ratingLetter(value) {
  return value == null ? null : (RATING_LETTER[Math.round(value)] ?? null)
}

/** Flattens a measures/component response into `{ metricKey: number|null }`. */
function flattenMeasures(response) {
  const measures = response?.component?.measures ?? []
  return Object.fromEntries(
    measures.map((measure) => {
      const raw =
        measure.value ?? measure.period?.value ?? measure.periods?.[0]?.value
      return [
        measure.metric,
        measure.metric === 'alert_status' ? (raw ?? null) : toNumber(raw)
      ]
    })
  )
}

/** The last value of each metric in a `measures/search_history` response. */
function historyMeasures(response) {
  return Object.fromEntries(
    (response?.measures ?? []).map(({ metric, history = [] }) => {
      const raw = history.at(-1)?.value
      return [metric, metric === 'alert_status' ? (raw ?? null) : toNumber(raw)]
    })
  )
}

// Sonar Web API v1 datetime parameters take `yyyy-MM-ddTHH:mm:ss+0000`.
function sonarDateTime(date) {
  return `${date.toISOString().slice(0, 19)}+0000`
}

function mapGateStatus(status) {
  switch ((status ?? '').toUpperCase()) {
    case 'OK':
      return 'passed'
    case 'WARN':
      return 'warning'
    case 'ERROR':
      return 'failed'
    default:
      return 'none'
  }
}

function ratingsFrom(measures) {
  return {
    reliability: ratingLetter(measures.reliability_rating),
    security: ratingLetter(measures.security_rating),
    maintainability: ratingLetter(measures.sqale_rating)
  }
}

/** The headline measures shown on each portfolio card. */
export function overviewMeasures(measures = {}) {
  return {
    coverage: toNumber(measures.coverage),
    bugs: toNumber(measures.bugs),
    vulnerabilities: toNumber(measures.vulnerabilities)
  }
}

export function createSonarClient(options = {}) {
  const {
    baseUrl = config.get('sonar.baseUrl'),
    token = config.get('sonar.token'),
    requestTimeoutMs = config.get('sonar.requestTimeoutMs'),
    cacheTtlMs = config.get('sonar.cacheTtlMs'),
    dispatcher = createProxyDispatcher(),
    logger = createLogger()
  } = options

  const apiBase = baseUrl.replace(/\/+$/, '')
  // A token is only needed for private projects; public ones are read anonymously.
  const hasToken = Boolean(token) && !isPlaceholder(token)
  const cache = new Map()

  function requestInit(headers) {
    return {
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(requestTimeoutMs),
      ...(dispatcher ? { dispatcher } : {})
    }
  }

  async function sonarGet(pathname, params) {
    const url = `${apiBase}${pathname}?${new URLSearchParams(params)}`

    const cached = cache.get(url)
    if (cached && cached.expires > Date.now()) {
      return cached.data
    }

    let response = await fetch(
      url,
      requestInit(hasToken ? { Authorization: `Bearer ${token}` } : {})
    )

    // A bad/expired/revoked token 401s SonarCloud even for PUBLIC projects. If
    // a token was sent and rejected, retry once anonymously so public projects
    // still work and only genuinely private ones stay unreachable.
    if (response.status === UNAUTHORISED && hasToken) {
      logger.warn(
        `Sonar token rejected (401) for ${pathname} — retrying anonymously. Check SONAR_TOKEN is a valid, non-expired SonarCloud user token.`
      )
      response = await fetch(url, requestInit())
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new SonarHttpError(
        response.status,
        `${pathname} → ${response.status} ${body.slice(0, 200)}`
      )
    }

    const data = await response.json()
    cache.set(url, { expires: Date.now() + cacheTtlMs, data })
    return data
  }

  /**
   * Diagnostic only: each call already retries anonymously on 401, but nothing
   * else fails loudly enough when the token is simply wrong.
   */
  async function validateToken() {
    if (!hasToken) {
      return
    }

    try {
      const response = await fetch(
        `${apiBase}/api/authentication/validate`,
        requestInit({ Authorization: `Bearer ${token}` })
      )
      const body = await response.json()

      if (body?.valid === false) {
        logger.error(
          'SONAR_TOKEN is not valid according to SonarCloud (My Account > Security). Public projects still work anonymously; private projects stay hidden until a valid token is set.'
        )
      } else {
        logger.info('SONAR_TOKEN validated successfully')
      }
    } catch (error) {
      logger.warn({ err: error }, 'Could not validate SONAR_TOKEN at startup')
    }
  }

  /** Main-branch quality for one repository. */
  async function getRepoMetrics(repository, { asOf, db } = {}) {
    const projectKey = await repositoryProjectKey(db, repository)
    if (!projectKey) {
      return { configured: true, linked: false, repository }
    }

    return metricsForProject(repository, projectKey, { asOf, db })
  }

  async function metricsForProject(repository, projectKey, { asOf, db }) {
    const asOfDate = asOf ? new Date(asOf) : null
    const historical = Boolean(asOfDate) && asOfDate.getTime() < Date.now()
    const url = `${apiBase}/project/overview?id=${encodeURIComponent(projectKey)}`

    // A closed sprint's snapshot never changes, so it is served from the store.
    if (historical && db) {
      const snapshot = await db
        .collection('sonar-snapshots')
        .findOne({ repository, asOf: asOfDate })
      if (snapshot) {
        return { configured: true, url, ...snapshot }
      }
    }

    try {
      const result = historical
        ? await metricsAsAt(repository, projectKey, asOfDate)
        : await currentMetrics(repository, projectKey)

      if (historical && db) {
        await db.collection('sonar-snapshots').updateOne(
          { repository, asOf: asOfDate },
          {
            $set: {
              repository,
              projectKey,
              asOf: asOfDate,
              analysisDate: result.analysisDate,
              qualityGate: result.qualityGate,
              ratings: result.ratings,
              measures: result.measures,
              capturedAt: new Date()
            }
          },
          { upsert: true }
        )
      }

      return { ...result, url }
    } catch (error) {
      // A 404 means the mapped project key does not exist or has not been
      // analysed yet — treat it as "not linked" so the panel hides.
      if (error instanceof SonarHttpError && error.status === NOT_FOUND) {
        logger.warn(
          `Sonar project not found for ${repository} (key=${projectKey}); hiding panel`
        )
        return { configured: true, linked: false, repository }
      }
      throw error
    }
  }

  async function currentMetrics(repository, projectKey) {
    const [measuresResponse, statusResponse] = await Promise.all([
      sonarGet('/api/measures/component', {
        component: projectKey,
        metricKeys: BRANCH_METRIC_KEYS.join(',')
      }),
      sonarGet('/api/qualitygates/project_status', { projectKey })
    ])
    const measures = flattenMeasures(measuresResponse)
    return {
      configured: true,
      repository,
      projectKey,
      qualityGate: mapGateStatus(statusResponse?.projectStatus?.status),
      ratings: ratingsFrom(measures),
      measures
    }
  }

  /**
   * Main-branch quality as at a past cut-off: the last analysis on or before
   * it, its measures from the measure history, and that analysis's gate.
   * `analysisDate` is null when nothing was analysed before the cut-off.
   */
  async function metricsAsAt(repository, projectKey, asOfDate) {
    const base = {
      configured: true,
      repository,
      projectKey,
      asOf: asOfDate.toISOString()
    }
    const analyses = await sonarGet('/api/project_analyses/search', {
      project: projectKey,
      to: sonarDateTime(asOfDate),
      ps: '1'
    })
    const analysis = analyses?.analyses?.[0]
    if (!analysis) {
      return {
        ...base,
        analysisDate: null,
        qualityGate: 'none',
        ratings: ratingsFrom({}),
        measures: {}
      }
    }

    const [history, statusResponse] = await Promise.all([
      sonarGet('/api/measures/search_history', {
        component: projectKey,
        metrics: BRANCH_METRIC_KEYS.join(','),
        from: analysis.date,
        to: analysis.date
      }),
      sonarGet('/api/qualitygates/project_status', {
        analysisId: analysis.key
      })
    ])
    const measures = historyMeasures(history)
    return {
      ...base,
      analysisDate: new Date(analysis.date).toISOString(),
      qualityGate: mapGateStatus(statusResponse?.projectStatus?.status),
      ratings: ratingsFrom(measures),
      measures
    }
  }

  /** New-code quality for one pull request. */
  async function getPrMetrics(repository, prNumber, { db } = {}) {
    const projectKey = await repositoryProjectKey(db, repository)
    if (!projectKey) {
      return { configured: true, linked: false, repository }
    }

    const prNum = Number(prNumber)
    const pullRequest = String(prNumber)
    const url = `${apiBase}/summary/new_code?id=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(pullRequest)}`

    if (db) {
      const snapshot = await db
        .collection('sonar-pr-snapshots')
        .findOne({ repository, prNumber: prNum })
      if (snapshot) {
        return {
          configured: true,
          url,
          ...snapshot
        }
      }
    }

    try {
      const [measuresResponse, statusResponse] = await Promise.all([
        sonarGet('/api/measures/component', {
          component: projectKey,
          pullRequest,
          metricKeys: PR_METRIC_KEYS.join(',')
        }),
        sonarGet('/api/qualitygates/project_status', {
          projectKey,
          pullRequest
        })
      ])

      const measures = flattenMeasures(measuresResponse)
      const firstScanQualityGate = mapGateStatus(
        statusResponse?.projectStatus?.status
      )

      const result = {
        configured: true,
        repository,
        projectKey,
        prNumber: prNum,
        url,
        analyzed: true,
        qualityGate: firstScanQualityGate,
        firstScanQualityGate,
        ratings: ratingsFrom(measures),
        measures
      }

      if (db) {
        await db.collection('sonar-pr-snapshots').updateOne(
          { repository, prNumber: prNum },
          {
            $set: {
              repository,
              projectKey,
              prNumber: prNum,
              url,
              analyzed: true,
              qualityGate: firstScanQualityGate,
              firstScanQualityGate,
              ratings: result.ratings,
              measures: result.measures,
              capturedAt: new Date()
            }
          },
          { upsert: true }
        )
      }

      return result
    } catch (error) {
      // A 404 means SonarCloud has never analysed this PR — surface a
      // "not analysed" result rather than a hard error.
      if (error instanceof SonarHttpError && error.status === NOT_FOUND) {
        return {
          configured: true,
          repository,
          projectKey,
          prNumber: prNum,
          url,
          analyzed: false,
          qualityGate: 'none',
          ratings: { reliability: null, security: null, maintainability: null },
          measures: {}
        }
      }
      throw error
    }
  }

  /**
   * Main-branch quality gate and headline measures for every linked
   * repository — powers the portfolio repository cards.
   */
  async function getOverview({ asOf, db } = {}) {
    const linked = await linkedRepositories(db)
    const results = await Promise.allSettled(
      linked.map(({ fullName, sonarProjectKey }) =>
        metricsForProject(fullName, sonarProjectKey, { asOf, db })
      )
    )

    return results.flatMap((result, index) => {
      const repository = linked[index].fullName
      const metrics = result.status === 'fulfilled' ? result.value : null

      if (metrics && 'projectKey' in metrics && 'ratings' in metrics) {
        return [
          {
            repository,
            projectKey: metrics.projectKey,
            url: metrics.url,
            qualityGate: metrics.qualityGate,
            measures: overviewMeasures(metrics.measures),
            ...(metrics.asOf && {
              asOf: new Date(metrics.asOf).toISOString(),
              analysisDate: metrics.analysisDate ?? null
            })
          }
        ]
      }

      logger.warn(
        { err: result.status === 'rejected' ? result.reason : undefined },
        `Sonar overview: skipping ${repository}`
      )
      return []
    })
  }

  return {
    validateToken,
    getRepoMetrics,
    getPrMetrics,
    getOverview
  }
}
