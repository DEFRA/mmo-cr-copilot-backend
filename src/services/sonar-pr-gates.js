import { config } from '#/config.js'
import {
  TIMED_OUT,
  mapWithConcurrency,
  withinBudget
} from '#/common/helpers/concurrency.js'
import { linkedRepositories } from '#/services/sonar.js'

const SONAR_PR_SNAPSHOTS_COLLECTION = 'sonar-pr-snapshots'
const CONCURRENCY = 4
const idOf = (pr) => `${pr.repository}#${pr.prNumber}`

/** Captures the quality gate of linked PRs with no stored snapshot, within a time budget. */
export async function ensurePrQualityGates({
  db,
  sonar,
  prs,
  logger,
  budgetMs = config.get('sonar.lazyGateBudgetMs'),
  maxPrs = config.get('sonar.lazyGateMaxPrs')
}) {
  if (!sonar || prs.length === 0) {
    return { stale: false }
  }
  const unique = [...new Map(prs.map((pr) => [idOf(pr), pr])).values()]
  const [stored, linked] = await Promise.all([
    db
      .collection(SONAR_PR_SNAPSHOTS_COLLECTION)
      .find(
        {
          $or: unique.map(({ repository, prNumber }) => ({
            repository,
            prNumber
          }))
        },
        { projection: { _id: 0, repository: 1, prNumber: 1 } }
      )
      .toArray(),
    linkedRepositories(db)
  ])
  const have = new Set(stored.map(idOf))
  const sonarRepos = new Set(linked.map((repo) => repo.fullName))
  const missing = unique.filter(
    (pr) => sonarRepos.has(pr.repository) && !have.has(idOf(pr))
  )
  const batch = missing.slice(0, maxPrs)
  let failed = 0
  const work = mapWithConcurrency(batch, CONCURRENCY, (pr) =>
    sonar.getPrMetrics(pr.repository, pr.prNumber, { db }).catch((err) => {
      failed += 1
      logger.warn(
        { err },
        `SonarCloud quality gate unavailable for ${pr.repository}#${pr.prNumber}`
      )
    })
  )
  const outcome = await withinBudget(work, budgetMs)
  return {
    stale: outcome === TIMED_OUT || failed > 0 || missing.length > batch.length
  }
}
