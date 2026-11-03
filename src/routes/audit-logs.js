import {
  loadProject,
  requireDashboardAdmin
} from '#/common/helpers/project-access.js'
import { auditLogQuerySchema } from '#/schemas/audit-log.js'
import { projectSlugParamSchema } from '#/schemas/project.js'
import { findAuditLogs } from '#/services/audit-logs.js'

export const auditLogs = [
  {
    method: 'GET',
    path: '/api/audit-logs',
    options: {
      validate: { query: auditLogQuerySchema }
    },
    handler: async (request, h) => {
      requireDashboardAdmin(request)
      const result = await findAuditLogs(request.db, request.query)
      return h.response(result)
    }
  },
  {
    method: 'GET',
    path: '/api/projects/{slug}/audit-logs',
    options: {
      validate: {
        params: projectSlugParamSchema,
        query: auditLogQuerySchema
      }
    },
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      const result = await findAuditLogs(request.db, {
        ...request.query,
        projectSlug: project.slug
      })
      return h.response(result)
    }
  }
]
