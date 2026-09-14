import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'

/**
 * SonarCloud read-only client.
 *
 * The browser must never hold the Sonar token, so every SonarCloud Web API call
 * is made here and exposed to the dashboard through the `/api/sonar/*` routes.
 * The client degrades gracefully by design: with no project map it reports
 * itself "not configured"; a repository absent from the map is "not linked";
 * and a 404 from SonarCloud is treated as "not analysed" rather than an error.
 * In every one of those cases the dashboard simply hides the affected panel.
 */

// Overall (whole-branch) metrics shown on a repository's main branch.
const BRANCH_METRIC_KEYS = [
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
const PR_METRIC_KEYS = [
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
  'new_lines'
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

function parseProjectMap(raw, logger) {
  if (!raw.trim()) {
    return {}
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger.warn(
      { err: error },
      'SONAR_PROJECT_MAP is not valid JSON — ignoring'
    )
    return {}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('SONAR_PROJECT_MAP is not a JSON object — ignoring')
    return {}
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([, key]) => typeof key === 'string' && key.trim())
      .map(([repository, key]) => [repository, key.trim()])
  )
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
    measures.map((measure) => [
      measure.metric,
      toNumber(
        measure.value ?? measure.period?.value ?? measure.periods?.[0]?.value
      )
    ])
  )
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

export function createSonarClient(options = {}) {
  const {
    baseUrl = config.get('sonar.baseUrl'),
    token = config.get('sonar.token'),
    projectMap: rawProjectMap = config.get('sonar.projectMap'),
    requestTimeoutMs = config.get('sonar.requestTimeoutMs'),
    cacheTtlMs = config.get('sonar.cacheTtlMs'),
    dispatcher = createProxyDispatcher(),
    logger = createLogger()
  } = options

  const apiBase = baseUrl.replace(/\/+$/, '')
  const projectMap = parseProjectMap(rawProjectMap, logger)
  const hasToken = Boolean(token) && !isPlaceholder(token)
  const cache = new Map()

  /**
   * The integration is "configured" as soon as a project map is present. A
   * token is only needed for private SonarCloud projects — public ones are
   * readable anonymously — so it is optional and simply added when available.
   */
  function isConfigured() {
    return Object.keys(projectMap).length > 0
  }

  function projectKeyFor(repository) {
    // `repository` is caller-supplied, so an inherited member such as
    // 'constructor' must not resolve to a truthy "project key".
    return Object.hasOwn(projectMap, repository) ? projectMap[repository] : null
  }

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
  async function getRepoMetrics(repository) {
    if (!isConfigured()) {
      return { configured: false }
    }

    const projectKey = projectKeyFor(repository)
    if (!projectKey) {
      return { configured: true, linked: false, repository }
    }

    try {
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
        url: `${apiBase}/project/overview?id=${encodeURIComponent(projectKey)}`,
        qualityGate: mapGateStatus(statusResponse?.projectStatus?.status),
        ratings: ratingsFrom(measures),
        measures
      }
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

  /** New-code quality for one pull request. */
  async function getPrMetrics(repository, prNumber) {
    if (!isConfigured()) {
      return { configured: false }
    }

    const projectKey = projectKeyFor(repository)
    if (!projectKey) {
      return { configured: true, linked: false, repository }
    }

    const pullRequest = String(prNumber)
    const url = `${apiBase}/summary/new_code?id=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(pullRequest)}`

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

      return {
        configured: true,
        repository,
        projectKey,
        prNumber,
        url,
        analyzed: true,
        qualityGate: mapGateStatus(statusResponse?.projectStatus?.status),
        ratings: ratingsFrom(measures),
        measures
      }
    } catch (error) {
      // A 404 means SonarCloud has never analysed this PR — surface a
      // "not analysed" result rather than a hard error.
      if (error instanceof SonarHttpError && error.status === NOT_FOUND) {
        return {
          configured: true,
          repository,
          projectKey,
          prNumber,
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
   * Main-branch quality-gate status for every linked repository — powers the
   * portfolio "N passed / N warning / N failed" summary.
   */
  async function getOverview() {
    if (!isConfigured()) {
      return { configured: false }
    }

    const repositories = Object.keys(projectMap)
    const results = await Promise.allSettled(
      repositories.map((repository) => getRepoMetrics(repository))
    )

    return results.flatMap((result, index) => {
      const repository = repositories[index]
      const metrics = result.status === 'fulfilled' ? result.value : null

      if (metrics && 'projectKey' in metrics && 'ratings' in metrics) {
        return [
          {
            repository,
            projectKey: metrics.projectKey,
            url: metrics.url,
            qualityGate: metrics.qualityGate
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
    isConfigured,
    projectKeyFor,
    validateToken,
    getRepoMetrics,
    getPrMetrics,
    getOverview
  }
}
