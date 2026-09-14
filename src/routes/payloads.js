import Joi from 'joi'

import { config } from '#/config.js'
import { analyticsPayloadSchema } from '#/schemas/payload.js'
import { requireIngestToken } from '#/common/helpers/ingest-auth.js'
import {
  findLatestPayloads,
  findPayloadHistory,
  savePayload
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
      const record = await savePayload(
        request.db,
        request.payload,
        request.logger
      )

      request.logger.info(
        `Stored analytics payload for ${record.repository}#${record.prNumber} buildId=${record.buildId}`
      )

      return h
        .response({
          status: 'stored',
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
  }
]
