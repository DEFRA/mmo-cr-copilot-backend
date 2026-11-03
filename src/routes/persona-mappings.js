import Boom from '@hapi/boom'

import { loadProject, PROJECT_ROLES } from '#/common/helpers/project-access.js'
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '#/schemas/audit-log.js'
import {
  githubHandleParamSchema,
  personaMappingPayloadSchema
} from '#/schemas/persona-mapping.js'
import { projectSlugParamSchema } from '#/schemas/project.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  deletePersonaMapping,
  findPersonaMapping,
  listPersonaMappings,
  upsertPersonaMapping
} from '#/services/persona-mappings.js'

const statusNoContent = 204
const handleParams = projectSlugParamSchema.concat(githubHandleParamSchema)
const actorOf = (user) => ({ oid: user.oid, name: user.name })

export const personaMappings = [
  {
    method: 'GET',
    path: '/api/projects/{slug}/persona-mappings',
    options: { validate: { params: projectSlugParamSchema } },
    handler: async (request, h) => {
      const { project } = await loadProject(request)
      const mappings = await listPersonaMappings(request.db, project.slug)
      return h.response({ mappings })
    }
  },
  {
    method: 'PUT',
    path: '/api/projects/{slug}/persona-mappings/{githubHandle}',
    options: {
      validate: {
        params: handleParams,
        payload: personaMappingPayloadSchema
      }
    },
    handler: async (request, h) => {
      const { project, user } = await loadProject(request, PROJECT_ROLES.admin)
      const { githubHandle } = request.params
      const { persona } = request.payload

      const previous = await findPersonaMapping(
        request.db,
        project.slug,
        githubHandle
      )
      const mapping = await upsertPersonaMapping(
        request.db,
        project.slug,
        githubHandle,
        persona
      )

      await recordAuditEvent(
        request.db,
        {
          action: AUDIT_ACTIONS.personaMappingUpserted,
          entity: AUDIT_ENTITIES.personaMapping,
          entityId: githubHandle,
          projectSlug: project.slug,
          summary: previous
            ? `Role for '${githubHandle}' changed from '${previous.persona}' to '${persona}'`
            : `Role '${persona}' assigned to '${githubHandle}'`,
          before: previous ? { persona: previous.persona } : null,
          after: { persona },
          actor: actorOf(user)
        },
        request.logger
      )

      request.logger.info(
        `Set persona '${persona}' for GitHub handle '${githubHandle}' in ${project.slug}`
      )

      return h.response(mapping)
    }
  },
  {
    method: 'DELETE',
    path: '/api/projects/{slug}/persona-mappings/{githubHandle}',
    options: { validate: { params: handleParams } },
    handler: async (request, h) => {
      const { project, user } = await loadProject(request, PROJECT_ROLES.admin)
      const { githubHandle } = request.params

      const previous = await findPersonaMapping(
        request.db,
        project.slug,
        githubHandle
      )
      const deleted = await deletePersonaMapping(
        request.db,
        project.slug,
        githubHandle
      )

      if (!deleted) {
        throw Boom.notFound(`No persona mapping for '${githubHandle}'`)
      }

      await recordAuditEvent(
        request.db,
        {
          action: AUDIT_ACTIONS.personaMappingDeleted,
          entity: AUDIT_ENTITIES.personaMapping,
          entityId: githubHandle,
          projectSlug: project.slug,
          summary: `Role mapping for '${githubHandle}' removed`,
          before: previous ? { persona: previous.persona } : null,
          after: null,
          actor: actorOf(user)
        },
        request.logger
      )

      request.logger.info(
        `Removed persona mapping for GitHub handle '${githubHandle}' in ${project.slug}`
      )

      return h.response().code(statusNoContent)
    }
  }
]
