import { config } from '#/config.js'
import { createLogger } from '#/common/helpers/logging/logger.js'
import { createProxyDispatcher } from '#/common/helpers/proxy.js'
import { trimTrailingSlashes } from '#/common/helpers/url.js'

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
const ISO_SECONDS_LENGTH = 'yyyy-MM-ddTHH:mm:ss'.length
function sonarDateTime(date) {
  return `${date.toISOString().slice(0, ISO_SECONDS_LENGTH)}+0000`
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

const SNAPSHOTS = 'sonar-snapshots'
const PR_SNAPSHOTS = 'sonar-pr-snapshots'
const GATE_STATUS_PATH = '/api/qualitygates/project_status'
const MEASURES_PATH = '/api/measures/component'
const MAX_ERROR_BODY_CHARS = 200
const NO_RATINGS = { reliability: null, security: null, maintainability: null }
const notLinked = (repository) => ({
  configured: true,
  linked: false,
  repository
})
const isNotFound = (error) =>
  error instanceof SonarHttpError && error.status === NOT_FOUND

function createSonarGet(settings) {
  const { apiBase, token, hasToken, cacheTtlMs, logger, requestInit } = settings
  const cache = new Map()
  const authHeaders = hasToken ? { Authorization: `Bearer ${token}` } : {}

  return async function sonarGet(pathname, params) {
    const url = `${apiBase}${pathname}?${new URLSearchParams(params)}`
    const cached = cache.get(url)
    if (cached && cached.expires > Date.now()) {
      return cached.data
    }

    let response = await fetch(url, requestInit(authHeaders))
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
        `${pathname} → ${response.status} ${body.slice(0, MAX_ERROR_BODY_CHARS)}`
      )
    }
    const data = await response.json()
    cache.set(url, { expires: Date.now() + cacheTtlMs, data })
    return data
  }
}

/**
 * Diagnostic only: each call already retries anonymously on 401, but nothing
 * else fails loudly enough when the token is simply wrong.
 */
async function validateToken(ctx) {
  if (!ctx.hasToken) {
    return
  }
  try {
    const response = await fetch(
      `${ctx.apiBase}/api/authentication/validate`,
      ctx.requestInit({ Authorization: `Bearer ${ctx.token}` })
    )
    const body = await response.json()
    if (body?.valid === false) {
      ctx.logger.error(
        'SONAR_TOKEN is not valid according to SonarCloud (My Account > Security). Public projects still work anonymously; private projects stay hidden until a valid token is set.'
      )
    } else {
      ctx.logger.info('SONAR_TOKEN validated successfully')
    }
  } catch (error) {
    ctx.logger.warn({ err: error }, 'Could not validate SONAR_TOKEN at startup')
  }
}

