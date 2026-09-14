import Boom from '@hapi/boom'
import Joi from 'joi'

/**
 * Read-only proxy to SonarCloud. The token lives only on the server; these
 * routes hand the dashboard a compact, already-shaped view of the metrics.
 * Every handler degrades gracefully: `{ configured: false }` when the project
 * map is missing, `{ linked: false }` when a repository has no Sonar project.
 */

// SonarCloud is a third party — surface its failures as a bad gateway.
const upstreamFailure = (request, error, message) => {
  request.logger.error({ err: error }, message)
  return Boom.badGateway(message)
}

const repositoryQuery = Joi.object({
  // Repository is a query parameter rather than a path segment because it
  // contains a '/', which proxies ahead of the service may decode and split.
  repository: Joi.string().min(1).max(512).required()
})

export const sonar = [
  {
    method: 'GET',
    path: '/api/sonar/overview',
    handler: async (request, h) => {
      try {
        return h.response(await request.sonar.getOverview())
      } catch (error) {
        return upstreamFailure(
          request,
          error,
          'Failed to fetch SonarCloud overview'
        )
      }
    }
  },
  {
    method: 'GET',
    path: '/api/sonar/repo',
    options: {
      validate: { query: repositoryQuery }
    },
    handler: async (request, h) => {
      try {
        return h.response(
          await request.sonar.getRepoMetrics(request.query.repository)
        )
      } catch (error) {
        return upstreamFailure(
          request,
          error,
          'Failed to fetch SonarCloud metrics'
        )
      }
    }
  },
  {
    method: 'GET',
    path: '/api/sonar/pr',
    options: {
      validate: {
        query: repositoryQuery.keys({
          prNumber: Joi.number().integer().min(1).required()
        })
      }
    },
    handler: async (request, h) => {
      const { repository, prNumber } = request.query

      try {
        return h.response(
          await request.sonar.getPrMetrics(repository, prNumber)
        )
      } catch (error) {
        return upstreamFailure(
          request,
          error,
          'Failed to fetch SonarCloud PR metrics'
        )
      }
    }
  }
]
