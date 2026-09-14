import Boom from '@hapi/boom'

/**
 * Validation failures must never echo the submitted payload back or into logs.
 * A joi ValidationError carries `_original` (the whole body) plus a
 * `context.value` per detail, and analytics payloads contain contributor
 * identities — so only field paths and joi's type codes are logged, and the
 * caller gets a generic 400.
 */
export function failAction(request, _h, error) {
  const paths = (error?.details ?? []).map((detail) => ({
    path: detail.path?.join('.'),
    type: detail.type
  }))

  request.logger.warn({ validation: { paths } }, 'Request failed validation')

  throw Boom.badRequest('Invalid request input')
}
