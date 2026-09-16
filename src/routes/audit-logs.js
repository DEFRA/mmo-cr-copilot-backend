import { auditLogQuerySchema } from '#/schemas/audit-log.js'
import { findAuditLogs } from '#/services/audit-logs.js'

export const auditLogs = [
  {
    method: 'GET',
    path: '/api/audit-logs',
    options: {
      validate: { query: auditLogQuerySchema }
    },
    handler: async (request, h) => {
      const result = await findAuditLogs(request.db, request.query)
      return h.response(result)
    }
  }
]