async function currentMetrics(ctx, repository, projectKey) {
  const [measuresResponse, statusResponse] = await Promise.all([
    ctx.get(MEASURES_PATH, {
      component: projectKey,
      metricKeys: BRANCH_METRIC_KEYS.join(',')
    }),
    ctx.get(GATE_STATUS_PATH, { projectKey })
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
async function metricsAsAt(ctx, repository, projectKey, asOfDate) {
  const base = {
    configured: true,
    repository,
    projectKey,
    asOf: asOfDate.toISOString()
  }
  const analyses = await ctx.get('/api/project_analyses/search', {
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
    ctx.get('/api/measures/search_history', {
      component: projectKey,
      metrics: BRANCH_METRIC_KEYS.join(','),
      from: analysis.date,
      to: analysis.date
    }),
    ctx.get(GATE_STATUS_PATH, { analysisId: analysis.key })
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

function saveSnapshot(db, repository, projectKey, asOfDate, result) {
  return db.collection(SNAPSHOTS).updateOne(
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

// A closed sprint's snapshot never changes, so it is served from the store.
async function historicalMetrics(
  ctx,
  repository,
  projectKey,
  { asOfDate, db }
) {
  const snapshot = db
    ? await db.collection(SNAPSHOTS).findOne({ repository, asOf: asOfDate })
    : null
  if (snapshot) {
    return snapshot
  }
  const result = await metricsAsAt(ctx, repository, projectKey, asOfDate)
  if (db) {
    await saveSnapshot(db, repository, projectKey, asOfDate, result)
  }
  return result
}

async function metricsForProject(ctx, repository, projectKey, { asOf, db }) {
  const asOfDate = asOf ? new Date(asOf) : null
  const historical = Boolean(asOfDate) && asOfDate.getTime() < Date.now()
  const url = `${ctx.apiBase}/project/overview?id=${encodeURIComponent(projectKey)}`
  try {
    const result = historical
      ? await historicalMetrics(ctx, repository, projectKey, { asOfDate, db })
      : await currentMetrics(ctx, repository, projectKey)
    return { configured: true, ...result, url }
  } catch (error) {
    // A 404 means the mapped project key does not exist or has not been
    // analysed yet — treat it as "not linked" so the panel hides.
    if (isNotFound(error)) {
      ctx.logger.warn(
        `Sonar project not found for ${repository} (key=${projectKey}); hiding panel`
      )
      return notLinked(repository)
    }
    throw error
  }
}

async function fetchPrMetrics(ctx, pr) {
  const { projectKey, pullRequest } = pr
  const [measuresResponse, statusResponse] = await Promise.all([
    ctx.get(MEASURES_PATH, {
      component: projectKey,
      pullRequest,
      metricKeys: PR_METRIC_KEYS.join(',')
    }),
    ctx.get(GATE_STATUS_PATH, { projectKey, pullRequest })
  ])
  const measures = flattenMeasures(measuresResponse)
  const firstScanQualityGate = mapGateStatus(
    statusResponse?.projectStatus?.status
  )
  return {
    configured: true,
    repository: pr.repository,
    projectKey,
    prNumber: pr.prNumber,
    url: pr.url,
    analyzed: true,
    qualityGate: firstScanQualityGate,
    firstScanQualityGate,
    ratings: ratingsFrom(measures),
    measures
  }
}

function savePrSnapshot(db, result) {
  const snapshot = { ...result, capturedAt: new Date() }
  delete snapshot.configured
  return db
    .collection(PR_SNAPSHOTS)
    .updateOne(
      { repository: result.repository, prNumber: result.prNumber },
      { $set: snapshot },
      { upsert: true }
    )
}

/** New-code quality for one pull request. */
async function getPrMetrics(ctx, repository, prNumber, { db } = {}) {
  const projectKey = await repositoryProjectKey(db, repository)
  if (!projectKey) {
    return notLinked(repository)
  }
  const prNum = Number(prNumber)
  const pullRequest = String(prNumber)
  const url = `${ctx.apiBase}/summary/new_code?id=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(pullRequest)}`
  const snapshot = db
    ? await db.collection(PR_SNAPSHOTS).findOne({ repository, prNumber: prNum })
    : null
  if (snapshot) {
    return { configured: true, url, ...snapshot }
  }
  const pr = { repository, projectKey, prNumber: prNum, pullRequest, url }
  try {
    const result = await fetchPrMetrics(ctx, pr)
    if (db) {
      await savePrSnapshot(db, result)
    }
    return result
  } catch (error) {
    // A 404 means SonarCloud has never analysed this PR — surface a
    // "not analysed" result rather than a hard error.
    if (isNotFound(error)) {
      return {
        configured: true,
        repository,
        projectKey,
        prNumber: prNum,
        url,
        analyzed: false,
        qualityGate: 'none',
        ratings: NO_RATINGS,
        measures: {}
      }
    }
    throw error
  }
}

function overviewCard(repository, metrics) {
  return {
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
}

/**
 * Main-branch quality gate and headline measures for every linked
 * repository — powers the portfolio repository cards.
 */
async function getOverview(ctx, { asOf, db } = {}) {
  const linked = await linkedRepositories(db)
  const results = await Promise.allSettled(
    linked.map(({ fullName, sonarProjectKey }) =>
      metricsForProject(ctx, fullName, sonarProjectKey, { asOf, db })
    )
  )
  return results.flatMap((result, index) => {
    const repository = linked[index].fullName
    const metrics = result.status === 'fulfilled' ? result.value : null
    if (metrics && 'projectKey' in metrics && 'ratings' in metrics) {
      return [overviewCard(repository, metrics)]
    }
    ctx.logger.warn(
      { err: result.status === 'rejected' ? result.reason : undefined },
      `Sonar overview: skipping ${repository}`
    )
    return []
  })
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

  const requestInit = (headers) => ({
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(requestTimeoutMs),
    ...(dispatcher ? { dispatcher } : {})
  })
  const ctx = {
    apiBase: trimTrailingSlashes(baseUrl),
    token,
    // A token is only needed for private projects; public ones are read anonymously.
    hasToken: Boolean(token) && !isPlaceholder(token),
    logger,
    requestInit
  }
  ctx.get = createSonarGet({ ...ctx, cacheTtlMs })

  return {
    validateToken: () => validateToken(ctx),
    async getRepoMetrics(repository, { asOf, db } = {}) {
      const projectKey = await repositoryProjectKey(db, repository)
      if (!projectKey) {
        return notLinked(repository)
      }
      return metricsForProject(ctx, repository, projectKey, { asOf, db })
    },
    getPrMetrics: (repository, prNumber, opts) =>
      getPrMetrics(ctx, repository, prNumber, opts),
    getOverview: (opts) => getOverview(ctx, opts)
  }
}
