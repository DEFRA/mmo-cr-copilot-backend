import { config } from '#/config.js'
import { trimTrailingSlashes } from '#/common/helpers/url.js'
import {
  linkedRepositories,
  overviewMeasures,
  repositoryProjectKey
} from '#/services/sonar.js'

const NO_RATINGS = { reliability: null, security: null, maintainability: null }
const NOT_LINKED = (repository) => ({
  configured: true,
  linked: false,
  repository
})

const overviewUrl = (apiBase, key) =>
  `${apiBase}/project/overview?id=${encodeURIComponent(key)}`

function snapshotMetrics(snapshot) {
  if (!snapshot) {
    return {
      analysisDate: null,
      qualityGate: 'none',
      ratings: NO_RATINGS,
      measures: {}
    }
  }
  return {
    analysisDate: new Date(
      snapshot.analysisDate ?? snapshot.asOf
    ).toISOString(),
    qualityGate: snapshot.qualityGate ?? 'none',
    ratings: snapshot.ratings ?? NO_RATINGS,
    measures: snapshot.measures ?? {}
  }
}

async function repoMetrics({ apiBase, db, repository, projectKey, asOf }) {
  const asOfDate = asOf ? new Date(asOf) : null
  const historical = Boolean(asOfDate) && asOfDate.getTime() < Date.now()
  const cutoff = historical ? asOfDate : new Date()
  const snapshot = await db
    .collection('sonar-snapshots')
    .findOne(
      { repository: String(repository), asOf: { $lte: cutoff } },
      { sort: { asOf: -1 }, projection: { _id: 0 } }
    )
  return {
    configured: true,
    repository,
    projectKey,
    url: overviewUrl(apiBase, projectKey),
    ...(historical && { asOf: cutoff.toISOString() }),
    ...snapshotMetrics(snapshot)
  }
}

async function overview(apiBase, { asOf, db } = {}) {
  const repos = await linkedRepositories(db)
  const results = await Promise.all(
    repos.map((r) =>
      repoMetrics({
        apiBase,
        db,
        repository: r.fullName,
        projectKey: r.sonarProjectKey,
        asOf
      })
    )
  )
  return results.map((m) => ({
    repository: m.repository,
    projectKey: m.projectKey,
    url: m.url,
    qualityGate: m.qualityGate,
    measures: overviewMeasures(m.measures),
    ...(m.asOf && { asOf: m.asOf, analysisDate: m.analysisDate })
  }))
}

async function prMetrics(apiBase, repository, prNumber, { db } = {}) {
  const projectKey = await repositoryProjectKey(db, repository)
  if (!projectKey) {
    return NOT_LINKED(repository)
  }
  const prNum = Number(prNumber)
  const url = `${apiBase}/summary/new_code?id=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(String(prNum))}`
  const snapshot = await db
    .collection('sonar-pr-snapshots')
    .findOne(
      { repository: String(repository), prNumber: prNum },
      { projection: { _id: 0 } }
    )
  if (snapshot) {
    return { configured: true, url, ...snapshot }
  }
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

/**
 * Local-development Sonar source (ADR 0006): answers /api/sonar/* from the
 * stored snapshots, in the live client's response shapes, with no outbound call.
 */
export function createSonarSnapshotReader({
  baseUrl = config.get('sonar.baseUrl')
} = {}) {
  const apiBase = trimTrailingSlashes(baseUrl)
  return {
    validateToken: async () => {},

    async getRepoMetrics(repository, { asOf, db } = {}) {
      const projectKey = await repositoryProjectKey(db, repository)
      if (!projectKey) {
        return NOT_LINKED(repository)
      }
      return repoMetrics({ apiBase, db, repository, projectKey, asOf })
    },

    getOverview: (options) => overview(apiBase, options),

    getPrMetrics: (repository, prNumber, options) =>
      prMetrics(apiBase, repository, prNumber, options)
  }
}
