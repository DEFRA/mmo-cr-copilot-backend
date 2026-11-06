import Joi from 'joi'
import Boom from '@hapi/boom'

import { config } from '#/config.js'
import {
  analyticsPayloadSchema,
  commitClassificationParamsSchema,
  commitClassificationPayloadSchema
} from '#/schemas/payload.js'
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '#/schemas/audit-log.js'
import { requireIngestToken } from '#/common/helpers/ingest-auth.js'
import {
  PROJECT_ROLES,
  assertRepositoryRole
} from '#/common/helpers/project-access.js'
import { recordAuditEvent } from '#/services/audit-logs.js'
import { fetchUnknownJiraIssues } from '#/plugins/jira-sync.js'
import {
  CLASSIFICATION_UPDATE,
  findPayloadHistory,
  savePayload,
  updateCommitClassification
} from '#/services/payloads.js'

const statusCreated = 201

export const payloads = [
  {
    method: 'POST',
    path: '/api/payloads',
    options: {
      auth: false,
      pre: [{ method: requireIngestToken }],
      payload: {
        parse: true,
        allow: 'application/json',
        maxBytes: config.get('ingest.maxPayloadBytes')
      },
      validate: {
        payload: analyticsPayloadSchema
      }
    },
    handler: async (request, h) => {
      const { record, stored, projectSlug } = await savePayload(
        request.db,
        request.payload,
        request.logger
      )

      if (stored && request.server?.jira) {
        // Not awaited: an unreachable Jira must never slow or fail ingest.
        fetchUnknownJiraIssues({
          db: request.db,
          client: request.server.jira,
          projectSlug,
          jiraKeys: record.jiraKeys,
          logger: request.logger
        })
      }

      request.logger.info(
        `${stored ? 'Stored' : 'Ignored stale'} analytics payload for ${record.repository}#${record.prNumber} buildId=${record.buildId} schemaVersion=${record.schemaVersion}`
      )

      return h
        .response({
          status: stored ? 'stored' : 'ignored',
          repository: record.repository,
          prNumber: record.prNumber
        })
        .code(statusCreated)
    }
  },
  {
    method: 'GET',
    path: '/api/payloads/{repository}/{prNumber}',
    options: {
      validate: {
        params: Joi.object({
          // URL-encoded on the wire (e.g. DEFRA%2Frepo-name).
          repository: Joi.string().min(1).max(512).required(),
          prNumber: Joi.number().integer().min(1).required()
        })
      }
    },
    handler: async (request, h) => {
      const { repository, prNumber } = request.params
      await assertRepositoryRole(request, repository)
      const results = await findPayloadHistory(request.db, repository, prNumber)

      return h.response({ repository, prNumber, payloads: results })
    }
  },
  {
    method: 'PATCH',
    path: '/api/payloads/{repository}/{prNumber}/commits/{commit}',
    options: {
      validate: {
        params: commitClassificationParamsSchema,
        payload: commitClassificationPayloadSchema
      }
    },
    handler: async (request, h) => {
      const { repository, prNumber, commit } = request.params
      const { user, project } = await assertRepositoryRole(
        request,
        repository,
        PROJECT_ROLES.admin
      )
      const { classification } = request.payload

      const { status, previousClassification, payload } =
        await updateCommitClassification(request.db, {
          repository,
          prNumber,
          commit,
          classification
        })

      if (status === CLASSIFICATION_UPDATE.prNotFound) {
        throw Boom.notFound(`No analytics for ${repository}#${prNumber}`)
      }

      if (status === CLASSIFICATION_UPDATE.commitNotFound) {
        throw Boom.notFound(
          `No commit '${commit}' on ${repository}#${prNumber}`
        )
      }

      if (status === CLASSIFICATION_UPDATE.prNotMerged) {
        throw Boom.conflict(
          `${repository}#${prNumber} is not merged; commit classifications can only be corrected once a pull request is merged`
        )
      }

      if (status === CLASSIFICATION_UPDATE.updated) {
        await recordAuditEvent(
          request.db,
          {
            action: AUDIT_ACTIONS.commitClassificationUpdated,
            entity: AUDIT_ENTITIES.commitClassification,
            entityId: `${repository}#${prNumber}@${commit}`,
            projectSlug: project?.slug ?? null,
            summary: `Commit ${commit} on ${repository}#${prNumber} re-classified from '${previousClassification}' to '${classification}'`,
            before: { classification: previousClassification },
            after: { classification },
            actor: { oid: user.oid, name: user.name }
          },
          request.logger
        )

        request.logger.info(
          `Re-classified commit ${commit} on ${repository}#${prNumber} as '${classification}'`
        )
      }

      return h.response({ status, payload })
    }
  }
]
