import Boom from '@hapi/boom'

import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '#/schemas/audit-log.js'
import {
  githubHandleParamSchema,
  personaMappingPayloadSchema
} from '#/schemas/persona-mapping.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  deletePersonaMapping,
  findPersonaMapping,
  listPersonaMappings,
  upsertPersonaMapping
} from '#/services/persona-mappings.js'

const statusNoContent = 204

export const personaMappings = [
  {
    method: 'GET',
    path: '/api/persona-mappings',
    handler: async (request, h) => {
      const mappings = await listPersonaMappings(request.db)
      return h.response({ mappings })
    }
  },
  {
    method: 'PUT',
    path: '/api/persona-mappings/{githubHandle}',
    options: {
      validate: {
        params: githubHandleParamSchema,
        payload: personaMappingPayloadSchema
      }
    },
    handler: async (request, h) => {
      const { githubHandle } = request.params
      const { persona } = request.payload

      const previous = await findPersonaMapping(request.db, githubHandle)
      const mapping = await upsertPersonaMapping(
        request.db,
        githubHandle,
        persona
      )

      await recordAuditEvent(
        request.db,
        {
          action: AUDIT_ACTIONS.personaMappingUpserted,
          entity: AUDIT_ENTITIES.personaMapping,
          entityId: githubHandle,
          summary: previous
            ? `Role for '${githubHandle}' changed from '${previous.persona}' to '${persona}'`
            : `Role '${persona}' assigned to '${githubHandle}'`,
          before: previous ? { persona: previous.persona } : null,
          after: { persona }
        },
        request.logger
      )

      request.logger.info(
        `Set persona '${persona}' for GitHub handle '${githubHandle}'`
      )

      return h.response(mapping)
    }
  },
  {
    method: 'DELETE',
    path: '/api/persona-mappings/{githubHandle}',
    options: {
      validate: { params: githubHandleParamSchema }
    },
    handler: async (request, h) => {
      const { githubHandle } = request.params

      const previous = await findPersonaMapping(request.db, githubHandle)
      const deleted = await deletePersonaMapping(request.db, githubHandle)

      if (!deleted) {
        throw Boom.notFound(`No persona mapping for '${githubHandle}'`)
      }

      await recordAuditEvent(
        request.db,
        {
          action: AUDIT_ACTIONS.personaMappingDeleted,
          entity: AUDIT_ENTITIES.personaMapping,
          entityId: githubHandle,
          summary: `Role mapping for '${githubHandle}' removed`,
          before: previous ? { persona: previous.persona } : null,
          after: null
        },
        request.logger
      )

      request.logger.info(
        `Removed persona mapping for GitHub handle '${githubHandle}'`
      )

      return h.response().code(statusNoContent)
    }
  }
]
