import { config } from '#/config.js'
import { overviewMeasures } from '#/services/sonar.js'

const NO_RATINGS = { reliability: null, security: null, maintainability: null }

/**
 * Local-development Sonar source (ADR 0006): answers /api/sonar/* from the
 * stored snapshots, in the live client's response shapes, with no outbound call.
 */
export function createSonarSnapshotReader({
  baseUrl = config.get('sonar.baseUrl')
} = {}) {
  const apiBase = baseUrl.replace(/\/+$/, '')
  const overviewUrl = (key) =>
    `${apiBase}/project/overview?id=${encodeURIComponent(key)}`

  const linkedRepositories = (db) =>
    db
      .collection('repositories')
      .find(
        { sonarProjectKey: { $nin: [null, ''] } },
        { projection: { _id: 0, fullName: 1, sonarProjectKey: 1 } }
      )
      .sort({ fullName: 1 })
      .toArray()

  async function projectKeyFor(db, repository) {
    const repo = await db
      .collection('repositories')
      .findOne(
        { fullName: String(repository) },
        { projection: { sonarProjectKey: 1 } }
      )
    return repo?.sonarProjectKey || null
  }

  async function repoMetrics(db, repository, projectKey, asOf) {
    const asOfDate = asOf ? new Date(asOf) : null
    const historical = Boolean(asOfDate) && asOfDate.getTime() < Date.now()
    const cutoff = historical ? asOfDate : new Date()
    const snapshot = await db
      .collection('sonar-snapshots')
      .findOne(
        { repository: String(repository), asOf: { $lte: cutoff } },
        { sort: { asOf: -1 }, projection: { _id: 0 } }
      )
    const base = {
      configured: true,
      repository,
      projectKey,
      url: overviewUrl(projectKey),
      ...(historical && { asOf: cutoff.toISOString() })
    }
    if (!snapshot) {
      return {
        ...base,
        analysisDate: null,
        qualityGate: 'none',
        ratings: NO_RATINGS,
        measures: {}
      }
    }
    return {
      ...base,
      analysisDate: new Date(
        snapshot.analysisDate ?? snapshot.asOf
      ).toISOString(),
      qualityGate: snapshot.qualityGate ?? 'none',
      ratings: snapshot.ratings ?? NO_RATINGS,
      measures: snapshot.measures ?? {}
    }
  }

  return {
    isConfigured: () => true,
    validateToken: async () => {},

    async getRepoMetrics(repository, { asOf, db } = {}) {
      const projectKey = await projectKeyFor(db, repository)
      if (!projectKey) return { configured: true, linked: false, repository }
      return repoMetrics(db, repository, projectKey, asOf)
    },

    async getOverview({ asOf, db } = {}) {
      const repos = await linkedRepositories(db)
      const results = await Promise.all(
        repos.map((r) => repoMetrics(db, r.fullName, r.sonarProjectKey, asOf))
      )
      return results.map((m) => ({
        repository: m.repository,
        projectKey: m.projectKey,
        url: m.url,
        qualityGate: m.qualityGate,
        measures: overviewMeasures(m.measures),
        ...(m.asOf && { asOf: m.asOf, analysisDate: m.analysisDate })
      }))
    },

    async getPrMetrics(repository, prNumber, { db } = {}) {
      const projectKey = await projectKeyFor(db, repository)
      if (!projectKey) return { configured: true, linked: false, repository }
      const prNum = Number(prNumber)
      const url = `${apiBase}/summary/new_code?id=${encodeURIComponent(projectKey)}&pullRequest=${encodeURIComponent(String(prNum))}`
      const snapshot = await db
        .collection('sonar-pr-snapshots')
        .findOne(
          { repository: String(repository), prNumber: prNum },
          { projection: { _id: 0 } }
        )
      if (snapshot) return { configured: true, url, ...snapshot }
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
  }
}
