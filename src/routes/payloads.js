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
import { recordAuditEvent } from '#/services/audit-logs.js'
import {
  CLASSIFICATION_UPDATE,
  findLatestPayloads,
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
      const { record, stored } = await savePayload(
        request.db,
        request.payload,
        request.logger
      )

      request.logger.info(
        `${stored ? 'Stored' : 'Ignored stale'} analytics payload for ${record.repository}#${record.prNumber} buildId=${record.buildId}`
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
    path: '/api/payloads',
    handler: async (request, h) => {
      const results = await findLatestPayloads(request.db)
      return h.response({ payloads: results })
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
            summary: `Commit ${commit} on ${repository}#${prNumber} re-classified from '${previousClassification}' to '${classification}'`,
            before: { classification: previousClassification },
            after: { classification }
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
