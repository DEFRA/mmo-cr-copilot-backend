import Boom from '@hapi/boom'

import { config } from '#/config.js'
import { isTokenValid } from '#/common/helpers/verify-token.js'

export const INGEST_TOKEN_HEADER = 'x-ingest-token'

/**
 * Guards the ingest endpoint with the shared secret the dashboard frontend
 * presents. The token is only ever empty in local development — config.js
 * refuses to start a deployed environment without one.
 */
export function requireIngestToken(request, h) {
  const expected = config.get('ingest.token')

  if (!expected) {
    request.logger.warn(
      'INGEST_TOKEN is not set — accepting ingest requests without authentication (local development only)'
    )
    return h.continue
  }

  if (!isTokenValid(request.headers[INGEST_TOKEN_HEADER], expected)) {
    request.logger.warn(
      'Rejected ingest request with a missing or invalid token'
    )
    throw Boom.unauthorized('Invalid ingest token')
  }

  return h.continue
}
