import Boom from '@hapi/boom'
import Joi from 'joi'

import {
  assertRepositoryRole,
  readableRepositoryNames,
  requireUser
} from '#/common/helpers/project-access.js'

/**
 * Read-only proxy to SonarCloud; token stays server-side and degrades gracefully.
 */

// SonarCloud is a third party — surface its failures as a bad gateway.
const upstreamFailure = (request, error, message) => {
  request.logger.error({ err: error }, message)
  return Boom.badGateway(message)
}

const repositoryQuery = Joi.object({
  // Repository is a query param to prevent proxies from splitting repo paths.
  repository: Joi.string().min(1).max(512).required(),
  asOf: Joi.date().iso().optional()
})

export const sonar = [
  {
    method: 'GET',
    path: '/api/sonar/overview',
    options: {
      validate: {
        query: Joi.object({
          asOf: Joi.date().iso().optional()
        })
      }
    },
    handler: async (request, h) => {
      const user = requireUser(request)
      try {
        const overview = await request.sonar.getOverview({
          asOf: request.query.asOf,
          db: request.db
        })
        const allowed = Array.isArray(overview)
          ? await readableRepositoryNames(request.db, user)
          : null
        return h.response(
          allowed
            ? overview.filter((entry) => allowed.has(entry.repository))
            : overview
        )
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
      await assertRepositoryRole(request, request.query.repository)
      try {
        return h.response(
          await request.sonar.getRepoMetrics(request.query.repository, {
            asOf: request.query.asOf,
            db: request.db
          })
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
      await assertRepositoryRole(request, repository)

      try {
        return h.response(
          await request.sonar.getPrMetrics(repository, prNumber, {
            db: request.db
          })
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
