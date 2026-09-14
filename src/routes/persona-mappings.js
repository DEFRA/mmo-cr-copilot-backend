import Boom from '@hapi/boom'

import {
  githubHandleParamSchema,
  personaMappingPayloadSchema
} from '#/schemas/persona-mapping.js'
import {
  deletePersonaMapping,
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

      const mapping = await upsertPersonaMapping(
        request.db,
        githubHandle,
        persona
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
      const deleted = await deletePersonaMapping(request.db, githubHandle)

      if (!deleted) {
        throw Boom.notFound(`No persona mapping for '${githubHandle}'`)
      }

      request.logger.info(
        `Removed persona mapping for GitHub handle '${githubHandle}'`
      )

      return h.response().code(statusNoContent)
    }
  }
]
