import Boom from '@hapi/boom'

import { requireUser } from '#/common/helpers/project-access.js'

function presentUser(user) {
  const { oid, tid, name, email, roles, projectRoles, allowedProjects } = user
  return { oid, tid, name, email, roles, projectRoles, allowedProjects }
}

export const authRoutes = [
  {
    // The BFF calls this once after sign-in: the token was already validated
    // by the entra strategy, so this only decides whether the user may enter.
    method: 'POST',
    path: '/api/auth/authorize',
    handler: (request, h) => {
      const user = requireUser(request)
      const hasAccess = user.roles.length > 0 || user.allowedProjects.length > 0
      if (!hasAccess) {
        request.logger.warn(
          {
            event: {
              category: 'authentication',
              action: 'authorize',
              outcome: 'failure',
              reason: 'no-role-mapping'
            },
            user: { id: user.oid }
          },
          'Signed-in user has no role mapping'
        )
        throw Boom.forbidden('No assigned roles in this application')
      }
      return h.response({ user: presentUser(user) })
    }
  },
  {
    // The BFF calls this after a token refresh to pick up changed mappings.
    method: 'GET',
    path: '/api/auth/me',
    handler: (request, h) =>
      h.response({ user: presentUser(requireUser(request)) })
  }
]
