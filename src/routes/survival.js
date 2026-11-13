import { config } from '#/config.js'
import { HTTP_STATUS } from '#/common/constants/http-status.js'
import { requireIngestToken } from '#/common/helpers/ingest-auth.js'
import { survivalSchema } from '#/schemas/survival.js'
import { SURVIVAL_STATUS, saveSurvival } from '#/services/survival.js'

const MAX_SURVIVAL_BYTES = 256 * 1024

export const survival = [
  {
    method: 'POST',
    path: '/api/survival',
    options: {
      auth: false,
      pre: [{ method: requireIngestToken }],
      payload: {
        parse: true,
        allow: 'application/json',
        maxBytes: Math.min(
          config.get('ingest.maxPayloadBytes'),
          MAX_SURVIVAL_BYTES
        )
      },
      validate: { payload: survivalSchema }
    },
    handler: async (request, h) => {
      const { status } = await saveSurvival(request.db, request.payload)
      const { repository, prNumber, windowDays } = request.payload

      request.logger.info(
        `${status} AI survival for ${repository}#${prNumber} windowDays=${windowDays}`
      )

      return h
        .response({ status, repository, prNumber, windowDays })
        .code(
          status === SURVIVAL_STATUS.created
            ? HTTP_STATUS.created
            : HTTP_STATUS.ok
        )
    }
  }
]
