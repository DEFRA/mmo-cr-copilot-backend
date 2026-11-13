import { HTTP_STATUS } from '#/common/constants/http-status.js'
import { requireDashboardAdmin } from '#/common/helpers/project-access.js'
import {
  roleMappingCreateSchema,
  roleMappingIdParamSchema,
  roleMappingListQuerySchema,
  roleMappingUpdateSchema
} from '#/schemas/role-mapping.js'
import {
  createRoleMapping,
  deleteRoleMapping,
  listRoleMappings,
  updateRoleMapping
} from '#/services/role-mappings.js'

const actorOf = (user) => ({ oid: user.oid, name: user.name })
const MAX_BODY_BYTES = 4096

const jsonBody = { maxBytes: MAX_BODY_BYTES, allow: 'application/json' }

// Role mappings grant access, so managing them is Dashboard Admin only.
export const roleMappingsRoutes = [
  {
    method: 'GET',
    path: '/api/role-mappings',
    options: { validate: { query: roleMappingListQuerySchema } },
    handler: async (request, h) => {
      requireDashboardAdmin(request)
      const roleMappings = await listRoleMappings(request.db, request.query)
      return h.response({ roleMappings })
    }
  },
  {
    method: 'POST',
    path: '/api/role-mappings',
    options: {
      payload: jsonBody,
      validate: { payload: roleMappingCreateSchema }
    },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      const roleMapping = await createRoleMapping(
        request.db,
        request.payload,
        actorOf(user),
        request.logger
      )
      return h.response({ roleMapping }).code(HTTP_STATUS.created)
    }
  },
  {
    method: 'PATCH',
    path: '/api/role-mappings/{id}',
    options: {
      payload: jsonBody,
      validate: {
        params: roleMappingIdParamSchema,
        payload: roleMappingUpdateSchema
      }
    },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      const roleMapping = await updateRoleMapping(
        request.db,
        request.params.id,
        request.payload,
        actorOf(user),
        request.logger
      )
      return h.response({ roleMapping })
    }
  },
  {
    method: 'DELETE',
    path: '/api/role-mappings/{id}',
    options: { validate: { params: roleMappingIdParamSchema } },
    handler: async (request, h) => {
      const { user } = requireDashboardAdmin(request)
      await deleteRoleMapping(
        request.db,
        request.params.id,
        actorOf(user),
        request.logger
      )
      return h.response().code(HTTP_STATUS.noContent)
    }
  }
]
